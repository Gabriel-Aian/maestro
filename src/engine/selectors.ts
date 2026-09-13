import type { Frame, Locator, Page } from 'playwright-core';
import type { FrameRef, SelectorCandidate } from '../types/schema.js';
import { logger } from '../logger.js';

export class ElementNotResolvedError extends Error {
  constructor(candidates: SelectorCandidate[], readonly details: string[]) {
    super(
      `Nenhum dos ${candidates.length} seletores resolveu um elemento único e interagível.\n` +
        details.map((d, i) => `  [${i}] ${d}`).join('\n'),
    );
    this.name = 'ElementNotResolvedError';
  }
}

export interface ResolvedElement {
  locator: Locator;
  /** Índice do candidato que funcionou. > 0 significa passo degradado (RF-042). */
  candidateIndex: number;
}

/** Converte um candidato em locator do Playwright. */
export function toLocator(scope: Frame | Page, candidate: SelectorCandidate): Locator {
  switch (candidate.kind) {
    case 'testId':
      return scope.locator(`[${candidate.attribute}="${escapeAttr(candidate.value)}"]`);
    case 'css':
      return scope.locator(candidate.value);
    case 'role':
      return scope.getByRole(candidate.value as Parameters<typeof scope.getByRole>[0], {
        name: candidate.name,
        exact: candidate.exact,
      });
    case 'label':
      return scope.getByLabel(candidate.value);
    case 'placeholder':
      return scope.getByPlaceholder(candidate.value);
    case 'text':
      return scope.getByText(candidate.value, { exact: candidate.exact });
    case 'xpath':
      return scope.locator(`xpath=${candidate.value}`);
  }
}

function escapeAttr(value: string): string {
  return value.replace(/"/g, '\\"');
}

export function describeCandidate(candidate: SelectorCandidate): string {
  if (candidate.kind === 'role') {
    return `role=${candidate.value}${candidate.name ? `[name="${candidate.name}"]` : ''}`;
  }
  return `${candidate.kind}=${candidate.value}`;
}

/**
 * Orçamento de tempo por candidato.
 *
 * O primeiro candidato recebe o timeout cheio porque é ele que absorve a espera
 * natural de carregamento da página. Os demais recebem uma sondagem curta: se
 * chegamos neles, a página já renderizou e o elemento existe ou não existe —
 * esperar 15s em cada um dos oito candidatos transformaria uma falha em dois
 * minutos de espera inútil.
 */
function budgetFor(candidateIndex: number, totalTimeoutMs: number): number {
  return candidateIndex === 0 ? totalTimeoutMs : Math.min(2_500, Math.max(500, totalTimeoutMs / 6));
}

/**
 * Percorre os candidatos na ordem definida e devolve o primeiro que resolver
 * exatamente um elemento visível e habilitado (RN-005).
 *
 * Resolver zero ou mais de um elemento não é erro fatal: passa-se ao próximo
 * candidato. Isso é o que permite um fluxo sobreviver a uma mudança de layout
 * que quebrou apenas o seletor primário.
 */
export async function resolveElement(
  scope: Frame | Page,
  candidates: SelectorCandidate[],
  totalTimeoutMs: number,
  opts: { requireEnabled?: boolean } = {},
): Promise<ResolvedElement> {
  const requireEnabled = opts.requireEnabled ?? true;
  const failures: string[] = [];

  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    if (!candidate) continue;

    const label = describeCandidate(candidate);
    const timeout = budgetFor(i, totalTimeoutMs);

    try {
      const locator = toLocator(scope, candidate);
      await locator.first().waitFor({ state: 'attached', timeout });

      const count = await locator.count();
      if (count !== 1) {
        failures.push(`${label} → resolveu ${count} elementos (esperado exatamente 1)`);
        continue;
      }
      if (!(await locator.isVisible())) {
        failures.push(`${label} → elemento existe mas não está visível`);
        continue;
      }
      if (requireEnabled && !(await locator.isEnabled())) {
        failures.push(`${label} → elemento visível mas desabilitado`);
        continue;
      }

      if (i > 0) {
        logger.warn({ candidateIndex: i, selector: label }, 'Seletor primário falhou; usando fallback (passo degradado)');
      }
      return { locator, candidateIndex: i };
    } catch (err) {
      const reason = err instanceof Error && err.name === 'TimeoutError' ? 'não encontrado no tempo limite' : String(err).slice(0, 120);
      failures.push(`${label} → ${reason}`);
    }
  }

  throw new ElementNotResolvedError(candidates, failures);
}

/**
 * Navega até o frame descrito pelo caminho gravado (RF-024).
 * A URL é o critério primário; o índice é o fallback, porque aplicações que
 * recriam iframes mudam a URL com token de sessão mas preservam a posição.
 */
export async function resolveFrame(page: Page, path: FrameRef[], timeoutMs: number): Promise<Frame> {
  let current: Frame = page.mainFrame();
  if (path.length === 0) return current;

  const deadline = Date.now() + timeoutMs;

  for (const ref of path) {
    let matched: Frame | undefined;

    while (Date.now() < deadline) {
      const children = current.childFrames();
      matched =
        children.find((f) => f.url() === ref.url) ??
        (ref.name ? children.find((f) => f.name() === ref.name) : undefined) ??
        children.find((f) => sameOrigin(f.url(), ref.url)) ??
        children[ref.index];
      if (matched) break;
      await new Promise((r) => setTimeout(r, 150));
    }

    if (!matched) {
      throw new Error(`Frame não encontrado no caminho gravado: ${ref.url} (índice ${ref.index}).`);
    }
    current = matched;
  }

  return current;
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}
