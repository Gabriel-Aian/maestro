import { ipcMain } from 'electron';
import { AppConfigSchema, formatError, type AppConfig } from '../../src/index.js';
import { getMaestro } from './maestro.js';
import type { AppConfigView, UpdateConfigResult } from '../shared/ipc.js';

function toView(config: AppConfig): AppConfigView {
  return {
    defaultHeadless: config.defaultHeadless,
    defaultTimeoutMs: config.defaultTimeoutMs,
    defaultMaxRetries: config.defaultMaxRetries,
    defaultViewport: { ...config.defaultViewport },
    maxConcurrentBrowsers: config.maxConcurrentBrowsers,
    jobTimeoutMs: config.jobTimeoutMs,
    browserIdleTtlMs: config.browserIdleTtlMs,
    defaultStepDelayMs: [...config.defaultStepDelayMs],
    jobDelayMs: [...config.jobDelayMs],
    retention: { ...config.retention },
    captureTrace: config.captureTrace,
    detectLoginWall: config.detectLoginWall,
  };
}

export function registerSettingsIpcHandlers(): void {
  ipcMain.handle('maestro:config:get', (): AppConfigView => toView(getMaestro().config));

  // Os defaults vêm do próprio schema (AppConfigSchema.parse({})), não
  // duplicados aqui à mão — evita a tela e o núcleo divergirem se um default
  // mudar em types/schema.ts.
  ipcMain.handle('maestro:config:defaults', (): AppConfigView => toView(AppConfigSchema.parse({})));

  // `AppConfigView` só cobre os campos editáveis na tela — sobrepor em cima
  // do `config` atual (que também tem `schemaVersion`/`browserPaths`)
  // reconstitui um `AppConfig` completo sem precisar de merge parcial de
  // campos aninhados (`retention`, `defaultViewport`): a tela sempre manda o
  // objeto inteiro de cada seção, nunca um fragmento.
  ipcMain.handle('maestro:config:update', async (_event, next: AppConfigView): Promise<UpdateConfigResult> => {
    try {
      const maestro = getMaestro();
      const updated = await maestro.updateConfig({ ...maestro.config, ...next });
      return { ok: true, config: toView(updated) };
    } catch (err) {
      return { ok: false, reason: formatError(err) };
    }
  });
}
