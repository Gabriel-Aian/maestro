import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { BrowserContext } from 'playwright-core';
import { JobQueue, type Job } from './queue/queue.js';
import { BrowserPool, ProfileLockedError } from './browsers/launcher.js';
import { detectBrowsers } from './browsers/detect.js';
import { replayFlow, resolveVariables } from './engine/replay.js';
import { runSearchBatch } from './search/runner.js';
import { loadFlow } from './store/flowStore.js';
import { expandSearches, loadSearchFile } from './search/searchFile.js';
import { flowsIndex, profiles, runs } from './db/index.js';
import { loadConfig } from './config/config.js';
import { logger } from './logger.js';
import type { AppConfig, Profile, ResolvedSearch, RunResult } from './types/schema.js';

export interface FlowJobPayload extends Record<string, unknown> {
  flowId: string;
  variables?: Record<string, string>;
  dryRun?: boolean;
}

export interface SearchJobPayload extends Record<string, unknown> {
  searches: ResolvedSearch[];
  label: string;
}

/**
 * Ponto de composição do núcleo: recebe jobs, resolve o navegador certo para o
 * perfil, executa e persiste o resultado. Toda a política de "quando pode
 * rodar" vive na fila; aqui mora o "como rodar".
 */
export class Maestro {
  readonly queue: JobQueue;
  private readonly pool: BrowserPool;
  private browserPaths = new Map<string, string>();

  constructor(readonly config: AppConfig = loadConfig()) {
    this.pool = new BrowserPool(config.browserIdleTtlMs);
    this.queue = new JobQueue((job, signal) => this.handle(job, signal), {
      maxConcurrent: config.maxConcurrentBrowsers,
      jobTimeoutMs: config.jobTimeoutMs,
      jobDelayMs: config.jobDelayMs,
    });
  }

  async init(): Promise<void> {
    const detected = await detectBrowsers();
    for (const browser of detected) this.browserPaths.set(browser.id, browser.executablePath);
    // Caminhos manuais têm precedência sobre a detecção automática.
    for (const [id, path] of Object.entries(this.config.browserPaths)) this.browserPaths.set(id, path);
    this.queue.start();
  }

  async shutdown(): Promise<void> {
    await this.queue.stop();
    await this.pool.closeAll();
  }

  /** Kill switch (RF-054): mata jobs e navegadores de uma vez. */
  async killAll(): Promise<void> {
    await this.queue.killAll();
    await this.pool.closeAll();
  }

  resolveExecutable(browserId: string): string {
    const path = this.browserPaths.get(browserId);
    if (!path) {
      throw new Error(
        `Navegador "${browserId}" não foi detectado nesta máquina. ` +
          `Cadastre o caminho manualmente com "maestro browser add ${browserId} <caminho>".`,
      );
    }
    return path;
  }

  /* ─────────────────────────  ENFILEIRAMENTO  ───────────────────────── */

  enqueueFlow(flowId: string, profileName: string, opts: { headless?: boolean; variables?: Record<string, string>; priority?: number } = {}): Job {
    const profile = this.requireProfile(profileName);
    const flow = loadFlow(flowId);

    // Falha de variável acontece antes de qualquer navegador abrir (RN-015).
    resolveVariables(flow, opts.variables ?? {});

    return this.queue.enqueue({
      kind: 'flow',
      payload: { flowId, variables: opts.variables ?? {} } satisfies FlowJobPayload,
      profileId: profile.id,
      headless: opts.headless ?? this.config.defaultHeadless,
      priority: opts.priority ?? 0,
    });
  }

  /**
   * Enfileira pesquisas agrupando por perfil. Cada grupo vira um job, o que faz
   * a fila naturalmente serializar por conta e paralelizar entre contas
   * (RF-050) — exatamente o comportamento "primeiro conta 1, depois conta 2".
   */
  enqueueSearches(searchFilePath: string, opts: { themeIds?: string[]; priority?: number } = {}): Job[] {
    const file = loadSearchFile(searchFilePath);
    const searches = expandSearches(file, { themeIds: opts.themeIds });

    if (searches.length === 0) {
      throw new Error('Nenhuma pesquisa ativa encontrada. Verifique se os temas estão habilitados (RN-009).');
    }

    const byProfile = new Map<string, ResolvedSearch[]>();
    for (const search of searches) {
      const list = byProfile.get(search.profile) ?? [];
      list.push(search);
      byProfile.set(search.profile, list);
    }

    const jobs: Job[] = [];
    for (const [profileName, group] of byProfile) {
      const profile = this.requireProfile(profileName);
      jobs.push(
        this.queue.enqueue({
          kind: 'search',
          payload: { searches: group, label: `${group.length} pesquisas` } satisfies SearchJobPayload,
          profileId: profile.id,
          headless: group[0]?.headless ?? this.config.defaultHeadless,
          priority: opts.priority ?? 0,
        }),
      );
    }

    logger.info({ jobs: jobs.length, searches: searches.length }, 'Pesquisas enfileiradas');
    return jobs;
  }

  private requireProfile(nameOrId: string): Profile {
    const profile = profiles.find(nameOrId);
    if (!profile) {
      throw new Error(`Perfil "${nameOrId}" não existe. Crie com "maestro profile add".`);
    }
    // Perfil com sessão expirada fica congelado até reautenticação (RN-004).
    if (profile.status === 'session_expired') {
      throw new Error(
        `O perfil "${profile.name}" está com sessão expirada e não aceita novos jobs. ` +
          `Rode "maestro profile auth ${profile.name}" para reautenticar (RN-004).`,
      );
    }
    return profile;
  }

  /* ─────────────────────────  EXECUÇÃO  ───────────────────────── */

  private async handle(job: Job, signal: AbortSignal): Promise<RunResult> {
    const profile = profiles.find(job.profileId);
    if (!profile) throw new Error(`Perfil ${job.profileId} desapareceu antes da execução.`);

    const executablePath = this.resolveExecutable(profile.browserId);
    const runId = `run-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 6)}`;

    let context: BrowserContext;
    try {
      context = await this.pool.acquire({
        profile,
        executablePath,
        headless: job.headless,
        viewport: this.config.defaultViewport,
      });
    } catch (err) {
      if (err instanceof ProfileLockedError) {
        // Perfil travado não é falha recuperável por retry (RN-002).
        logger.error({ profile: profile.name }, 'Perfil em uso por outra instância');
      }
      throw err;
    }

    profiles.touch(profile.id);

    try {
      const result =
        job.kind === 'flow'
          ? await this.runFlowJob(job, context, runId)
          : await runSearchBatch({
              searches: (job.payload as SearchJobPayload).searches,
              context,
              config: this.config,
              runId,
              signal,
            });

      this.recordOutcome(job, profile, result);
      return result;
    } finally {
      this.pool.release(profile.id, job.headless);
    }
  }

  private async runFlowJob(job: Job, context: BrowserContext, runId: string): Promise<RunResult> {
    const payload = job.payload as FlowJobPayload;
    const flow = loadFlow(payload.flowId);

    const result = await replayFlow({
      flow,
      context,
      config: this.config,
      variables: payload.variables,
      runId,
      dryRun: Boolean(payload.dryRun),
    });

    // Fallback usado em qualquer passo marca o fluxo para revisão (RN-006).
    if (result.degraded) flowsIndex.markReview(flow.id, true);
    flowsIndex.setLastRun(flow.id, result.runId, result.status);

    return result;
  }

  private recordOutcome(job: Job, profile: Profile, result: RunResult): void {
    const targetName =
      job.kind === 'flow' ? String((job.payload as FlowJobPayload).flowId) : String((job.payload as SearchJobPayload).label);

    runs.save(result, {
      targetId: job.kind === 'flow' ? (job.payload as FlowJobPayload).flowId : undefined,
      targetName,
      profileId: profile.id,
    });

    // Bloqueio congela o perfil: sem isso, os jobs seguintes só reforçariam a
    // detecção contra a mesma conta (RN-004).
    if (result.status === 'blocked') {
      profiles.setStatus(profile.id, 'session_expired');
      logger.warn({ profile: profile.name, reason: result.blockReason }, 'Perfil congelado após bloqueio');
    }
  }

  /* ─────────────────────────  RETENÇÃO  ───────────────────────── */

  /** Limpeza de artefatos expirados (RF-072, RN-010, RN-011). */
  cleanupArtifacts(): { removed: number } {
    const { maxAgeDays, maxRuns, failureMultiplier } = this.config.retention;
    const expired = runs.expired(maxAgeDays, maxRuns, failureMultiplier);

    let removed = 0;
    for (const entry of expired) {
      try {
        if (entry.dir) rmSync(entry.dir, { recursive: true, force: true });
        runs.remove(entry.id);
        removed += 1;
      } catch (err) {
        logger.warn({ runId: entry.id, err }, 'Falha ao remover artefatos');
      }
    }

    if (removed > 0) logger.info({ removed }, 'Artefatos expirados removidos');
    return { removed };
  }
}
