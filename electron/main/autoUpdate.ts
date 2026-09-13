import { app, BrowserWindow, ipcMain } from 'electron';
// `electron-updater` é CommonJS e não expõe `autoUpdater` como named export
// ESM de verdade (o analisador estático do bundler não enxerga através do
// `module.exports` dele) — confirmado ao vivo neste ambiente via Xvfb: com
// `import { autoUpdater }` a janela nem chega a abrir, falha na hora com
// "Named export 'autoUpdater' not found". Import default + destructuring é
// a forma que o próprio erro do Node recomenda e que funciona de verdade.
import electronUpdater from 'electron-updater';
import { formatError } from '../../src/index.js';

const { autoUpdater } = electronUpdater;
import { UPDATE_EVENT_CHANNEL, type UpdateStatus } from '../shared/ipc.js';

/**
 * Auto-update via `electron-updater`, apontando para as Releases públicas do
 * GitHub `Gabriel-Aian/maestro` (ver `electron-builder.yml`, decisão
 * explícita do usuário pelo canal público — sem certificado de assinatura
 * de código, um canal privado exigiria embutir um token de leitura dentro
 * do próprio instalador distribuído).
 *
 * Duas decisões deliberadas:
 *  - `autoDownload = true`: baixar em segundo plano não interfere em nenhuma
 *    automação em andamento, só usa banda — menos um clique manual.
 *  - `autoInstallOnAppQuit = false`: instalar reinicia o processo inteiro, o
 *    que mataria qualquer fluxo/pesquisa em execução (a `BrowserPool` vive
 *    neste mesmo processo, ver `electron/main/maestro.ts`) — só instala
 *    quando o usuário confirma explicitamente pela tela de Configurações,
 *    nunca sozinho ao fechar a janela por outro motivo.
 *
 * IMPORTANTE: isto NÃO elimina o passo de build+publish de uma atualização
 * — alguém ainda precisa rodar `npm run package:win:publish` (com `GH_TOKEN`
 * no ambiente) a cada versão nova para gerar e publicar o instalador na
 * Release do GitHub. O que isso elimina é só o usuário final ter que baixar
 * e reinstalar manualmente. Ver "Auto-update" no CLAUDE.md.
 */
let status: UpdateStatus = { state: 'idle' };
let pendingVersion: string | null = null;

function setStatus(next: UpdateStatus): void {
  status = next;
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(UPDATE_EVENT_CHANNEL, next);
  }
}

/** `electron-updater` não tem o que checar fora de um build empacotado de verdade (sem `app-update.yml`). */
function unsupportedInDev(): UpdateStatus {
  return { state: 'unsupported', reason: 'Atualização automática só funciona no app empacotado (instalado via .exe) — não neste ambiente de desenvolvimento.' };
}

async function checkNow(): Promise<UpdateStatus> {
  if (!app.isPackaged) {
    setStatus(unsupportedInDev());
    return status;
  }
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    setStatus({ state: 'error', message: formatError(err) });
  }
  return status;
}

export function registerAutoUpdateIpcHandlers(): void {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('checking-for-update', () => setStatus({ state: 'checking' }));
  autoUpdater.on('update-available', (info) => {
    pendingVersion = info.version;
    setStatus({ state: 'available', version: info.version });
  });
  autoUpdater.on('update-not-available', () => setStatus({ state: 'not-available' }));
  autoUpdater.on('download-progress', (progress) => {
    setStatus({ state: 'downloading', version: pendingVersion ?? '', percent: Math.round(progress.percent) });
  });
  autoUpdater.on('update-downloaded', (info) => {
    pendingVersion = info.version;
    setStatus({ state: 'downloaded', version: info.version });
  });
  autoUpdater.on('error', (err) => setStatus({ state: 'error', message: formatError(err) }));

  ipcMain.handle('maestro:updates:check', (): Promise<UpdateStatus> => checkNow());
  ipcMain.handle('maestro:updates:status', (): UpdateStatus => (app.isPackaged ? status : unsupportedInDev()));
  ipcMain.handle('maestro:updates:install', (): void => {
    // Segue o mesmo ciclo de `before-quit` de sempre (electron/main/index.ts)
    // — `quitAndInstall()` dispara o `app.quit()` normal, que já deixa a
    // fila terminar e fecha os navegadores antes de sair.
    autoUpdater.quitAndInstall();
  });
}

/**
 * Primeira checagem alguns segundos após abrir (não competir com o
 * carregamento inicial da janela), depois a cada 4 horas. Silenciosa: só
 * baixa e atualiza `status`, nunca interrompe o usuário — a tela de
 * Configurações mostra o resultado quando ele olhar.
 */
export function scheduleAutoUpdateChecks(): void {
  if (!app.isPackaged) return;
  setTimeout(() => void checkNow(), 10_000);
  setInterval(() => void checkNow(), 4 * 60 * 60 * 1000);
}
