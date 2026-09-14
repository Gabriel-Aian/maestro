import { randomUUID } from 'node:crypto';
import type { BrowserContext, Frame, Page } from 'playwright-core';
import { NON_RETRYABLE_STEPS, type AppConfig, type Flow, type FlowStep, type RunResult, type StepResult } from '../types/schema.js';
import { resolveElement, resolveFrame, ElementNotResolvedError } from './selectors.js';
import { detectBlock, type BlockReason, type DetectBlockOptions } from './blockDetection.js';
import { RunArtifacts } from './artifacts.js';
import { computeStepDelay } from './timing.js';
import { registerSecret, runLogger } from '../logger.js';

export class BlockedError extends Error {
  constructor(readonly reason: BlockReason, readonly evidence: string) {
    super(`Execução bloqueada (${reason}): ${evidence}`);
    this.name = 'BlockedError';
  }
}

export class MissingVariableError extends Error {
  constructor(names: string[]) {
    super(
      `Variáveis sem valor: ${names.join(', ')}. ` +
        `O fluxo é abortado antes de abrir o navegador para não desperdiçar uma execução (RN-015).`,
    );
    this.name = 'MissingVariableError';
  }
}

/**
 * Resolve as variáveis do fluxo contra os valores informados (RN-015).
 * Deve ser chamada ANTES de adquirir o navegador — abortar aqui evita abrir
 * uma instância do Chromium para depois descobrir que falta um valor.
 */
export function resolveVariables(flow: Flow, provided: Record<string, string> = {}): Record<string, string> {
  const resolved: Record<string, string> = {};
  const missing: string[] = [];

  for (const variable of flow.variables) {
    const value = provided[variable.name] ?? variable.default;
    if (value === '' && !variable.default) {
      missing.push(variable.name);
      continue;
    }
    resolved[variable.name] = value;
    if (variable.sensitive) registerSecret(value);
  }

  // Referências usadas nos passos mas não declaradas também bloqueiam.
  const declared = new Set(flow.variables.map((v) => v.name));
  for (const step of flow.steps) {
    if (step.type !== 'type') continue;
    for (const match of step.value.matchAll(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g)) {
      const name = match[1]!;
      if (!declared.has(name) && provided[name] === undefined) missing.push(name);
    }
  }

  if (missing.length > 0) throw new MissingVariableError([...new Set(missing)]);
  return resolved;
}

function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (_, name: string) => vars[name] ?? '');
}

export interface ReplayOptions {
  flow: Flow;
  context: BrowserContext;
  config: AppConfig;
  variables?: Record<string, string>;
  runId?: string;
  /** Modo de teste: não grava manifesto no histórico de produção (RF-039). */
  dryRun?: boolean;
  /** Modo passo a passo: retorna false para interromper antes do passo (RF-038). */
  beforeStep?: (step: FlowStep, index: number, total: number) => Promise<boolean> | boolean;
  onStepResult?: (result: StepResult) => void;
}

/** Passos que tipicamente disparam navegação e justificam checar bloqueio. */
const NAVIGATION_STEPS = new Set(['navigate', 'click', 'doubleClick', 'press']);

/**
 * Aba ativa da execução.
 *
 * Precisa ser mutável e compartilhada entre os passos: um clique pode abrir
 * outra aba, e todos os passos seguintes têm de executar nela até uma troca
 * explícita. Guardar a página em uma variável fixa era a causa de o fluxo
 * "se perder" depois de um redirecionamento que abre nova janela.
 */
interface ReplaySession {
  context: BrowserContext;
  page: Page;
}

/** Compara origem + caminho, ignorando query e fragmento. */
function samePage(a: string, b: string): boolean {
  try {
    const first = new URL(a);
    const second = new URL(b);
    return first.origin === second.origin && first.pathname.replace(/\/$/, '') === second.pathname.replace(/\/$/, '');
  } catch {
    return false;
  }
}

/**
 * Localiza a aba alvo. A URL é o critério primário porque o índice varia entre
 * execuções conforme popups abrem e fecham em ordens diferentes; o índice fica
 * como desempate. Popups são assíncronos, então há espera ativa.
 */
async function resolveTab(
  session: ReplaySession,
  target: { tabIndex: number; matchUrl?: string; waitForNew: boolean },
  timeoutMs: number,
): Promise<Page> {
  const deadline = Date.now() + (target.waitForNew ? timeoutMs : Math.min(timeoutMs, 2_000));

  for (;;) {
    const pages = session.context.pages().filter((p) => !p.isClosed());

    if (target.matchUrl) {
      const byUrl = pages.find((p) => samePage(p.url(), target.matchUrl!));
      if (byUrl) return byUrl;
    }

    const byIndex = pages[target.tabIndex];
    if (byIndex && (!target.waitForNew || pages.length > 1)) return byIndex;

    if (Date.now() >= deadline) {
      const abertas = pages.map((p, i) => `[${i}] ${p.url()}`).join(', ') || 'nenhuma';
      throw new Error(
        `Aba alvo não encontrada (índice ${target.tabIndex}` +
          `${target.matchUrl ? `, URL ${target.matchUrl}` : ''}). Abas abertas: ${abertas}.`,
      );
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

export async function replayFlow(options: ReplayOptions): Promise<RunResult> {
  const { flow, context, config } = options;
  const runId = options.runId ?? `run-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 6)}`;
  const log = runLogger(runId);
  const startedAt = new Date();

  const variables = resolveVariables(flow, options.variables ?? {});

  const artifacts = new RunArtifacts(runId);
  artifacts.init();

  const session: ReplaySession = { context, page: context.pages()[0] ?? (await context.newPage()) };
  await session.page.setViewportSize(flow.viewport);

  const steps: StepResult[] = [];
  let status: RunResult['status'] = 'success';
  let error: string | undefined;
  let blockReason: BlockReason | undefined;

  await artifacts.startTrace(context, config.captureTrace);

  try {
    await session.page.goto(flow.startUrl, { waitUntil: 'domcontentloaded', timeout: config.defaultTimeoutMs * 2 });
    await assertNotBlocked(session.page, { intendedUrl: flow.startUrl, detectLoginWall: config.detectLoginWall });

    // Evidência do estado inicial, antes de qualquer interação (RF-064).
    await artifacts.screenshot(session.page, 'before');

    for (const [i, step] of flow.steps.entries()) {
      if (options.beforeStep) {
        const proceed = await options.beforeStep(step, i, flow.steps.length);
        if (!proceed) {
          status = 'cancelled';
          error = 'Execução interrompida pelo usuário no modo passo a passo.';
          break;
        }
      }

      const stepDelay = computeStepDelay(i, step, flow, config);
      if (stepDelay > 0 && !session.page.isClosed()) await session.page.waitForTimeout(stepDelay);

      const result = await runStep(session, step, variables, config, artifacts, log);
      steps.push(result);
      options.onStepResult?.(result);

      if (result.status === 'failed' && step.onFailure === 'abort') {
        status = 'failed';
        error = result.error;
        break;
      }
    }
  } catch (err) {
    if (err instanceof BlockedError) {
      status = 'blocked';
      blockReason = err.reason;
      error = err.message;
      log.warn({ reason: err.reason }, 'Execução encerrada por bloqueio');
    } else {
      status = 'failed';
      error = err instanceof Error ? err.message : String(err);
      log.error({ err }, 'Falha não tratada na execução');
    }
  }

  // A evidência final é capturada mesmo em falha: o estado em que a página
  // parou costuma ser mais informativo que a mensagem de erro. Se a aba corrente
  // foi fechada, cai para qualquer uma que ainda esteja viva.
  if (session.page.isClosed()) {
    const alive = context.pages().find((p) => !p.isClosed());
    if (alive) session.page = alive;
  }
  if (!session.page.isClosed()) await artifacts.screenshot(session.page, 'after');
  await artifacts.stopTrace(context);

  const finishedAt = new Date();
  const degraded = steps.some((s) => s.degraded);

  const result: RunResult = {
    runId,
    kind: 'flow',
    status,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    artifactsDir: artifacts.dir,
    steps,
    degraded,
    error,
    blockReason,
  };

  if (!options.dryRun) artifacts.writeManifest(result);

  log.info(
    { status, steps: steps.length, degraded, durationMs: result.durationMs },
    degraded ? 'Execução concluída com passos degradados — fluxo requer revisão (RN-006)' : 'Execução concluída',
  );

  return result;
}

/* ─────────────────────────  EXECUÇÃO DE UM PASSO  ───────────────────────── */

async function runStep(
  session: ReplaySession,
  step: FlowStep,
  vars: Record<string, string>,
  config: AppConfig,
  artifacts: RunArtifacts,
  log: ReturnType<typeof runLogger>,
): Promise<StepResult> {
  const startedAt = Date.now();
  // Asserção que falha vai falhar de novo: não há o que reexecutar (RN-012).
  const maxAttempts = NON_RETRYABLE_STEPS.has(step.type) ? 1 : step.maxRetries + 1;

  let lastError: string | undefined;
  let candidateIndex: number | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      candidateIndex = await performStep(session, step, vars, config);

      if (step.screenshot && !session.page.isClosed()) await artifacts.screenshot(session.page, `step-${step.index}`);

      return {
        index: step.index,
        type: step.type,
        status: 'success',
        selectorUsed: candidateIndex,
        degraded: (candidateIndex ?? 0) > 0,
        attempts: attempt,
        durationMs: Date.now() - startedAt,
      };
    } catch (err) {
      if (err instanceof BlockedError) throw err;

      lastError = err instanceof Error ? err.message : String(err);

      // Elemento sumiu pode ser sintoma de desafio/redirecionamento, não de
      // seletor errado — vale conferir antes de gastar as tentativas restantes.
      if (!session.page.isClosed() && (err instanceof ElementNotResolvedError || NAVIGATION_STEPS.has(step.type))) {
        await assertNotBlocked(session.page, { intendedUrl: step.observedUrl, detectLoginWall: config.detectLoginWall });
      }

      if (attempt < maxAttempts) {
        const backoff = Math.min(8_000, 500 * 2 ** (attempt - 1));
        log.warn({ step: step.index, type: step.type, attempt, backoff }, 'Passo falhou; reexecutando');
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
  }

  if (!session.page.isClosed()) await artifacts.captureFailure(session.page, step.index);
  log.error({ step: step.index, type: step.type, error: lastError }, 'Passo esgotou as tentativas');

  return {
    index: step.index,
    type: step.type,
    status: step.onFailure === 'skip' ? 'skipped' : 'failed',
    selectorUsed: null,
    degraded: false,
    attempts: maxAttempts,
    durationMs: Date.now() - startedAt,
    error: lastError,
  };
}

/** Executa a ação e devolve o índice do candidato usado, quando aplicável. */
async function performStep(
  session: ReplaySession,
  step: FlowStep,
  vars: Record<string, string>,
  config: AppConfig,
): Promise<number | null> {
  const timeout = step.timeoutMs || config.defaultTimeoutMs;
  const page = session.page;

  switch (step.type) {
    case 'navigate': {
      const target = interpolate(step.url, vars);
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout });
      await assertNotBlocked(page, { intendedUrl: target, detectLoginWall: config.detectLoginWall });
      return null;
    }

    case 'waitForTimeout': {
      await page.waitForTimeout(step.ms);
      return null;
    }

    case 'press': {
      await page.keyboard.press(step.key);
      return null;
    }

    case 'switchTab': {
      const target = await resolveTab(
        session,
        { tabIndex: step.tabIndex, matchUrl: step.matchUrl, waitForNew: step.waitForNew },
        timeout,
      );
      await target.bringToFront().catch(() => undefined);
      // Trocar a referência da sessão é o que faz os passos seguintes rodarem
      // na aba certa; só trazer para frente não muda nada na automação.
      session.page = target;
      return null;
    }

    case 'closeTab': {
      const remaining = session.context.pages().filter((p) => p !== page && !p.isClosed());
      if (!page.isClosed()) await page.close();
      const fallback = remaining.at(-1);
      if (!fallback) throw new Error('Não há outra aba aberta para continuar após fechar a atual.');
      session.page = fallback;
      await fallback.bringToFront().catch(() => undefined);
      return null;
    }

    case 'assertUrl': {
      const actual = page.url();
      const expected = interpolate(step.expected, vars);
      if (!compare(actual, expected, step.operator)) {
        throw new Error(`URL "${actual}" não satisfaz ${step.operator} "${expected}".`);
      }
      return null;
    }

    case 'screenshot': {
      return null; // capturado pelo chamador via step.screenshot
    }

    case 'scroll': {
      if (step.target === 'document' || !step.selectors?.length) {
        await page.evaluate(({ x, y }) => window.scrollTo({ left: x, top: y, behavior: 'instant' as ScrollBehavior }), {
          x: step.x,
          y: step.y,
        });
        return null;
      }
      const scope = await scopeFor(page, step, timeout);
      const { locator, candidateIndex } = await resolveElement(scope, step.selectors, timeout, { requireEnabled: false });
      await locator.evaluate((el, { x, y }) => {
        el.scrollLeft = x;
        el.scrollTop = y;
      }, { x: step.x, y: step.y });
      return candidateIndex;
    }

    default:
      break;
  }

  // A partir daqui todos os passos dependem de um elemento resolvido.
  const scope = await scopeFor(page, step, timeout);

  switch (step.type) {
    case 'click': {
      const { locator, candidateIndex } = await resolveElement(scope, step.selectors, timeout);
      await locator.click({ button: step.button, timeout });
      return candidateIndex;
    }

    case 'doubleClick': {
      const { locator, candidateIndex } = await resolveElement(scope, step.selectors, timeout);
      await locator.dblclick({ timeout });
      return candidateIndex;
    }

    case 'type': {
      const { locator, candidateIndex } = await resolveElement(scope, step.selectors, timeout);
      const value = interpolate(step.value, vars);
      // `fill()` define o valor inteiro de uma vez, sem nenhum evento
      // intermediário visível — pedido explícito do usuário: poder observar a
      // digitação acontecendo, tecla por tecla, é o que torna debugar um
      // fluxo em modo visível (`--headed`) praticável. `clearFirst` só decide
      // se o campo é esvaziado antes; a digitação em si é sempre simulada.
      if (step.clearFirst) await locator.fill('', { timeout });
      await locator.pressSequentially(value, { timeout, delay: 25 });
      if (step.pressEnter) await locator.press('Enter');
      return candidateIndex;
    }

    case 'select': {
      const { locator, candidateIndex } = await resolveElement(scope, step.selectors, timeout);
      await locator.selectOption(step.values.map((v) => interpolate(v, vars)), { timeout });
      return candidateIndex;
    }

    case 'check': {
      const { locator, candidateIndex } = await resolveElement(scope, step.selectors, timeout);
      await locator.setChecked(step.checked, { timeout });
      return candidateIndex;
    }

    case 'waitForElement': {
      const { locator, candidateIndex } = await resolveElement(scope, step.selectors, timeout, { requireEnabled: false });
      await locator.waitFor({ state: step.state, timeout });
      return candidateIndex;
    }

    case 'assertText': {
      const { locator, candidateIndex } = await resolveElement(scope, step.selectors, timeout, { requireEnabled: false });
      const actual = (await locator.innerText({ timeout })).replace(/\s+/g, ' ').trim();
      const expected = interpolate(step.expected, vars);
      if (!compare(actual, expected, step.operator)) {
        throw new Error(`Texto "${actual.slice(0, 120)}" não satisfaz ${step.operator} "${expected}".`);
      }
      return candidateIndex;
    }

    default:
      throw new Error(`Tipo de passo não suportado: ${(step as FlowStep).type}`);
  }
}

async function scopeFor(page: Page, step: FlowStep, timeout: number): Promise<Frame> {
  return resolveFrame(page, step.frame, Math.min(timeout, 10_000));
}

function compare(actual: string, expected: string, operator: 'contains' | 'equals' | 'matches'): boolean {
  switch (operator) {
    case 'contains':
      return actual.toLowerCase().includes(expected.toLowerCase());
    case 'equals':
      return actual === expected;
    case 'matches':
      return new RegExp(expected).test(actual);
  }
}

async function assertNotBlocked(page: Page, options: DetectBlockOptions = {}): Promise<void> {
  const detection = await detectBlock(page, options);
  if (detection.blocked) {
    throw new BlockedError(detection.reason ?? 'unknown', detection.evidence ?? 'sem evidência');
  }
}
