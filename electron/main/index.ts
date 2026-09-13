import { app, BrowserWindow, ipcMain } from 'electron';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  detectBrowsers,
  loadConfig,
  paths,
  profiles,
  flowsIndex,
  runs,
  schedules,
  getDb,
} from '../../src/index.js';

const dirname = fileURLToPath(new URL('.', import.meta.url));

/**
 * Prova de vida do processo principal: usa exatamente as mesmas funções que
 * `maestro doctor` na CLI, não um caminho paralelo. Frente 1 é só isso — abrir
 * a janela e provar que ela fala com o núcleo de verdade.
 */
async function getStatus() {
  const config = loadConfig();
  const detected = await detectBrowsers();
  const allProfiles = profiles.list();
  const pending = getDb().prepare(`SELECT COUNT(*) AS n FROM jobs WHERE status = 'pending'`).get() as { n: number };

  return {
    node: process.version,
    electron: process.versions.electron,
    platform: process.platform,
    dataDir: paths.root,
    browsersDetected: detected.map((b) => b.id),
    profiles: { total: allProfiles.length, authenticated: allProfiles.filter((p) => p.status === 'authenticated').length },
    flows: flowsIndex.list().length,
    schedules: schedules.list().length,
    pendingJobs: Number(pending.n),
    recentRuns: runs.list({ limit: 5 }).length,
    defaultHeadless: config.defaultHeadless,
  };
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1100,
    height: 720,
    webPreferences: {
      // Nome real do arquivo gerado por `electron-vite build`/`dev` (conferido
      // no out/) — preload é forçado a CJS (ver electron.vite.config.ts).
      preload: join(dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Encaminha console.* do renderer para o processo principal: sem isso, um
  // erro no renderer (preload não conectou, exceção no React) some no vazio
  // quando não há DevTools abertos — inclusive em builds empacotados.
  window.webContents.on('console-message', (_event, _level, message) => {
    console.log(`[renderer] ${message}`);
  });
  window.webContents.on('did-fail-load', (_event, code, description) => {
    console.error(`[renderer] falha ao carregar: ${description} (${code})`);
  });

  if (process.env['ELECTRON_RENDERER_URL']) {
    void window.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    void window.loadFile(join(dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(() => {
  ipcMain.handle('maestro:getStatus', () => getStatus());

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
