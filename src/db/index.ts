import { DatabaseSync } from 'node:sqlite';
import { paths, ensureDataDirs } from '../config/paths.js';
import { logger } from '../logger.js';
import type { Profile, ProfileStatus, RunResult, RunStatus, Schedule, ScheduleTarget } from '../types/schema.js';

/**
 * Persistência local em SQLite.
 *
 * Usa `node:sqlite`, embutido no Node 22+, em vez de `better-sqlite3`. O motivo
 * é prático: better-sqlite3 é um módulo nativo que precisa ser recompilado para
 * a ABI do Electron a cada atualização, o que é a maior fonte de atrito em
 * empacotamento Electron. Toda a API usada aqui (prepare/run/get/all, exec,
 * transações) tem equivalente 1:1, então trocar de driver é alterar só este
 * arquivo caso o caráter experimental do módulo se torne um problema.
 */

let db: DatabaseSync | null = null;

const MIGRATIONS: ReadonlyArray<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
      CREATE TABLE profiles (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL UNIQUE,
        browser_id    TEXT NOT NULL,
        user_data_dir TEXT NOT NULL,
        status        TEXT NOT NULL DEFAULT 'never_authenticated',
        last_used_at  TEXT,
        created_at    TEXT NOT NULL
      );

      CREATE TABLE flows_index (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        start_url     TEXT NOT NULL,
        step_count    INTEGER NOT NULL,
        needs_review  INTEGER NOT NULL DEFAULT 0,
        updated_at    TEXT NOT NULL,
        last_run_id   TEXT,
        last_status   TEXT
      );

      CREATE TABLE jobs (
        id            TEXT PRIMARY KEY,
        kind          TEXT NOT NULL CHECK (kind IN ('flow','search')),
        payload       TEXT NOT NULL,
        profile_id    TEXT NOT NULL,
        headless      INTEGER NOT NULL DEFAULT 1,
        status        TEXT NOT NULL DEFAULT 'pending',
        priority      INTEGER NOT NULL DEFAULT 0,
        attempts      INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT NOT NULL,
        started_at    TEXT,
        finished_at   TEXT,
        run_id        TEXT,
        error         TEXT
      );
      CREATE INDEX idx_jobs_dispatch ON jobs (status, priority DESC, created_at);
      CREATE INDEX idx_jobs_profile  ON jobs (profile_id, status);

      CREATE TABLE runs (
        id            TEXT PRIMARY KEY,
        kind          TEXT NOT NULL,
        target_id     TEXT,
        target_name   TEXT,
        profile_id    TEXT,
        status        TEXT NOT NULL,
        degraded      INTEGER NOT NULL DEFAULT 0,
        started_at    TEXT NOT NULL,
        finished_at   TEXT,
        duration_ms   INTEGER,
        artifacts_dir TEXT,
        error         TEXT,
        block_reason  TEXT,
        steps_json    TEXT
      );
      CREATE INDEX idx_runs_started ON runs (started_at DESC);
      CREATE INDEX idx_runs_status  ON runs (status, started_at DESC);
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE schedules (
        id             TEXT PRIMARY KEY,
        name           TEXT NOT NULL,
        cron           TEXT NOT NULL,
        enabled        INTEGER NOT NULL DEFAULT 1,
        target_json    TEXT NOT NULL,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL,
        last_run_at    TEXT,
        last_status    TEXT,
        last_fired_key TEXT
      );
      CREATE INDEX idx_schedules_enabled ON schedules (enabled);
    `,
  },
];

export function getDb(): DatabaseSync {
  if (db) return db;

  ensureDataDirs();
  db = new DatabaseSync(paths.db);
  db.exec('PRAGMA journal_mode = WAL;'); // sobrevive a encerramento abrupto (RNF-012)
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

function migrate(database: DatabaseSync): void {
  database.exec('CREATE TABLE IF NOT EXISTS schema_meta (version INTEGER NOT NULL);');
  const row = database.prepare('SELECT MAX(version) AS version FROM schema_meta').get() as { version: number | null } | undefined;
  const current = row?.version ?? 0;

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    database.exec('BEGIN');
    try {
      database.exec(migration.sql);
      database.prepare('INSERT INTO schema_meta (version) VALUES (?)').run(migration.version);
      database.exec('COMMIT');
      logger.info({ version: migration.version }, 'Migração aplicada');
    } catch (err) {
      database.exec('ROLLBACK');
      throw err;
    }
  }
}

export function closeDb(): void {
  db?.close();
  db = null;
}

/* ─────────────────────────  PERFIS  ───────────────────────── */

export const profiles = {
  insert(profile: Profile): void {
    getDb()
      .prepare(
        `INSERT INTO profiles (id, name, browser_id, user_data_dir, status, last_used_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(profile.id, profile.name, profile.browserId, profile.userDataDir, profile.status, profile.lastUsedAt, profile.createdAt);
  },

  list(): Profile[] {
    const rows = getDb().prepare('SELECT * FROM profiles ORDER BY created_at').all() as Array<Record<string, unknown>>;
    return rows.map(rowToProfile);
  },

  find(idOrName: string): Profile | null {
    const row = getDb().prepare('SELECT * FROM profiles WHERE id = ? OR name = ?').get(idOrName, idOrName) as Record<string, unknown> | undefined;
    return row ? rowToProfile(row) : null;
  },

  setStatus(id: string, status: ProfileStatus): void {
    getDb().prepare('UPDATE profiles SET status = ? WHERE id = ?').run(status, id);
  },

  touch(id: string): void {
    getDb().prepare('UPDATE profiles SET last_used_at = ? WHERE id = ?').run(new Date().toISOString(), id);
  },

  remove(id: string): void {
    getDb().prepare('DELETE FROM profiles WHERE id = ?').run(id);
  },
};

function rowToProfile(row: Record<string, unknown>): Profile {
  return {
    id: String(row.id),
    name: String(row.name),
    browserId: String(row.browser_id),
    userDataDir: String(row.user_data_dir),
    status: String(row.status) as ProfileStatus,
    lastUsedAt: row.last_used_at ? String(row.last_used_at) : null,
    createdAt: String(row.created_at),
  };
}

/* ─────────────────────────  ÍNDICE DE FLUXOS  ───────────────────────── */

export interface FlowIndexRow {
  id: string;
  name: string;
  startUrl: string;
  stepCount: number;
  needsReview: boolean;
  updatedAt: string;
  lastRunId: string | null;
  lastStatus: string | null;
}

export const flowsIndex = {
  upsert(entry: Omit<FlowIndexRow, 'lastRunId' | 'lastStatus'>): void {
    getDb()
      .prepare(
        `INSERT INTO flows_index (id, name, start_url, step_count, needs_review, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           start_url = excluded.start_url,
           step_count = excluded.step_count,
           needs_review = excluded.needs_review,
           updated_at = excluded.updated_at`,
      )
      .run(entry.id, entry.name, entry.startUrl, entry.stepCount, entry.needsReview ? 1 : 0, entry.updatedAt);
  },

  list(): FlowIndexRow[] {
    const rows = getDb().prepare('SELECT * FROM flows_index ORDER BY updated_at DESC').all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      startUrl: String(r.start_url),
      stepCount: Number(r.step_count),
      needsReview: Number(r.needs_review) === 1,
      updatedAt: String(r.updated_at),
      lastRunId: r.last_run_id ? String(r.last_run_id) : null,
      lastStatus: r.last_status ? String(r.last_status) : null,
    }));
  },

  markReview(id: string, needsReview: boolean): void {
    getDb().prepare('UPDATE flows_index SET needs_review = ? WHERE id = ?').run(needsReview ? 1 : 0, id);
  },

  setLastRun(id: string, runId: string, status: RunStatus): void {
    getDb().prepare('UPDATE flows_index SET last_run_id = ?, last_status = ? WHERE id = ?').run(runId, status, id);
  },
};

/* ─────────────────────────  EXECUÇÕES  ───────────────────────── */

export const runs = {
  /**
   * Grava a execução. `target_name` é desnormalizado de propósito: o histórico
   * precisa sobreviver à exclusão do fluxo que o originou (RN-014).
   */
  save(result: RunResult, meta: { targetId?: string; targetName?: string; profileId?: string }): void {
    getDb()
      .prepare(
        `INSERT OR REPLACE INTO runs
         (id, kind, target_id, target_name, profile_id, status, degraded, started_at, finished_at, duration_ms, artifacts_dir, error, block_reason, steps_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        result.runId,
        result.kind,
        meta.targetId ?? null,
        meta.targetName ?? null,
        meta.profileId ?? null,
        result.status,
        result.degraded ? 1 : 0,
        result.startedAt,
        result.finishedAt,
        result.durationMs,
        result.artifactsDir,
        result.error ?? null,
        result.blockReason ?? null,
        JSON.stringify(result.steps),
      );
  },

  /** Histórico paginado — nunca carrega o conjunto completo (RNF-011). */
  list(filter: { status?: RunStatus; kind?: string; limit?: number; offset?: number } = {}): Array<Record<string, unknown>> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.status) {
      clauses.push('status = ?');
      params.push(filter.status);
    }
    if (filter.kind) {
      clauses.push('kind = ?');
      params.push(filter.kind);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(filter.limit ?? 50, filter.offset ?? 0);

    return getDb()
      .prepare(`SELECT * FROM runs ${where} ORDER BY started_at DESC LIMIT ? OFFSET ?`)
      .all(...(params as never[])) as Array<Record<string, unknown>>;
  },

  /** Execuções elegíveis à limpeza, já aplicando o dobro de prazo em falhas (RN-011). */
  expired(maxAgeDays: number, maxRuns: number, failureMultiplier: number): Array<{ id: string; dir: string }> {
    const database = getDb();
    const now = Date.now();

    const all = database.prepare('SELECT id, status, started_at, artifacts_dir FROM runs ORDER BY started_at DESC').all() as Array<
      Record<string, unknown>
    >;

    const doomed: Array<{ id: string; dir: string }> = [];
    all.forEach((row, position) => {
      const status = String(row.status);
      const isFailure = status === 'failed' || status === 'blocked';
      const allowedDays = maxAgeDays * (isFailure ? failureMultiplier : 1);
      const ageDays = (now - new Date(String(row.started_at)).getTime()) / 86_400_000;

      // As duas regras se somam: basta violar uma para ser excluído (RN-010).
      if (ageDays > allowedDays || position >= maxRuns) {
        doomed.push({ id: String(row.id), dir: String(row.artifacts_dir ?? '') });
      }
    });
    return doomed;
  },

  remove(id: string): void {
    getDb().prepare('DELETE FROM runs WHERE id = ?').run(id);
  },

  stats(days: number): { total: number; success: number; failed: number; blocked: number; degraded: number; avgMs: number } {
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const row = getDb()
      .prepare(
        `SELECT
           COUNT(*)                                              AS total,
           SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END)   AS success,
           SUM(CASE WHEN status = 'failed'  THEN 1 ELSE 0 END)   AS failed,
           SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END)   AS blocked,
           SUM(degraded)                                         AS degraded,
           COALESCE(AVG(duration_ms), 0)                         AS avg_ms
         FROM runs WHERE started_at >= ?`,
      )
      .get(since) as Record<string, unknown>;

    return {
      total: Number(row.total ?? 0),
      success: Number(row.success ?? 0),
      failed: Number(row.failed ?? 0),
      blocked: Number(row.blocked ?? 0),
      degraded: Number(row.degraded ?? 0),
      avgMs: Math.round(Number(row.avg_ms ?? 0)),
    };
  },
};

/* ─────────────────────────  AGENDAMENTOS  ───────────────────────── */

export const schedules = {
  insert(schedule: Schedule): void {
    getDb()
      .prepare(
        `INSERT INTO schedules (id, name, cron, enabled, target_json, created_at, updated_at, last_run_at, last_status, last_fired_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        schedule.id,
        schedule.name,
        schedule.cron,
        schedule.enabled ? 1 : 0,
        JSON.stringify(schedule.target),
        schedule.createdAt,
        schedule.updatedAt,
        schedule.lastRunAt,
        schedule.lastStatus,
        schedule.lastFiredKey,
      );
  },

  list(): Schedule[] {
    const rows = getDb().prepare('SELECT * FROM schedules ORDER BY created_at').all() as Array<Record<string, unknown>>;
    return rows.map(rowToSchedule);
  },

  find(idOrName: string): Schedule | null {
    const row = getDb().prepare('SELECT * FROM schedules WHERE id = ? OR name = ?').get(idOrName, idOrName) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToSchedule(row) : null;
  },

  setEnabled(id: string, enabled: boolean): void {
    getDb().prepare('UPDATE schedules SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
  },

  remove(id: string): void {
    getDb().prepare('DELETE FROM schedules WHERE id = ?').run(id);
  },

  /** Registra que o agendamento disparou agora — idempotência do tick (`lastFiredKey`). */
  recordFire(id: string, firedKey: string): void {
    getDb().prepare('UPDATE schedules SET last_fired_key = ? WHERE id = ?').run(firedKey, id);
  },

  /** Registra o resultado do job que esse agendamento originou. */
  recordRun(id: string, run: { at: string; status: string }): void {
    getDb().prepare('UPDATE schedules SET last_run_at = ?, last_status = ? WHERE id = ?').run(run.at, run.status, id);
  },
};

function rowToSchedule(row: Record<string, unknown>): Schedule {
  return {
    id: String(row.id),
    name: String(row.name),
    cron: String(row.cron),
    enabled: Number(row.enabled) === 1,
    target: JSON.parse(String(row.target_json)) as ScheduleTarget,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    lastRunAt: row.last_run_at ? String(row.last_run_at) : null,
    lastStatus: row.last_status ? String(row.last_status) : null,
    lastFiredKey: row.last_fired_key ? String(row.last_fired_key) : null,
  };
}
