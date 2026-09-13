import { describe, it, expect } from 'vitest';
import type { BrowserContext, Page } from 'playwright-core';
import { runSearchBatch } from '../src/search/runner.js';
import { AppConfigSchema, type ResolvedSearch } from '../src/types/schema.js';

/**
 * `runner.ts` não tinha nenhuma cobertura antes — `runSearchBatch` sempre
 * exigiu um navegador real. Um Page/Context falsos (mesmo espírito de
 * `blockDetection.test.ts`) bastam para cobrir a lógica pura: montagem do
 * `StepResult`, corte de tema bloqueado, e o `note` com a query de fato
 * pesquisada (sem ele, nenhuma tela mostra qual pesquisa rodou em cada
 * passo — motivo de a `note` ter sido adicionada).
 */
function locatorStub() {
  const stub = {
    first: () => stub,
    waitFor: async () => undefined,
    innerText: async () => '',
  };
  return stub;
}

function fakePage(): Page {
  const page = {
    url: () => 'https://www.google.com/search?q=x',
    goto: async () => null,
    locator: () => locatorStub(),
    frames: () => [],
  };
  return page as unknown as Page;
}

function fakeContext(page: Page): BrowserContext {
  return { pages: () => [page] } as unknown as BrowserContext;
}

function search(overrides: Partial<ResolvedSearch> = {}): ResolvedSearch {
  return {
    themeId: 't1',
    themeName: 'Tema',
    query: 'consulta de teste',
    engine: 'google',
    browser: 'chrome',
    profile: 'conta-1',
    headless: true,
    screenshot: 'none',
    maxRetries: 0,
    delayRange: [0, 0],
    ...overrides,
  };
}

describe('runSearchBatch', () => {
  it('registra a query pesquisada em `note`, mesmo quando a pesquisa é bem-sucedida', async () => {
    const page = fakePage();
    const result = await runSearchBatch({ searches: [search()], context: fakeContext(page), config: AppConfigSchema.parse({}) });
    expect(result.status).toBe('success');
    expect(result.steps[0]).toMatchObject({ status: 'success', note: 'consulta de teste' });
  });

  it('registra `note` também quando a pesquisa falha por bloqueio', async () => {
    const page = fakePage();
    // Texto de desafio no body faz `detectBlock` bloquear (ver blockDetection.ts).
    page.locator = ((sel: string) => (sel === 'body' ? { ...locatorStub(), innerText: async () => 'unusual traffic' } : locatorStub())) as Page['locator'];
    const result = await runSearchBatch({ searches: [search({ query: 'bloqueada' })], context: fakeContext(page), config: AppConfigSchema.parse({}) });
    expect(result.status).toBe('blocked');
    expect(result.blockReason).toBe('captcha');
    expect(result.steps[0]).toMatchObject({ status: 'failed', note: 'bloqueada' });
  });

  it('pula (com `note` preservado) o restante de um tema já bloqueado no mesmo lote', async () => {
    const page = fakePage();
    page.locator = ((sel: string) => (sel === 'body' ? { ...locatorStub(), innerText: async () => 'unusual traffic' } : locatorStub())) as Page['locator'];
    const searches = [search({ query: 'primeira' }), search({ query: 'segunda' })];
    const result = await runSearchBatch({ searches, context: fakeContext(page), config: AppConfigSchema.parse({}) });
    expect(result.steps[0]).toMatchObject({ status: 'failed', note: 'primeira' });
    expect(result.steps[1]).toMatchObject({ status: 'skipped', note: 'segunda' });
  });
});
