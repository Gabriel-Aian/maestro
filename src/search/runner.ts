import { randomUUID } from 'node:crypto';
import type { BrowserContext, Page } from 'playwright-core';
import type { AppConfig, ResolvedSearch, RunResult, StepResult } from '../types/schema.js';
import { getEngine } from './engines.js';
import { detectBlock } from '../engine/blockDetection.js';
import { RunArtifacts } from '../engine/artifacts.js';
import { randomDelay } from '../engine/timing.js';
import { runLogger } from '../logger.js';

export interface SearchBatchOptions {
  searches: ResolvedSearch[];
  context: BrowserContext;
  config: AppConfig;
  runId?: string;
  /** 'url' navega direto para a página de resultados; 'type' digita na caixa. */
  submitMode?: 'url' | 'type';
  signal?: AbortSignal;
  onProgress?: (done: number, total: number, search: ResolvedSearch, status: string) => void;
}

/**
 * Executa um lote de pesquisas (RF-016 a RF-020).
 *
 * Um tema que encontra bloqueio é interrompido por inteiro: continuar
 * disparando os termos restantes do mesmo tema, no mesmo perfil, só aprofunda
 * a detecção sem chance de sucesso (RF-020, RN-004).
 */
export async function runSearchBatch(options: SearchBatchOptions): Promise<RunResult> {
  const { searches, context, config } = options;
  const runId = options.runId ?? `run-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 6)}`;
  const log = runLogger(runId);
  const startedAt = new Date();

  const artifacts = new RunArtifacts(runId);
  artifacts.init();

  const page = context.pages()[0] ?? (await context.newPage());
  const steps: StepResult[] = [];
  const blockedThemes = new Set<string>();

  let status: RunResult['status'] = 'success';
  let blockReason: RunResult['blockReason'];
  let error: string | undefined;

  for (const [i, search] of searches.entries()) {
    if (options.signal?.aborted) {
      status = 'cancelled';
      error = 'Lote cancelado.';
      break;
    }

    if (blockedThemes.has(search.themeId)) {
      steps.push(skipped(i, `Tema "${search.themeName}" bloqueado anteriormente neste lote.`));
      continue;
    }

    if (i > 0) {
      await page.waitForTimeout(randomDelay(search.delayRange));
    }

    const result = await runSingleSearch(page, search, i, artifacts, config);
    steps.push(result);
    options.onProgress?.(i + 1, searches.length, search, result.status);

    if (result.error?.startsWith('BLOQUEADO')) {
      blockedThemes.add(search.themeId);
      status = 'blocked';
      blockReason = result.error.includes('login_wall') ? 'login_wall' : 'captcha';
      log.warn({ theme: search.themeId, query: search.query }, 'Tema interrompido por bloqueio');
    } else if (result.status === 'failed' && status === 'success') {
      status = 'failed';
      error = result.error;
    }
  }

  const finishedAt = new Date();
  const result: RunResult = {
    runId,
    kind: 'search',
    status,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    artifactsDir: artifacts.dir,
    steps,
    degraded: false,
    error,
    blockReason,
  };

  artifacts.writeManifest(result);
  log.info({ status, total: searches.length, ok: steps.filter((s) => s.status === 'success').length }, 'Lote de pesquisas concluído');
  return result;
}

async function runSingleSearch(
  page: Page,
  search: ResolvedSearch,
  index: number,
  artifacts: RunArtifacts,
  config: AppConfig,
): Promise<StepResult> {
  const startedAt = Date.now();
  const engine = getEngine(search.engine);
  const maxAttempts = search.maxRetries + 1;
  let lastError: string | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      if (search.screenshot === 'both') {
        await page.goto(engine.homeUrl, { waitUntil: 'domcontentloaded', timeout: config.defaultTimeoutMs });
        await artifacts.screenshot(page, `search-${index}-before`);
      }

      await page.goto(engine.buildUrl(search.query), {
        waitUntil: 'domcontentloaded',
        timeout: config.defaultTimeoutMs * 2,
      });

      const detection = await detectBlock(page, {
        intendedUrl: engine.buildUrl(search.query),
        detectLoginWall: config.detectLoginWall,
      });
      if (detection.blocked) {
        return {
          index,
          type: 'navigate',
          status: 'failed',
          selectorUsed: null,
          degraded: false,
          attempts: attempt,
          durationMs: Date.now() - startedAt,
          error: `BLOQUEADO (${detection.reason}): ${detection.evidence}`,
        };
      }

      await page.locator(engine.resultsSelector).first().waitFor({ state: 'visible', timeout: config.defaultTimeoutMs });

      if (search.screenshot !== 'none') {
        await artifacts.screenshot(page, `search-${index}-after`);
      }

      return {
        index,
        type: 'navigate',
        status: 'success',
        selectorUsed: null,
        degraded: false,
        attempts: attempt,
        durationMs: Date.now() - startedAt,
      };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt < maxAttempts) await page.waitForTimeout(Math.min(5_000, 800 * 2 ** (attempt - 1)));
    }
  }

  return {
    index,
    type: 'navigate',
    status: 'failed',
    selectorUsed: null,
    degraded: false,
    attempts: maxAttempts,
    durationMs: Date.now() - startedAt,
    error: lastError,
  };
}

function skipped(index: number, reason: string): StepResult {
  return {
    index,
    type: 'navigate',
    status: 'skipped',
    selectorUsed: null,
    degraded: false,
    attempts: 0,
    durationMs: 0,
    error: reason,
  };
}
