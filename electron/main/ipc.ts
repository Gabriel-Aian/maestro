import { BrowserWindow, ipcMain } from 'electron';
import {
  detectBrowsers,
  loadConfig,
  paths,
  profiles,
  flowsIndex,
  runs,
  schedules,
  getDb,
  type Job,
  type Profile,
  type FlowIndexRow,
  type RunStatus,
} from '../../src/index.js';
import { getMaestro } from './maestro.js';
import { QUEUE_EVENT_CHANNEL, type HistoryFilter, type HistoryRunView, type QueueEvent, type QueueJobView } from '../shared/ipc.js';

function profileName(profileId: string, all: Profile[]): string {
  return all.find((p) => p.id === profileId)?.name ?? profileId;
}

function jobLabel(job: Job, flows: FlowIndexRow[]): string {
  if (job.kind === 'flow') {
    const flowId = (job.payload as { flowId?: string }).flowId ?? '';
    return flows.find((f) => f.id === flowId)?.name ?? flowId;
  }
  return (job.payload as { label?: string }).label ?? 'pesquisas';
}

/**
 * `job` aqui pode estar obsoleto: `JobQueue.finish()` só grava o desfecho no
 * SQLite, nunca no objeto em memória que os eventos `finished`/`failed`
 * carregam como primeiro argumento (ver `queue.ts`). Por isso `status`/`runId`/
 * `error` aceitam override — quem estiver reagindo a um desses dois eventos
 * deve sempre passar o dado vindo do segundo argumento do evento, não confiar
 * no `job` em si.
 */
function toQueueJobView(
  job: Job,
  allProfiles: Profile[],
  flows: FlowIndexRow[],
  overrides?: { status?: Job['status']; runId?: string | null; error?: string | null },
): QueueJobView {
  return {
    id: job.id,
    kind: job.kind,
    label: jobLabel(job, flows),
    profileId: job.profileId,
    profileName: profileName(job.profileId, allProfiles),
    status: overrides?.status ?? job.status,
    priority: job.priority,
    attempts: job.attempts,
    createdAt: job.createdAt,
    runId: overrides && 'runId' in overrides ? (overrides.runId ?? null) : (job.runId ?? null),
    error: overrides && 'error' in overrides ? (overrides.error ?? null) : (job.error ?? null),
  };
}

function rowToJob(row: Record<string, unknown>): Job {
  return {
    id: String(row.id),
    kind: String(row.kind) as Job['kind'],
    payload: JSON.parse(String(row.payload)) as Record<string, unknown>,
    profileId: String(row.profile_id),
    headless: Number(row.headless) === 1,
    status: String(row.status) as Job['status'],
    priority: Number(row.priority),
    attempts: Number(row.attempts),
    createdAt: String(row.created_at),
    runId: row.run_id ? String(row.run_id) : null,
    error: row.error ? String(row.error) : null,
  };
}

function listQueueJobs(): QueueJobView[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM jobs
       ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, created_at DESC
       LIMIT 100`,
    )
    .all() as Array<Record<string, unknown>>;

  const allProfiles = profiles.list();
  const flows = flowsIndex.list();
  return rows.map((row) => toQueueJobView(rowToJob(row), allProfiles, flows));
}

function toHistoryRunView(row: Record<string, unknown>, allProfiles: Profile[]): HistoryRunView {
  const profileId = row.profile_id ? String(row.profile_id) : null;
  return {
    id: String(row.id),
    kind: String(row.kind),
    status: String(row.status),
    targetName: row.target_name ? String(row.target_name) : null,
    profileName: profileId ? profileName(profileId, allProfiles) : null,
    startedAt: String(row.started_at),
    finishedAt: row.finished_at ? String(row.finished_at) : null,
    durationMs: row.duration_ms !== null && row.duration_ms !== undefined ? Number(row.duration_ms) : null,
    degraded: Number(row.degraded) === 1,
    error: row.error ? String(row.error) : null,
    blockReason: row.block_reason ? String(row.block_reason) : null,
    artifactsDir: row.artifacts_dir ? String(row.artifacts_dir) : null,
  };
}

function broadcast(event: QueueEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(QUEUE_EVENT_CHANNEL, event);
  }
}

/** Registra os handlers de IPC e liga os eventos da fila real ao broadcast para todas as janelas. */
export function registerIpcHandlers(): void {
  const maestro = getMaestro();

  const asView = (job: Job) => toQueueJobView(job, profiles.list(), flowsIndex.list());
  maestro.queue.on('enqueued', (job) => broadcast({ type: 'enqueued', job: asView(job) }));
  maestro.queue.on('started', (job) => broadcast({ type: 'started', job: asView(job) }));

  // `result` (RunResult) é a fonte de verdade do desfecho — `job` sozinho está
  // congelado no estado de quando entrou em execução (ver toQueueJobView acima).
  maestro.queue.on('finished', (job, result) => {
    const status: Job['status'] = result.status === 'success' ? 'done' : 'failed';
    const view = toQueueJobView(job, profiles.list(), flowsIndex.list(), { status, runId: result.runId, error: result.error ?? null });
    broadcast({ type: 'finished', job: view });
  });

  // `message` é o erro real; o `job` recebido aqui nunca teve `.error` preenchido.
  maestro.queue.on('failed', (job, message) => {
    const view = toQueueJobView(job, profiles.list(), flowsIndex.list(), { status: 'failed', runId: null, error: message });
    broadcast({ type: 'failed', job: view });
  });

  maestro.queue.on('killed', () => broadcast({ type: 'killed' }));

  ipcMain.handle('maestro:getStatus', async () => {
    const config = loadConfig();
    const detected = await detectBrowsers();
    const allProfiles = profiles.list();
    const pending = getDb().prepare(`SELECT COUNT(*) AS n FROM jobs WHERE status = 'pending'`).get() as { n: number };

    return {
      node: process.version,
      electron: process.versions.electron,
      platform: process.platform,
      dataDir: paths.root,
      browsersDetected: detected.map((b) => b.id),
      profiles: { total: allProfiles.length, authenticated: allProfiles.filter((p) => p.status === 'authenticated').length },
      flows: flowsIndex.list().length,
      schedules: schedules.list().length,
      pendingJobs: Number(pending.n),
      recentRuns: runs.list({ limit: 5 }).length,
      defaultHeadless: config.defaultHeadless,
    };
  });

  ipcMain.handle('maestro:queue:list', () => listQueueJobs());

  ipcMain.handle('maestro:queue:cancel', (_event, jobId: string) => maestro.queue.cancel(jobId));

  ipcMain.handle('maestro:queue:killAll', async () => {
    await maestro.killAll();
  });

  ipcMain.handle('maestro:history:list', (_event, filter: HistoryFilter): HistoryRunView[] => {
    const allProfiles = profiles.list();
    const rows = runs.list({ ...filter, status: filter.status as RunStatus | undefined });
    return rows.map((row) => toHistoryRunView(row, allProfiles));
  });
}
