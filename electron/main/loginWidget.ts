import { BrowserWindow, screen } from 'electron';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = fileURLToPath(new URL('.', import.meta.url));

const WIDGET_WIDTH = 272;
const WIDGET_HEIGHT = 96;
const MARGIN = 16;
const GAP = 10;

/**
 * Um widget por perfil em login. Empilhados a partir do canto inferior
 * direito — mais de um login simultâneo (perfis diferentes) é um caso real,
 * não hipotético: nada nas outras telas impede iniciar dois.
 */
const widgets = new Map<string, BrowserWindow>();

/** Abre (ou foca, se já existir) o widget flutuante de confirmação de login. */
export function openLoginWidget(profileId: string, profileName: string): void {
  const existing = widgets.get(profileId);
  if (existing && !existing.isDestroyed()) {
    existing.focus();
    return;
  }

  const area = screen.getPrimaryDisplay().workArea;
  const stackOffset = widgets.size * (WIDGET_HEIGHT + GAP);

  const window = new BrowserWindow({
    width: WIDGET_WIDTH,
    height: WIDGET_HEIGHT,
    x: Math.round(area.x + area.width - WIDGET_WIDTH - MARGIN),
    y: Math.round(area.y + area.height - WIDGET_HEIGHT - MARGIN - stackOffset),
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      preload: join(dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const hash = `/login-widget?profileId=${encodeURIComponent(profileId)}&name=${encodeURIComponent(profileName)}`;
  if (process.env['ELECTRON_RENDERER_URL']) {
    void window.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#${hash}`);
  } else {
    void window.loadFile(join(dirname, '../renderer/index.html'), { hash });
  }

  widgets.set(profileId, window);
  window.on('closed', () => widgets.delete(profileId));
}

/** Fecha o widget de um perfil, se houver — chamado após login concluído com sucesso. */
export function closeLoginWidget(profileId: string): void {
  const window = widgets.get(profileId);
  if (window && !window.isDestroyed()) window.close();
}
