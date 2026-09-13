import { z } from 'zod';
import { validate as validateCronExpression } from 'node-cron';

/* ─────────────────────────  SELETORES  ───────────────────────── */

/**
 * Um seletor candidato. A ordem na lista define a prioridade de tentativa (RN-005).
 * `stability` é uma pontuação heurística (0-100) atribuída na gravação, usada
 * apenas para ordenar candidatos — nunca para descartá-los em tempo de execução.
 */
export const SelectorCandidateSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('testId'),
    value: z.string().min(1),
    attribute: z.string().default('data-testid'),
    stability: z.number().min(0).max(100).default(100),
  }),
  z.object({
    kind: z.literal('css'),
    value: z.string().min(1),
    stability: z.number().min(0).max(100).default(50),
  }),
  z.object({
    kind: z.literal('role'),
    value: z.string().min(1), // papel ARIA, ex. "button"
    name: z.string().optional(), // nome acessível
    exact: z.boolean().default(false),
    stability: z.number().min(0).max(100).default(80),
  }),
  z.object({
    kind: z.literal('label'),
    value: z.string().min(1),
    stability: z.number().min(0).max(100).default(75),
  }),
  z.object({
    kind: z.literal('placeholder'),
    value: z.string().min(1),
    stability: z.number().min(0).max(100).default(65),
  }),
  z.object({
    kind: z.literal('text'),
    value: z.string().min(1),
    exact: z.boolean().default(false),
    stability: z.number().min(0).max(100).default(55),
  }),
  z.object({
    kind: z.literal('xpath'),
    value: z.string().min(1),
    stability: z.number().min(0).max(100).default(10),
  }),
]);
export type SelectorCandidate = z.infer<typeof SelectorCandidateSchema>;

/**
 * Caminho até o frame onde o elemento vive (RF-024). Vazio = frame principal.
 * Resolvido por URL, com o índice como fallback quando a URL não casar.
 */
export const FrameRefSchema = z.object({
  url: z.string(),
  index: z.number().int().min(0),
  name: z.string().optional(),
});
export type FrameRef = z.infer<typeof FrameRefSchema>;

/**
 * Faixa [min, max] em ms para sorteio uniforme de um atraso — nunca um valor
 * fixo (RN-008). Reaproveitada em três granularidades: configuração global,
 * fluxo e passo (delay entre passos), e pesquisas (delay entre buscas).
 */
export const DelayRangeSchema = z
  .tuple([z.number().int().min(0), z.number().int().min(0)])
  .refine(([min, max]) => min <= max, { message: 'faixa de delay: min precisa ser <= max' });
export type DelayRange = z.infer<typeof DelayRangeSchema>;

/* ─────────────────────────  PASSOS DE FLUXO  ───────────────────────── */

const stepBase = {
  index: z.number().int().min(0),
  frame: z.array(FrameRefSchema).default([]),
  timeoutMs: z.number().int().positive().default(15_000),
  /** Política de falha do passo (RF-047). */
  onFailure: z.enum(['abort', 'skip']).default('abort'),
  maxRetries: z.number().int().min(0).max(10).default(2),
  screenshot: z.boolean().default(false),
  note: z.string().optional(),
  /**
   * URL observada durante a GRAVAÇÃO neste passo. Serve de referência para a
   * detecção de bloqueio: se o fluxo já passava por uma tela de login quando
   * foi gravado, passar por ela de novo é esperado, não sessão expirada.
   */
  observedUrl: z.string().optional(),
  /**
   * Intervalo bruto (ms) observado antes deste passo durante a gravação.
   * Guardado sempre, independente do limiar usado para gerar `note` (que é só
   * para leitura humana) — é o que alimenta a conversão em passos reais.
   */
  recordedGapMs: z.number().int().min(0).optional(),
  /** Delay antes deste passo especificamente, sobrepondo fluxo e global. */
  delayMs: DelayRangeSchema.optional(),
};

const withSelectors = {
  ...stepBase,
  selectors: z.array(SelectorCandidateSchema).min(1),
};

export const FlowStepSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('navigate'), ...stepBase, url: z.string().url() }),
  z.object({ type: z.literal('click'), ...withSelectors, button: z.enum(['left', 'middle', 'right']).default('left') }),
  z.object({ type: z.literal('doubleClick'), ...withSelectors }),
  z.object({ type: z.literal('type'), ...withSelectors, value: z.string(), clearFirst: z.boolean().default(true), pressEnter: z.boolean().default(false) }),
  z.object({ type: z.literal('select'), ...withSelectors, values: z.array(z.string()).min(1) }),
  z.object({ type: z.literal('check'), ...withSelectors, checked: z.boolean() }),
  z.object({ type: z.literal('press'), ...stepBase, key: z.string().min(1) }),
  z.object({
    type: z.literal('scroll'),
    ...stepBase,
    target: z.enum(['document', 'element']).default('document'),
    selectors: z.array(SelectorCandidateSchema).optional(),
    x: z.number().default(0),
    y: z.number(),
  }),
  z.object({ type: z.literal('waitForElement'), ...withSelectors, state: z.enum(['attached', 'visible', 'hidden']).default('visible') }),
  z.object({ type: z.literal('waitForTimeout'), ...stepBase, ms: z.number().int().positive().max(300_000) }),
  z.object({ type: z.literal('assertText'), ...withSelectors, operator: z.enum(['contains', 'equals', 'matches']).default('contains'), expected: z.string() }),
  z.object({ type: z.literal('assertUrl'), ...stepBase, operator: z.enum(['contains', 'equals', 'matches']).default('contains'), expected: z.string() }),
  z.object({ type: z.literal('screenshot'), ...stepBase, label: z.string().default('manual') }),
  /**
   * Troca a aba ativa. `matchUrl` é o critério primário porque o índice muda
   * conforme abas abrem e fecham em ordens diferentes entre execuções; o índice
   * fica como desempate quando nenhuma URL casa.
   */
  z.object({
    type: z.literal('switchTab'),
    ...stepBase,
    tabIndex: z.number().int().min(0),
    matchUrl: z.string().optional(),
    /** Espera a aba aparecer: popups abrem de forma assíncrona após o clique. */
    waitForNew: z.boolean().default(false),
  }),
  z.object({ type: z.literal('closeTab'), ...stepBase }),
]);
export type FlowStep = z.infer<typeof FlowStepSchema>;
export type FlowStepType = FlowStep['type'];

/** Passos que não sofrem retry: falha de asserção é determinística (RN-012). */
export const NON_RETRYABLE_STEPS: ReadonlySet<FlowStepType> = new Set(['assertText', 'assertUrl']);

/* ─────────────────────────  FLUXO  ───────────────────────── */

export const FlowVariableSchema = z.object({
  name: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, 'nome inválido para variável'),
  default: z.string().default(''),
  description: z.string().default(''),
  /** Variáveis sensíveis são mascaradas em logs e artefatos (RNF-005). */
  sensitive: z.boolean().default(false),
});
export type FlowVariable = z.infer<typeof FlowVariableSchema>;

export const FlowSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  name: z.string().min(1),
  startUrl: z.string().url(),
  viewport: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).default({ width: 1366, height: 768 }),
  variables: z.array(FlowVariableSchema).default([]),
  steps: z.array(FlowStepSchema).min(1, 'um fluxo precisa de ao menos um passo (RF-030)'),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Marcado quando algum passo usou seletor de fallback (RN-006). */
  needsReview: z.boolean().default(false),
  /** Delay entre passos para todo o fluxo, sobrepondo o padrão global. */
  stepDelayMs: DelayRangeSchema.optional(),
});
export type Flow = z.infer<typeof FlowSchema>;

/* ─────────────────────────  PESQUISAS  ───────────────────────── */

export const SearchDefaultsSchema = z.object({
  browser: z.string().default('chrome'),
  profile: z.string().optional(),
  engine: z.string().default('google'),
  headless: z.boolean().default(true),
  delayBetweenSearchesMs: DelayRangeSchema.default([4_000, 12_000]),
  screenshot: z.enum(['none', 'after', 'both']).default('none'),
  maxRetries: z.number().int().min(0).max(5).default(2),
});
export type SearchDefaults = z.infer<typeof SearchDefaultsSchema>;

export const QuerySchema = z.union([
  z.string().min(1),
  z.object({
    text: z.string().min(1),
    vars: z.record(z.string(), z.array(z.string().min(1)).min(1)).optional(),
    repeat: z.number().int().positive().max(100).default(1),
  }),
]);
export type QueryDef = z.infer<typeof QuerySchema>;

export const ThemeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  engine: z.string().optional(),
  profile: z.string().optional(),
  browser: z.string().optional(),
  headless: z.boolean().optional(),
  delayBetweenSearchesMs: DelayRangeSchema.optional(),
  screenshot: z.enum(['none', 'after', 'both']).optional(),
  queries: z.array(QuerySchema).min(1),
});
export type Theme = z.infer<typeof ThemeSchema>;

export const SearchFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    defaults: SearchDefaultsSchema.prefault({}),
    themes: z.array(ThemeSchema).min(1),
  })
  .superRefine((file, ctx) => {
    const seen = new Set<string>();
    file.themes.forEach((theme, i) => {
      if (seen.has(theme.id)) {
        ctx.addIssue({ code: 'custom', path: ['themes', i, 'id'], message: `id de tema duplicado: "${theme.id}"` });
      }
      seen.add(theme.id);
    });
  });
export type SearchFile = z.infer<typeof SearchFileSchema>;

/** Uma pesquisa já resolvida: variáveis expandidas, herança aplicada. */
export interface ResolvedSearch {
  themeId: string;
  themeName: string;
  query: string;
  engine: string;
  browser: string;
  profile: string;
  headless: boolean;
  screenshot: 'none' | 'after' | 'both';
  maxRetries: number;
  delayRange: [number, number];
}

/* ─────────────────────────  PERFIS E NAVEGADORES  ───────────────────────── */

export const BROWSER_IDS = ['brave', 'chrome', 'edge'] as const;
export type BrowserId = (typeof BROWSER_IDS)[number] | string;

export const ProfileStatusSchema = z.enum(['never_authenticated', 'authenticated', 'session_expired']);
export type ProfileStatus = z.infer<typeof ProfileStatusSchema>;

export const ProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  browserId: z.string().min(1),
  userDataDir: z.string().min(1),
  status: ProfileStatusSchema.default('never_authenticated'),
  lastUsedAt: z.string().nullable().default(null),
  createdAt: z.string(),
});
export type Profile = z.infer<typeof ProfileSchema>;

/* ─────────────────────────  EXECUÇÕES  ───────────────────────── */

export const RUN_STATUSES = ['pending', 'running', 'success', 'failed', 'blocked', 'cancelled', 'timeout'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export interface StepResult {
  index: number;
  type: FlowStepType;
  status: 'success' | 'failed' | 'skipped';
  /** Índice do candidato que resolveu. > 0 significa passo degradado (RF-042). */
  selectorUsed: number | null;
  degraded: boolean;
  attempts: number;
  durationMs: number;
  error?: string;
}

export interface RunResult {
  runId: string;
  kind: 'flow' | 'search';
  status: RunStatus;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  artifactsDir: string;
  steps: StepResult[];
  /** True se algum passo resolveu por fallback — dispara RN-006. */
  degraded: boolean;
  error?: string;
  blockReason?: 'captcha' | 'login_wall' | 'unknown';
}

/* ─────────────────────────  CONFIGURAÇÃO GERAL  ───────────────────────── */

export const AppConfigSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  defaultHeadless: z.boolean().default(true),
  defaultTimeoutMs: z.number().int().positive().default(15_000),
  defaultMaxRetries: z.number().int().min(0).max(10).default(2),
  defaultViewport: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).default({ width: 1366, height: 768 }),
  /** Caminhos de executável informados manualmente, sobrepondo a detecção (RF-002). */
  browserPaths: z.record(z.string(), z.string()).default({}),
  /** Teto global de navegadores simultâneos (RF-051). */
  maxConcurrentBrowsers: z.number().int().min(1).max(16).default(3),
  /** Timeout global por job — impede worker travado de segurar a fila (RNF-014). */
  jobTimeoutMs: z.number().int().positive().default(15 * 60_000),
  /** Ociosidade antes de encerrar navegador reaproveitado (RF-055). */
  browserIdleTtlMs: z.number().int().min(0).default(60_000),
  /**
   * Delay padrão entre passos de fluxo, sorteado dentro da faixa (RN-008).
   * `[0, 0]` (padrão) desliga o recurso — o motor já espera cada elemento
   * ficar pronto antes de interagir; isto é só para pacing deliberado.
   */
  defaultStepDelayMs: DelayRangeSchema.default([0, 0]),
  /**
   * Espaçamento entre o fim de um job e o início do próximo NO MESMO PERFIL,
   * sorteado dentro da faixa (RN-008). Distinto do mutex de RN-001: aquele
   * impede execução simultânea; este pausa entre execuções sucessivas da
   * mesma conta, para não encadeá-las sem intervalo algum. `[0, 0]` (padrão)
   * desliga o recurso.
   */
  jobDelayMs: DelayRangeSchema.default([0, 0]),
  retention: z
    .object({
      maxAgeDays: z.number().int().positive().default(30),
      maxRuns: z.number().int().positive().default(200),
      /** Execuções com falha/bloqueio retêm pelo dobro do prazo (RN-011). */
      failureMultiplier: z.number().min(1).default(2),
      diskWarningMb: z.number().int().positive().default(5_000),
    })
    .prefault({}),
  captureTrace: z.boolean().default(true),
  /** Desliga a checagem de parede de login, mantendo a de CAPTCHA (RF-046). */
  detectLoginWall: z.boolean().default(true),
});
export type AppConfig = z.infer<typeof AppConfigSchema>;

/* ─────────────────────────  AGENDAMENTO  ───────────────────────── */

/**
 * O que um agendamento dispara. Reaproveita exatamente os mesmos caminhos de
 * `Maestro.enqueueFlow`/`enqueueSearches` — um agendamento não é um modo de
 * execução paralelo, é só mais um produtor de jobs para a fila existente.
 *
 * Note a ausência de `headless`: execução agendada é sempre headless (RN-007).
 * A sessão do Windows pode estar bloqueada quando o disparo acontece, e
 * automação visível não funciona nesse cenário — não há opção "headed" aqui
 * porque não existe forma segura de honrá-la sem supervisão humana.
 */
export const ScheduleTargetSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('flow'),
    flowId: z.string().min(1),
    profile: z.string().min(1),
    variables: z.record(z.string(), z.string()).default({}),
  }),
  z.object({
    kind: z.literal('search'),
    searchFile: z.string().min(1),
    themeIds: z.array(z.string()).optional(),
    /** Sorteia esse número de pesquisas do total já filtrado, sem repetir dentro do disparo — omitido roda todas. */
    sampleSize: z.number().int().positive().optional(),
  }),
]);
export type ScheduleTarget = z.infer<typeof ScheduleTargetSchema>;

export const ScheduleSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** Padrão cron de 5 ou 6 campos (node-cron aceita segundos opcionais). */
  cron: z.string().min(1).refine((expr) => validateCronExpression(expr), { message: 'expressão cron inválida' }),
  enabled: z.boolean().default(true),
  target: ScheduleTargetSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  lastRunAt: z.string().nullable().default(null),
  lastStatus: z.string().nullable().default(null),
  /**
   * Minuto (ISO truncado) do último disparo — idempotência do tick: dois
   * invocações de `schedule tick` que caiam no mesmo minuto não disparam o
   * mesmo agendamento duas vezes.
   */
  lastFiredKey: z.string().nullable().default(null),
});
export type Schedule = z.infer<typeof ScheduleSchema>;
