import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

/**
 * Raiz de dados da aplicação. No Windows segue %APPDATA%/Maestro conforme o
 * documento de requisitos; nos outros SOs usa um equivalente para permitir
 * desenvolvimento e testes fora do alvo (o alvo de produção é Windows — R-01).
 */
function resolveRoot(): string {
  if (process.env.MAESTRO_HOME) return process.env.MAESTRO_HOME;
  if (platform() === 'win32') {
    return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Maestro');
  }
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'maestro');
}

export const ROOT = resolveRoot();

export const paths = {
  root: ROOT,
  db: join(ROOT, 'maestro.db'),
  config: join(ROOT, 'config.json'),
  searches: join(ROOT, 'searches.json'),
  flows: join(ROOT, 'flows'),
  profiles: join(ROOT, 'profiles'),
  runs: join(ROOT, 'runs'),
  logs: join(ROOT, 'logs'),
  flowFile: (id: string) => join(ROOT, 'flows', `${id}.json`),
  flowVersionsDir: (id: string) => join(ROOT, 'flows', id),
  profileDir: (id: string) => join(ROOT, 'profiles', id),
  runDir: (runId: string) => join(ROOT, 'runs', runId),
} as const;

/** Cria a árvore de diretórios de dados. Idempotente. */
export function ensureDataDirs(): void {
  for (const dir of [paths.root, paths.flows, paths.profiles, paths.runs, paths.logs]) {
    mkdirSync(dir, { recursive: true });
  }
}
