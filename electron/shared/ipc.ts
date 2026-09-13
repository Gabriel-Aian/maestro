/**
 * Contrato entre main e renderer. Vive fora de `main/` e `renderer/` de
 * propósito: os dois lados importam daqui, nenhum importa do outro
 * diretamente — o preload é a única ponte de verdade (contextBridge).
 */

export type JobStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

export interface QueueJobView {
  id: string;
  kind: 'flow' | 'search';
  label: string;
  profileId: string;
  profileName: string;
  status: JobStatus;
  priority: number;
  attempts: number;
  createdAt: string;
  runId: string | null;
  error: string | null;
}

export interface HistoryRunView {
  id: string;
  kind: string;
  status: string;
  targetName: string | null;
  profileName: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  degraded: boolean;
  error: string | null;
  blockReason: string | null;
  artifactsDir: string | null;
}

export interface StatusView {
  node: string;
  electron: string;
  platform: string;
  dataDir: string;
  browsersDetected: string[];
  profiles: { total: number; authenticated: number };
  flows: number;
  schedules: number;
  pendingJobs: number;
  recentRuns: number;
  defaultHeadless: boolean;
}

export interface HistoryFilter {
  status?: string;
  kind?: string;
  limit?: number;
  offset?: number;
}

/** Espelha os eventos de `JobQueue`, achatados para IPC (sem instâncias de classe). */
export type QueueEvent =
  | { type: 'enqueued'; job: QueueJobView }
  | { type: 'started'; job: QueueJobView }
  | { type: 'finished'; job: QueueJobView }
  | { type: 'failed'; job: QueueJobView }
  | { type: 'killed' };

export const QUEUE_EVENT_CHANNEL = 'maestro:queueEvent';
