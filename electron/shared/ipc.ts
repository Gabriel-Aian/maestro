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

/* ─────────────────────────  PERFIS E NAVEGADORES  ───────────────────────── */

export interface BrowserView {
  id: string;
  name: string;
  /** null quando nem detectado no Registro nem registrado manualmente. */
  executablePath: string | null;
  source: 'registry' | 'filesystem' | 'manual' | 'none';
}

export interface ProfileView {
  id: string;
  name: string;
  browserId: string;
  status: 'never_authenticated' | 'authenticated' | 'session_expired';
  /** Navegador aberto agora (login em andamento, ou execução ativa). */
  locked: boolean;
  lastUsedAt: string | null;
  createdAt: string;
}

export type ActionResult = { ok: true } | { ok: false; reason: string };
export type AddProfileResult = { ok: true; profile: ProfileView } | { ok: false; reason: string };
export interface LoginCheckResult {
  locked: boolean;
}

/**
 * Login manual "sem automação" (RNF-006, RF-009): o navegador é aberto por
 * processo do sistema operacional direto, sem CDP — nenhum provedor de
 * identidade recusa por detectar automação. Como o processo não é
 * controlado, não há como saber programaticamente quando o login terminou;
 * por isso o widget flutuante (`#/login-widget`) em vez de fechar sozinho.
 */
export const LOGIN_DEFAULT_URL = 'https://www.google.com/';

/** O widget de login é uma janela separada — este evento avisa a tela de Perfis quando ele termina lá. */
export type ProfilesEvent = { type: 'login-completed'; profileId: string };
export const PROFILES_EVENT_CHANNEL = 'maestro:profilesEvent';

/* ─────────────────────────  FLUXOS  ───────────────────────── */

export interface FlowListItem {
  id: string;
  name: string;
  startUrl: string;
  stepCount: number;
  needsReview: boolean;
  lastStatus: string | null;
  updatedAt: string;
}

export interface FlowVariableView {
  name: string;
  default: string;
  description: string;
  sensitive: boolean;
}

export interface FlowStepView {
  index: number;
  type: string;
  /** Resumo do seletor/alvo principal do passo — mesma lógica do `flow show` da CLI. */
  summary: string;
  note: string | null;
}

export interface FlowDetailView {
  id: string;
  name: string;
  startUrl: string;
  needsReview: boolean;
  variables: FlowVariableView[];
  steps: FlowStepView[];
}

export type RunFlowResult = { ok: true; jobId: string } | { ok: false; reason: string };

export interface FlowStepResultView {
  index: number;
  type: string;
  status: 'success' | 'failed' | 'skipped';
  degraded: boolean;
  attempts: number;
  durationMs: number;
  error: string | null;
}

/** Resultado completo de uma execução — buscado sob demanda quando o job termina (evita inflar QueueEvent). */
export interface FlowRunDetail {
  runId: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  degraded: boolean;
  error: string | null;
  blockReason: string | null;
  artifactsDir: string | null;
  steps: FlowStepResultView[];
}
