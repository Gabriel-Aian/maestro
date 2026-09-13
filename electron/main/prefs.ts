import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../../src/index.js';

/**
 * Preferências da casca (não do núcleo): coisas como "último arquivo de
 * pesquisas selecionado" não fazem sentido em `AppConfig` — a CLI não tem
 * esse conceito, é puramente de conveniência da GUI. Fica num arquivo à
 * parte no mesmo diretório de dados, não dentro de `config.json`.
 */
export interface GuiPrefs {
  lastSearchFilePath?: string;
}

const prefsPath = join(paths.root, 'gui-prefs.json');

export function loadPrefs(): GuiPrefs {
  if (!existsSync(prefsPath)) return {};
  try {
    return JSON.parse(readFileSync(prefsPath, 'utf8')) as GuiPrefs;
  } catch {
    return {};
  }
}

export function savePrefs(patch: Partial<GuiPrefs>): GuiPrefs {
  const merged = { ...loadPrefs(), ...patch };
  writeFileSync(prefsPath, JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}
