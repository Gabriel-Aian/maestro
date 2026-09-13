import { app, BrowserWindow } from 'electron';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initMaestro, shutdownMaestro } from './maestro.js';
import { registerIpcHandlers } from './ipc.js';
import { registerProfileIpcHandlers } from './profilesIpc.js';
import { registerFlowIpcHandlers } from './flowsIpc.js';
import { registerSearchIpcHandlers } from './searchIpc.js';

const dirname = fileURLToPath(new URL('.', import.meta.url));

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 860,
    minHeight: 560,
    backgroundColor: '#f5f5f4',
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

app.whenReady().then(async () => {
  // Uma só instância do núcleo para a vida inteira do app — ver
  // electron/main/maestro.ts para o porquê de isso não ser "por comando"
  // como na CLI.
  await initMaestro();
  registerIpcHandlers();
  registerProfileIpcHandlers();
  registerFlowIpcHandlers();
  registerSearchIpcHandlers();

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Deixa a fila terminar os jobs em andamento e fecha os navegadores antes de
// sair — sem isso, fechar a janela abandonaria contextos de perfil abertos.
app.on('before-quit', (event) => {
  event.preventDefault();
  shutdownMaestro()
    .catch((err: unknown) => console.error('Falha ao desligar o núcleo:', err))
    .finally(() => app.exit());
});
