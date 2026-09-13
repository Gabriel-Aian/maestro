import { BrowserWindow, ipcMain } from 'electron';
import { randomUUID } from 'node:crypto';
import {
  ProfileSchema,
  detectBrowsers,
  formatError,
  isProfileLocked,
  loadConfig,
  openProfilePlain,
  paths,
  profiles,
  validateBrowserPath,
  type Profile,
} from '../../src/index.js';
import { getMaestro } from './maestro.js';
import { closeLoginWidget, openLoginWidget } from './loginWidget.js';
import { PROFILES_EVENT_CHANNEL, type ActionResult, type AddProfileResult, type BrowserView, type LoginCheckResult, type ProfileView } from '../shared/ipc.js';

/**
 * Navegadores conhecidos mesmo antes de detectados: aparecem na lista como
 * "não encontrado" com uma forma de registrar o caminho manualmente, em vez
 * de simplesmente não existirem até alguém digitar o id certo.
 */
const KNOWN_BROWSERS: ReadonlyArray<{ id: string; name: string }> = [
  { id: 'brave', name: 'Brave' },
  { id: 'chrome', name: 'Google Chrome' },
  { id: 'edge', name: 'Microsoft Edge' },
];

async function listBrowserViews(): Promise<BrowserView[]> {
  const detected = await detectBrowsers();
  const config = loadConfig();

  const ids = new Set<string>([...KNOWN_BROWSERS.map((b) => b.id), ...detected.map((b) => b.id), ...Object.keys(config.browserPaths)]);

  return [...ids].map((id) => {
    const found = detected.find((b) => b.id === id);
    const manualPath = config.browserPaths[id];
    const known = KNOWN_BROWSERS.find((b) => b.id === id);
    return {
      id,
      name: found?.name ?? known?.name ?? id,
      executablePath: found?.executablePath ?? manualPath ?? null,
      source: found?.source ?? (manualPath ? 'manual' : 'none'),
    };
  });
}

function toProfileView(p: Profile): ProfileView {
  return {
    id: p.id,
    name: p.name,
    browserId: p.browserId,
    status: p.status,
    locked: isProfileLocked(p.userDataDir),
    lastUsedAt: p.lastUsedAt,
    createdAt: p.createdAt,
  };
}

export function registerProfileIpcHandlers(): void {
  ipcMain.handle('maestro:browsers:list', () => listBrowserViews());

  ipcMain.handle('maestro:browsers:addPath', async (_event, input: { id: string; path: string }): Promise<ActionResult> => {
    const validation = validateBrowserPath(input.path);
    if (!validation.ok) return { ok: false, reason: validation.reason };

    // Passa por Maestro.updateConfig() (não loadConfig()/saveConfig() direto)
    // para o caminho novo valer JÁ na instância rodando, sem reiniciar o app
    // — antes disso, um perfil só conseguia usar o navegador recém-cadastrado
    // depois de fechar e reabrir a janela.
    const maestro = getMaestro();
    await maestro.updateConfig({ ...maestro.config, browserPaths: { ...maestro.config.browserPaths, [input.id]: input.path } });
    return { ok: true };
  });

  ipcMain.handle('maestro:profiles:list', (): ProfileView[] => profiles.list().map(toProfileView));

  ipcMain.handle('maestro:profiles:add', (_event, input: { name: string; browserId: string }): AddProfileResult => {
    const name = input.name.trim();
    if (!name) return { ok: false, reason: 'Dê um nome ao perfil.' };
    if (profiles.find(name)) return { ok: false, reason: `Já existe um perfil chamado "${name}".` };

    const id = `prof-${randomUUID().slice(0, 8)}`;
    const created = ProfileSchema.parse({
      id,
      name,
      browserId: input.browserId,
      userDataDir: paths.profileDir(id),
      status: 'never_authenticated',
      lastUsedAt: null,
      createdAt: new Date().toISOString(),
    });

    profiles.insert(created);
    return { ok: true, profile: toProfileView(created) };
  });

  ipcMain.handle('maestro:profiles:remove', (_event, id: string) => {
    profiles.remove(id);
  });

  ipcMain.handle('maestro:login:start', (_event, input: { profileId: string; url: string }): ActionResult => {
    const profile = profiles.find(input.profileId);
    if (!profile) return { ok: false, reason: 'Perfil não encontrado.' };

    try {
      openProfilePlain({
        executablePath: getMaestro().resolveExecutable(profile.browserId),
        userDataDir: profile.userDataDir,
        url: input.url,
      });
    } catch (err) {
      return { ok: false, reason: formatError(err) };
    }

    openLoginWidget(profile.id, profile.name);
    return { ok: true };
  });

  ipcMain.handle('maestro:login:check', (_event, profileId: string): LoginCheckResult => {
    const profile = profiles.find(profileId);
    return { locked: profile ? isProfileLocked(profile.userDataDir) : false };
  });

  ipcMain.handle('maestro:login:complete', (_event, profileId: string): ActionResult => {
    const profile = profiles.find(profileId);
    if (!profile) return { ok: false, reason: 'Perfil não encontrado.' };

    // Mesma checagem da CLI (`profile login`): sem isso, marcar "autenticado"
    // com o navegador ainda aberto arrisca uma segunda instância mais tarde
    // encontrar o perfil travado (RN-001/RN-002).
    if (isProfileLocked(profile.userDataDir)) {
      return { ok: false, reason: 'O navegador ainda está aberto. Feche a janela por completo e tente de novo.' };
    }

    profiles.setStatus(profile.id, 'authenticated');
    closeLoginWidget(profile.id);

    // O widget é uma janela separada da tela de Perfis: sem isso, quem
    // completou o login por lá só veria o status novo depois de um refresh.
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(PROFILES_EVENT_CHANNEL, { type: 'login-completed', profileId: profile.id });
    }

    return { ok: true };
  });
}
