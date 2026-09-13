import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { getDb } from '../db/index.js';
import { logger } from '../logger.js';
import type { RunResult } from '../types/schema.js';

export type JobKind = 'flow' | 'search';
export type JobStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

export interface Job {
  id: string;
  kind: JobKind;
  payload: Record<string, unknown>;
  profileId: string;
  headless: boolean;
  status: JobStatus;
  priority: number;
  attempts: number;
  createdAt: string;
  runId?: string | null;
  error?: string | null;
}

export type JobHandler = (job: Job, signal: AbortSignal) => Promise<RunResult>;

/** Eventos tipados: o consumidor recebe RunResult tipado, não `any`. */
export interface JobQueueEvents {
  enqueued: [Job];
  started: [Job];
  finished: [Job, RunResult];
  failed: [Job, string];
  killed: [];
}

export interface QueueOptions {
  maxConcurrent: number;
  jobTimeoutMs: number;
  pollIntervalMs?: number;
}

/**
 * Fila persistida em SQLite (RF-048).
 *
 * Duas invariantes governam o despacho:
 *  1. no máximo um job ativo por perfil, sempre (RN-001) — porque um diretório
 *     de perfil não pode ser aberto por duas instâncias do navegador;
 *  2. teto global de navegadores simultâneos (RF-051), porque cada instância do
 *     Chromium custa centenas de MB e estourar a RAM derruba tudo junto.
 *
 * Elas são independentes: a primeira protege a correção, a segunda protege a
 * máquina. Jobs de pesquisa e de fluxo compartilham a mesma fila e, por
 * consequência, rodam em paralelo sempre que estiverem em perfis distintos
 * (RF-049).
 */
export class JobQueue extends EventEmitter<JobQueueEvents> {
  private readonly running = new Map<string, { profileId: string; controller: AbortController; timer: NodeJS.Timeout }>();
  private draining = false;
  private stopped = true;
  private pollTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly handler: JobHandler,
    private readonly options: QueueOptions,
  ) {
    super();
  }

  /* ───────── enfileiramento ───────── */

  enqueue(input: { kind: JobKind; payload: Record<string, unknown>; profileId: string; headless?: boolean; priority?: number }): Job {
    const job: Job = {
      id: `job-${randomUUID().slice(0, 8)}`,
      kind: input.kind,
      payload: input.payload,
      profileId: input.profileId,
      headless: input.headless ?? true,
      status: 'pending',
      priority: input.priority ?? 0,
      attempts: 0,
      createdAt: new Date().toISOString(),
    };

    getDb()
      .prepare(
        `INSERT INTO jobs (id, kind, payload, profile_id, headless, status, priority, attempts, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(job.id, job.kind, JSON.stringify(job.payload), job.profileId, job.headless ? 1 : 0, job.status, job.priority, 0, job.createdAt);

    this.emit('enqueued', job);
    this.tick();
    return job;
  }

  /* ───────── ciclo de vida ───────── */

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    // Jobs que ficaram 'running' são resíduo de encerramento abrupto: voltam
    // para a fila em vez de sumirem (RNF-012).
    const recovered = getDb().prepare(`UPDATE jobs SET status = 'pending', started_at = NULL WHERE status = 'running'`).run();
    if (Number(recovered.changes) > 0) {
      logger.warn({ count: Number(recovered.changes) }, 'Jobs órfãos devolvidos à fila');
    }
    this.pollTimer = setInterval(() => this.tick(), this.options.pollIntervalMs ?? 500);
    this.pollTimer.unref?.();
    this.tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    await this.waitForIdle();
  }

  /** Kill switch: aborta tudo que está rodando e limpa os pendentes (RF-054). */
  async killAll(): Promise<void> {
    this.stopped = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;

    for (const [jobId, entry] of this.running) {
      entry.controller.abort();
      clearTimeout(entry.timer);
      this.finish(jobId, 'cancelled', null, 'Interrompido pelo kill switch.');
    }
    this.running.clear();

    getDb().prepare(`UPDATE jobs SET status = 'cancelled' WHERE status = 'pending'`).run();
    this.emit('killed');
    logger.warn('Kill switch acionado: fila esvaziada');
  }

  cancel(jobId: string): boolean {
    const entry = this.running.get(jobId);
    if (entry) {
      entry.controller.abort();
      clearTimeout(entry.timer);
      this.running.delete(jobId);
      this.finish(jobId, 'cancelled', null, 'Cancelado pelo usuário.');
      return true;
    }
    const changed = getDb().prepare(`UPDATE jobs SET status = 'cancelled' WHERE id = ? AND status = 'pending'`).run(jobId);
    return Number(changed.changes) > 0;
  }

  async waitForIdle(): Promise<void> {
    while (this.running.size > 0) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  get activeCount(): number {
    return this.running.size;
  }

  pendingCount(): number {
    const row = getDb().prepare(`SELECT COUNT(*) AS n FROM jobs WHERE status = 'pending'`).get() as { n: number };
    return Number(row.n);
  }

  /* ───────── despacho ───────── */

  private tick(): void {
    if (this.stopped || this.draining) return;
    this.draining = true;
    try {
      while (this.running.size < this.options.maxConcurrent) {
        const job = this.nextEligible();
        if (!job) break;
        void this.execute(job);
      }
    } finally {
      this.draining = false;
    }
  }

  /**
   * Próximo job cujo perfil está livre. O filtro por perfil ocupado vive na
   * própria consulta para que a decisão seja atômica em relação ao estado
   * persistido, e não dependa apenas do mapa em memória.
   */
  private nextEligible(): Job | null {
    const busy = [...this.running.values()].map((e) => e.profileId);
    const placeholders = busy.map(() => '?').join(',');
    const exclusion = busy.length > 0 ? `AND profile_id NOT IN (${placeholders})` : '';

    const row = getDb()
      .prepare(
        `SELECT * FROM jobs
         WHERE status = 'pending' ${exclusion}
         ORDER BY priority DESC, created_at ASC
         LIMIT 1`,
      )
      .get(...(busy as never[])) as Record<string, unknown> | undefined;

    return row ? rowToJob(row) : null;
  }

  private async execute(job: Job): Promise<void> {
    const controller = new AbortController();

    // Timeout global por job: sem ele, um worker travado prende o perfil e
    // segura toda a fila daquela conta indefinidamente (RNF-014).
    const timer = setTimeout(() => {
      controller.abort();
      logger.error({ jobId: job.id, timeoutMs: this.options.jobTimeoutMs }, 'Job excedeu o tempo máximo');
    }, this.options.jobTimeoutMs);
    timer.unref?.();

    this.running.set(job.id, { profileId: job.profileId, controller, timer });

    getDb()
      .prepare(`UPDATE jobs SET status = 'running', started_at = ?, attempts = attempts + 1 WHERE id = ?`)
      .run(new Date().toISOString(), job.id);

    this.emit('started', job);

    try {
      const result = await this.handler(job, controller.signal);
      const status: JobStatus = result.status === 'success' ? 'done' : 'failed';
      this.finish(job.id, status, result.runId, result.error ?? null);
      this.emit('finished', job, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status: JobStatus = controller.signal.aborted ? 'cancelled' : 'failed';
      this.finish(job.id, status, null, message);
      // Falha isolada não pode derrubar os demais jobs (RNF-013).
      logger.error({ jobId: job.id, err: message }, 'Job falhou');
      this.emit('failed', job, message);
    } finally {
      clearTimeout(timer);
      this.running.delete(job.id);
      if (!this.stopped) setImmediate(() => this.tick());
    }
  }

  private finish(jobId: string, status: JobStatus, runId: string | null, error: string | null): void {
    getDb()
      .prepare(`UPDATE jobs SET status = ?, finished_at = ?, run_id = ?, error = ? WHERE id = ?`)
      .run(status, new Date().toISOString(), runId, error, jobId);
  }
}

function rowToJob(row: Record<string, unknown>): Job {
  return {
    id: String(row.id),
    kind: String(row.kind) as JobKind,
    payload: JSON.parse(String(row.payload)) as Record<string, unknown>,
    profileId: String(row.profile_id),
    headless: Number(row.headless) === 1,
    status: String(row.status) as JobStatus,
    priority: Number(row.priority),
    attempts: Number(row.attempts),
    createdAt: String(row.created_at),
    runId: row.run_id ? String(row.run_id) : null,
    error: row.error ? String(row.error) : null,
  };
}
