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
import { flowsIndex, profiles, runs, schedules } from './db/index.js';
import { loadConfig, saveConfig } from './config/config.js';
import { logger } from './logger.js';
import { AppConfigSchema, type AppConfig, type Profile, type ResolvedSearch, type RunResult, type Schedule } from './types/schema.js';

export interface FlowJobPayload extends Record<string, unknown> {
  flowId: string;
  variables?: Record<string, string>;
  dryRun?: boolean;
  /** Presente quando o job veio de um agendamento — alimenta o `lastStatus` dele. */
  scheduleId?: string;
}

export interface SearchJobPayload extends Record<string, unknown> {
  searches: ResolvedSearch[];
  label: string;
  scheduleId?: string;
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
    await this.refreshBrowserPaths();
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

  private async refreshBrowserPaths(): Promise<void> {
    const detected = await detectBrowsers();
    this.browserPaths.clear();
    for (const browser of detected) this.browserPaths.set(browser.id, browser.executablePath);
    // Caminhos manuais têm precedência sobre a detecção automática.
    for (const [id, path] of Object.entries(this.config.browserPaths)) this.browserPaths.set(id, path);
  }

  /**
   * Atualiza a configuração em disco E em memória, para uma instância de
   * `Maestro` de vida longa (a da GUI) refletir a mudança sem reiniciar.
   * `this.config` é MUTADO no próprio objeto, não substituído por um novo —
   * é assim (por referência) que `enqueueFlow`/`handle`/`cleanupArtifacts`
   * etc. leem `this.config.X` "ao vivo" a cada chamada. As exceções são
   * `maxConcurrentBrowsers`/`jobTimeoutMs`/`jobDelayMs` (congelados dentro de
   * `JobQueue` na construção) e `browserIdleTtlMs` (congelado em
   * `BrowserPool`) — persistem em disco normalmente, mas só valem de fato
   * depois de reiniciar o app; quem chama isso precisa avisar o usuário.
   */
  async updateConfig(next: AppConfig): Promise<AppConfig> {
    const parsed = AppConfigSchema.parse(next);
    saveConfig(parsed);
    Object.assign(this.config, parsed);
    await this.refreshBrowserPaths();
    return this.config;
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

  enqueueFlow(
    flowId: string,
    profileName: string,
    opts: { headless?: boolean; variables?: Record<string, string>; priority?: number; scheduleId?: string } = {},
  ): Job {
    const profile = this.requireProfile(profileName);
    const flow = loadFlow(flowId);

    // Falha de variável acontece antes de qualquer navegador abrir (RN-015).
    resolveVariables(flow, opts.variables ?? {});

    return this.queue.enqueue({
      kind: 'flow',
      payload: { flowId, variables: opts.variables ?? {}, scheduleId: opts.scheduleId } satisfies FlowJobPayload,
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
  enqueueSearches(
    searchFilePath: string,
    opts: { themeIds?: string[]; priority?: number; forceHeadless?: boolean; scheduleId?: string } = {},
  ): Job[] {
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

    // Resolve TODOS os perfis antes de enfileirar qualquer job — mesmo
    // princípio de RN-015: um perfil inválido no meio do lote não pode deixar
    // os anteriores já enfileirados (efeito colateral parcial e silencioso).
    const resolvedProfiles = new Map(
      [...byProfile.keys()].map((profileName) => [profileName, this.requireProfile(profileName)] as const),
    );

    const jobs: Job[] = [];
    for (const [profileName, group] of byProfile) {
      const profile = resolvedProfiles.get(profileName)!;
      jobs.push(
        this.queue.enqueue({
          kind: 'search',
          payload: { searches: group, label: `${group.length} pesquisas`, scheduleId: opts.scheduleId } satisfies SearchJobPayload,
          profileId: profile.id,
          headless: opts.forceHeadless ?? group[0]?.headless ?? this.config.defaultHeadless,
          priority: opts.priority ?? 0,
        }),
      );
    }

    logger.info({ jobs: jobs.length, searches: searches.length }, 'Pesquisas enfileiradas');
    return jobs;
  }

  /**
   * Dispara um agendamento: só traduz `Schedule` para uma chamada de
   * `enqueueFlow`/`enqueueSearches` — nenhum caminho de execução novo. Sempre
   * headless (RN-007): a sessão do Windows pode estar bloqueada quando o
   * disparo acontece, e automação visível não funciona nesse cenário.
   */
  enqueueSchedule(schedule: Schedule): Job[] {
    if (schedule.target.kind === 'flow') {
      return [
        this.enqueueFlow(schedule.target.flowId, schedule.target.profile, {
          headless: true,
          variables: schedule.target.variables,
          scheduleId: schedule.id,
        }),
      ];
    }

    return this.enqueueSearches(schedule.target.searchFile, {
      themeIds: schedule.target.themeIds,
      forceHeadless: true,
      scheduleId: schedule.id,
    });
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
    try {
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
    } catch (err) {
      // Um job de agendamento pode lançar antes de produzir um RunResult
      // (perfil travado, navegador não detectado, timeout) — nesses casos
      // `recordOutcome` nunca roda, e sem isto aqui o agendamento ficaria
      // marcado como "nunca rodou" para sempre, mesmo disparando (e
      // falhando) a cada tick, sem forma de o usuário perceber.
      this.recordScheduleFailure(job, signal);
      throw err;
    }
  }

  private recordScheduleFailure(job: Job, signal: AbortSignal): void {
    const scheduleId = (job.payload as { scheduleId?: string }).scheduleId;
    if (!scheduleId) return;
    schedules.recordRun(scheduleId, { at: new Date().toISOString(), status: signal.aborted ? 'cancelled' : 'failed' });
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
    const payload = job.payload as FlowJobPayload | SearchJobPayload;
    const targetName = job.kind === 'flow' ? String((job.payload as FlowJobPayload).flowId) : String((job.payload as SearchJobPayload).label);

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

    // Job veio de um agendamento: registra o resultado nele. Um agendamento de
    // pesquisa pode gerar mais de um job (um por perfil); o último a terminar
    // é quem fica valendo como "última execução" — aproximação aceitável.
    if (payload.scheduleId) {
      schedules.recordRun(payload.scheduleId, { at: result.finishedAt, status: result.status });
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
