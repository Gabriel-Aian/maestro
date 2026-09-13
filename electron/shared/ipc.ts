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
  /** Nas pesquisas, é a query de fato pesquisada nesse passo — `null` para passos de fluxo. */
  note: string | null;
}

/** Resultado completo de uma execução — buscado sob demanda quando o job termina (evita inflar QueueEvent). Usado por fluxos e pesquisas. */
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

/* ─────────────────────────  PESQUISAS  ───────────────────────── */

export interface SearchThemeView {
  id: string;
  name: string;
  /** Do próprio arquivo — um tema desativado nunca roda, a GUI não sobrepõe isso. */
  enabled: boolean;
  /** Contagem já expandida (variáveis + repetições), não a quantidade de linhas no arquivo. */
  queryCount: number;
}

export interface SearchFileView {
  filePath: string;
  themeCount: number;
  totalQueries: number;
  themes: SearchThemeView[];
}

export interface SearchValidationIssue {
  path: string;
  message: string;
}

export type LoadSearchFileResult =
  | { ok: true; file: SearchFileView }
  | { ok: false; filePath: string; reason: string; issues?: SearchValidationIssue[] };

export type RunSearchResult = { ok: true; jobIds: string[] } | { ok: false; reason: string };

/** Mecanismos de busca declarados em `src/search/engines.ts` — a GUI nunca hardcoda essa lista. */
export interface SearchEngineOption {
  id: string;
  name: string;
}

/** Parâmetros opcionais de uma execução manual — sobrescrevem o que o arquivo declarar, sem alterá-lo. */
export interface RunSearchOptions {
  themeIds: string[];
  sampleSize?: number;
  /** `undefined` mantém o mecanismo do arquivo; um id de `SearchEngineOption` sobrescreve. */
  engine?: string;
  /** [min, max] em ms; `undefined` mantém `delayBetweenSearchesMs` do arquivo. */
  delayRangeMs?: [number, number];
  /** `true` roda com o navegador visível, para depurar — `undefined`/`false` mantém o padrão de sempre. */
  headed?: boolean;
}

/* ─────────────────────────  AGENDAMENTOS  ───────────────────────── */

export interface ScheduleFlowTargetView {
  kind: 'flow';
  flowId: string;
  flowName: string;
  profileId: string;
  profileName: string;
  variables: Record<string, string>;
}

export interface ScheduleSearchTargetView {
  kind: 'search';
  searchFile: string;
  /** null = todos os temas habilitados no arquivo, reavaliado a cada disparo. */
  themeIds: string[] | null;
  /** null = roda todas as pesquisas filtradas; caso contrário, sorteia esse número sem repetir a cada disparo. */
  sampleSize: number | null;
  /** null = usa o mecanismo declarado no arquivo; caso contrário, sobrescreve a cada disparo. */
  engine: string | null;
  /** null = usa `delayBetweenSearchesMs` do arquivo; caso contrário, sobrescreve a cada disparo. */
  delayRangeMs: [number, number] | null;
}

export type ScheduleTargetView = ScheduleFlowTargetView | ScheduleSearchTargetView;

export interface ScheduleView {
  id: string;
  name: string;
  cron: string;
  enabled: boolean;
  target: ScheduleTargetView;
  /** Calculado a partir do cron no momento da consulta — não é persistido. */
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: string | null;
}

export type CreateScheduleInput = {
  name: string;
  cron: string;
  target:
    | { kind: 'flow'; flowId: string; profileId: string; variables: Record<string, string> }
    | {
        kind: 'search';
        searchFile: string;
        themeIds: string[] | null;
        sampleSize: number | null;
        engine: string | null;
        delayRangeMs: [number, number] | null;
      };
};

export type CreateScheduleResult = { ok: true; schedule: ScheduleView } | { ok: false; reason: string };

export type RunScheduleResult = { ok: true; jobIds: string[] } | { ok: false; reason: string };

/** Reaproveita SearchThemeView: mesmo formato usado pela tela de Pesquisas para listar temas de um arquivo. */
export type PickScheduleSearchFileResult = { ok: true; filePath: string; themes: SearchThemeView[] } | { ok: false; reason: string };

/**
 * A tarefa do Agendador do Windows não roda de verdade neste ambiente de
 * desenvolvimento (Linux) — `ok: false` aqui é o caminho esperado ao rodar
 * fora do Windows, não necessariamente um erro do usuário.
 */
export type WindowsTaskStatusResult = { ok: true; installed: boolean; raw?: string } | { ok: false; reason: string };
export type WindowsTaskActionResult = { ok: true } | { ok: false; reason: string };

/* ─────────────────────────  CONFIGURAÇÕES  ───────────────────────── */

/**
 * Espelha `AppConfig` (`src/types/schema.ts`) achatado para IPC — mesmo
 * padrão de todo o resto deste arquivo (nenhum tipo do núcleo cruza a ponte
 * direto). Campos aqui divididos em dois grupos na tela: os lidos "ao vivo"
 * a cada job (a maioria) e os congelados na construção do `Maestro`
 * (`maxConcurrentBrowsers`, `jobTimeoutMs`, `jobDelayMs`, `browserIdleTtlMs`
 * — só valem depois de reiniciar o app).
 */
export interface AppConfigView {
  defaultHeadless: boolean;
  defaultTimeoutMs: number;
  defaultMaxRetries: number;
  defaultViewport: { width: number; height: number };
  maxConcurrentBrowsers: number;
  jobTimeoutMs: number;
  browserIdleTtlMs: number;
  defaultStepDelayMs: [number, number];
  jobDelayMs: [number, number];
  retention: { maxAgeDays: number; maxRuns: number; failureMultiplier: number; diskWarningMb: number };
  captureTrace: boolean;
  detectLoginWall: boolean;
}

export type UpdateConfigResult = { ok: true; config: AppConfigView } | { ok: false; reason: string };

/* ─────────────────────────  ATUALIZAÇÕES  ───────────────────────── */

/**
 * Espelha os eventos de `electron-updater` — canal GitHub Releases público
 * (ver `electron-builder.yml`). `downloading`/`downloaded` só ocorrem porque
 * `autoDownload = true` (ver `electron/main/autoUpdate.ts` para o porquê de
 * baixar sozinho mas nunca instalar sozinho).
 */
export type UpdateStatus =
  | { state: 'unsupported'; reason: string }
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'available'; version: string }
  | { state: 'not-available' }
  | { state: 'downloading'; version: string; percent: number }
  | { state: 'downloaded'; version: string }
  | { state: 'error'; message: string };

export const UPDATE_EVENT_CHANNEL = 'maestro:updateEvent';
