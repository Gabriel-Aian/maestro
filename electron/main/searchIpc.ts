import { BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { SEARCH_ENGINES, SearchFileInvalidError, expandSearches, formatError, loadSearchFile, type SearchFile } from '../../src/index.js';
import { getMaestro } from './maestro.js';
import { loadPrefs, savePrefs } from './prefs.js';
import type { LoadSearchFileResult, RunSearchOptions, RunSearchResult, SearchEngineOption, SearchFileView } from '../shared/ipc.js';

function toView(filePath: string, file: SearchFile): SearchFileView {
  const expanded = expandSearches(file);
  const queryCounts = new Map<string, number>();
  for (const search of expanded) queryCounts.set(search.themeId, (queryCounts.get(search.themeId) ?? 0) + 1);

  return {
    filePath,
    themeCount: file.themes.length,
    totalQueries: expanded.length,
    themes: file.themes.map((t) => ({ id: t.id, name: t.name, enabled: t.enabled, queryCount: queryCounts.get(t.id) ?? 0 })),
  };
}

/**
 * Carrega e valida, devolvendo os problemas campo a campo em vez de só uma
 * mensagem genérica. `filePath` vai também no erro: o usuário edita o
 * arquivo por fora (é assim que o fluxo funciona) e pode introduzir um erro
 * de sintaxe — a tela ainda precisa saber o caminho para oferecer "abrir
 * pasta" e "recarregar" mesmo quando a validação falha.
 */
function tryLoad(filePath: string): LoadSearchFileResult {
  try {
    return { ok: true, file: toView(filePath, loadSearchFile(filePath)) };
  } catch (err) {
    if (err instanceof SearchFileInvalidError) {
      // err.message já embute cada issue como "  • caminho: mensagem" (útil
      // para a CLI, que não tem lista estruturada). A GUI mostra `issues` à
      // parte, então só o cabeçalho da mensagem vai para `reason` — senão
      // cada problema aparece duplicado na tela.
      const reason = err.message.split('\n')[0] ?? err.message;
      return { ok: false, filePath, reason, issues: err.issues };
    }
    return { ok: false, filePath, reason: formatError(err) };
  }
}

export function registerSearchIpcHandlers(): void {
  ipcMain.handle('maestro:search:getLast', (): LoadSearchFileResult | null => {
    const { lastSearchFilePath } = loadPrefs();
    return lastSearchFilePath ? tryLoad(lastSearchFilePath) : null;
  });

  ipcMain.handle('maestro:search:pickFile', async (event): Promise<LoadSearchFileResult | null> => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const dialogOptions: Electron.OpenDialogOptions = {
      title: 'Selecionar arquivo de pesquisas',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    };
    const picked = window ? await dialog.showOpenDialog(window, dialogOptions) : await dialog.showOpenDialog(dialogOptions);
    const filePath = picked.filePaths[0];
    if (picked.canceled || !filePath) return null;

    savePrefs({ lastSearchFilePath: filePath });
    return tryLoad(filePath);
  });

  ipcMain.handle('maestro:search:reload', (_event, filePath: string): LoadSearchFileResult => tryLoad(filePath));

  ipcMain.handle('maestro:search:openFolder', (_event, filePath: string) => {
    shell.showItemInFolder(filePath);
  });

  ipcMain.handle('maestro:search:engines', (): SearchEngineOption[] =>
    Object.values(SEARCH_ENGINES).map((e) => ({ id: e.id, name: e.name })),
  );

  ipcMain.handle('maestro:search:run', (_event, input: { filePath: string } & RunSearchOptions): RunSearchResult => {
    try {
      const jobs = getMaestro().enqueueSearches(input.filePath, {
        themeIds: input.themeIds,
        sampleSize: input.sampleSize,
        engine: input.engine,
        delayRangeMs: input.delayRangeMs,
        forceHeadless: input.headed ? false : undefined,
      });
      return { ok: true, jobIds: jobs.map((j) => j.id) };
    } catch (err) {
      return { ok: false, reason: formatError(err) };
    }
  });
}
