import { chromium, type BrowserContext } from 'playwright-core';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readlinkSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { hostname, platform } from 'node:os';
import { logger } from '../logger.js';
import type { Profile } from '../types/schema.js';

export class ProfileLockedError extends Error {
  readonly code = 'profile_in_use';
  constructor(profileName: string) {
    super(
      `O perfil "${profileName}" está em uso por outra instância do navegador. ` +
        `Feche essa janela e tente de novo, ou use um perfil de automação dedicado (RN-002).`,
    );
    this.name = 'ProfileLockedError';
  }
}

export class ProfileNotAuthenticatedError extends Error {
  readonly code = 'profile_never_authenticated';
  constructor(profileName: string) {
    super(
      `O perfil "${profileName}" nunca foi autenticado e não pode rodar em modo headless. ` +
        `Execute "maestro profile auth ${profileName}" primeiro (RN-003).`,
    );
    this.name = 'ProfileNotAuthenticatedError';
  }
}

/**
 * Detecta se o diretório de perfil está travado por um navegador aberto (RF-008).
 *
 * Windows: o Chromium mantém `lockfile` aberto com compartilhamento negado.
 * Renomear o arquivo para ele mesmo é atômico e falha com EBUSY/EPERM se houver
 * handle ativo — é a checagem mais barata sem chamar a API Win32 diretamente.
 *
 * POSIX: `SingletonLock` é um symlink cujo alvo é "hostname-pid". Basta ver se
 * o processo ainda existe; se não existir, é resíduo de crash e pode ser ignorado.
 */
export function isProfileLocked(userDataDir: string): boolean {
  if (!existsSync(userDataDir)) return false;

  if (platform() === 'win32') {
    const lockfile = join(userDataDir, 'lockfile');
    if (!existsSync(lockfile)) return false;
    try {
      renameSync(lockfile, lockfile);
      return false;
    } catch {
      return true;
    }
  }

  const singleton = join(userDataDir, 'SingletonLock');
  if (!existsSync(singleton)) return false;
  try {
    const target = readlinkSync(singleton); // "host-12345"
    const pid = Number(target.split('-').pop());
    if (!Number.isInteger(pid) || pid <= 0) return false;
    if (!target.startsWith(hostname())) return true; // outro host, assume travado
    process.kill(pid, 0); // lança se o processo não existir
    return true;
  } catch {
    return false;
  }
}

export interface LaunchOptions {
  profile: Profile;
  executablePath: string;
  headless: boolean;
  viewport: { width: number; height: number };
  /** Ignora a checagem de autenticação — usado pelo próprio fluxo de login manual. */
  allowUnauthenticated?: boolean;
}

/**
 * Argumentos de linha de comando aplicados a todo lançamento.
 * A porta de depuração é vinculada explicitamente a 127.0.0.1 para não expor
 * controle do navegador na rede local (RNF-004).
 */
function baseArgs(): string[] {
  return [
    '--remote-debugging-address=127.0.0.1',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=TranslateUI,MediaRouter,OptimizationHints',
    '--password-store=basic',
  ];
}

/**
 * Abre um contexto persistente vinculado ao diretório de perfil da conta.
 * Contexto persistente é o que preserva cookies e sessão entre execuções, o que
 * torna desnecessário armazenar senha em qualquer lugar (RNF-001, RNF-003).
 */
export async function launchProfile(opts: LaunchOptions): Promise<BrowserContext> {
  const { profile, executablePath, headless, viewport } = opts;

  if (!opts.allowUnauthenticated && headless && profile.status === 'never_authenticated') {
    throw new ProfileNotAuthenticatedError(profile.name);
  }

  mkdirSync(profile.userDataDir, { recursive: true });

  if (isProfileLocked(profile.userDataDir)) {
    throw new ProfileLockedError(profile.name);
  }

  logger.debug({ profile: profile.id, headless, executablePath }, 'Abrindo contexto persistente');

  const context = await chromium.launchPersistentContext(profile.userDataDir, {
    executablePath,
    headless,
    viewport,
    args: baseArgs(),
    // O Playwright desliga o sandbox do Chromium por padrão, o que faz o
    // navegador exibir a faixa de "sinalizador sem suporte" e reduz o
    // isolamento de processos. Como aqui o navegador é o do próprio usuário,
    // com a sessão real dele, manter o sandbox ligado é o certo.
    chromiumSandbox: true,
    ignoreDefaultArgs: ['--enable-automation'],
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
  });

  return context;
}

/**
 * Abre o navegador de forma COMUM, sem automação, apontando para o diretório de
 * perfil do Maestro.
 *
 * Provedores de identidade (Google, Microsoft e outros) recusam autenticação
 * quando detectam que o navegador está sob controle de automação — é uma
 * proteção contra ferramentas de acesso automatizado a contas. A resposta certa
 * não é disfarçar a automação, e sim não automatizar o login: aqui o processo é
 * lançado direto pelo sistema operacional, sem CDP, sem porta de depuração e sem
 * nenhum sinalizador de automação. É o mesmo navegador que o usuário abriria
 * pelo menu Iniciar, apenas com outro diretório de dados.
 *
 * A sessão resultante fica no perfil e é reaproveitada pelas execuções
 * seguintes, sem que nenhuma senha precise ser armazenada.
 */
export function openProfilePlain(opts: { executablePath: string; userDataDir: string; url?: string }): void {
  mkdirSync(opts.userDataDir, { recursive: true });

  if (isProfileLocked(opts.userDataDir)) {
    throw new Error('O perfil já está aberto em outra janela. Feche-a antes de continuar.');
  }

  const args = [`--user-data-dir=${opts.userDataDir}`, '--no-first-run', '--no-default-browser-check'];
  if (opts.url) args.push(opts.url);

  const child = spawn(opts.executablePath, args, { detached: true, stdio: 'ignore' });
  child.unref();

  logger.info({ userDataDir: opts.userDataDir }, 'Navegador aberto em modo comum para login manual');
}

/* ─────────────────────────  POOL DE REAPROVEITAMENTO  ───────────────────────── */

interface PooledEntry {
  context: BrowserContext;
  key: string;
  idleTimer: NodeJS.Timeout | null;
}

/**
 * Mantém contextos vivos entre jobs consecutivos do mesmo perfil (RF-055).
 * O cold start do Chromium custa segundos; reaproveitar derruba isso a zero em
 * lotes de pesquisa, que é o caso de uso com maior número de jobs curtos.
 */
export class BrowserPool {
  private readonly entries = new Map<string, PooledEntry>();

  constructor(private readonly idleTtlMs: number) {}

  private static key(profileId: string, headless: boolean): string {
    return `${profileId}:${headless ? 'headless' : 'headed'}`;
  }

  async acquire(opts: LaunchOptions): Promise<BrowserContext> {
    const key = BrowserPool.key(opts.profile.id, opts.headless);
    const existing = this.entries.get(key);

    if (existing) {
      if (existing.idleTimer) clearTimeout(existing.idleTimer);
      existing.idleTimer = null;
      logger.debug({ key }, 'Contexto reaproveitado do pool');
      return existing.context;
    }

    const context = await launchProfile(opts);
    const entry: PooledEntry = { context, key, idleTimer: null };
    this.entries.set(key, entry);

    context.on('close', () => this.entries.delete(key));
    return context;
  }

  /** Devolve o contexto ao pool, agendando o encerramento por ociosidade. */
  release(profileId: string, headless: boolean): void {
    const key = BrowserPool.key(profileId, headless);
    const entry = this.entries.get(key);
    if (!entry) return;

    if (this.idleTtlMs <= 0) {
      void this.closeEntry(entry);
      return;
    }

    entry.idleTimer = setTimeout(() => void this.closeEntry(entry), this.idleTtlMs);
    entry.idleTimer.unref?.();
  }

  private async closeEntry(entry: PooledEntry): Promise<void> {
    this.entries.delete(entry.key);
    try {
      await entry.context.close();
      logger.debug({ key: entry.key }, 'Contexto encerrado por ociosidade');
    } catch (err) {
      logger.warn({ key: entry.key, err }, 'Falha ao encerrar contexto ocioso');
    }
  }

  /** Kill switch: encerra tudo imediatamente (RF-054, RNF-015). */
  async closeAll(): Promise<void> {
    const all = [...this.entries.values()];
    this.entries.clear();
    await Promise.allSettled(
      all.map(async (entry) => {
        if (entry.idleTimer) clearTimeout(entry.idleTimer);
        await entry.context.close();
      }),
    );
    logger.info({ closed: all.length }, 'Pool de navegadores esvaziado');
  }

  get size(): number {
    return this.entries.size;
  }
}
