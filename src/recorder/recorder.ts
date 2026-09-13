import { randomUUID } from 'node:crypto';
import type { BrowserContext, Frame, Page } from 'playwright-core';
import { injectedRecorder, type RawCandidate, type RawEvent } from './injected.js';
import { FlowSchema, type Flow, type FlowStep, type SelectorCandidate, type FrameRef } from '../types/schema.js';
import { logger } from '../logger.js';

export interface RecordingOptions {
  context: BrowserContext;
  name: string;
  startUrl: string;
  viewport?: { width: number; height: number };
}

export interface TimedEvent extends RawEvent {
  frame: FrameRef[];
  /** Índice da aba, em ordem de abertura, onde o evento aconteceu. */
  pageIndex: number;
  /** Marcador interno para eventos sintéticos de ciclo de vida de aba. */
  lifecycle?: 'tab-opened' | 'tab-closed';
}

/** Intervalo abaixo do qual um clique é considerado apenas foco para digitar. */
const FOCUS_CLICK_WINDOW_MS = 1_500;
/** Intervalo abaixo do qual uma navegação é atribuída à ação anterior. */
const IMPLICIT_NAV_WINDOW_MS = 2_500;

export class RecordingSession {
  private readonly events: TimedEvent[] = [];
  /** Ordem de abertura das abas — é o que dá identidade estável a cada uma. */
  private readonly pageOrder: Page[] = [];
  private paused = false;
  private stopped = false;
  private readonly startedAt = new Date().toISOString();

  private constructor(
    private readonly context: BrowserContext,
    private readonly page: Page,
    private readonly options: RecordingOptions,
  ) {}

  /**
   * Inicia uma sessão de gravação (RF-021, RF-022).
   * O contexto precisa ter sido aberto em modo visível — gravar headless não
   * faz sentido, já que a captura depende da interação real do usuário.
   */
  static async start(options: RecordingOptions): Promise<RecordingSession> {
    const { context, startUrl } = options;
    const page = context.pages()[0] ?? (await context.newPage());
    const session = new RecordingSession(context, page, options);

    // exposeBinding registra a função em todos os frames, inclusive iframes
    // criados depois — condição para o RF-024.
    await context.exposeBinding('__maestroRecord', (source, payload: string) => {
      session.onRawEvent(source.frame, payload);
    });

    await context.addInitScript(injectedRecorder);

    session.trackPage(page);

    // Abas abertas por target=_blank ou window.open precisam ser rastreadas: sem
    // isso, os passos gravados nelas seriam reproduzidos contra a aba errada.
    context.on('page', (opened) => {
      if (session.stopped) return;
      session.trackPage(opened);
      session.pushLifecycle('tab-opened', opened);
    });

    await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
    logger.info({ name: options.name, startUrl }, 'Gravação iniciada');
    return session;
  }

  /** Registra a aba e liga os observadores de navegação e fechamento. */
  private trackPage(page: Page): void {
    if (this.pageOrder.includes(page)) return;
    this.pageOrder.push(page);

    page.on('framenavigated', (frame) => {
      if (this.paused || this.stopped) return;
      if (frame !== page.mainFrame()) return;
      this.onNavigation(frame.url(), page);
    });

    page.on('close', () => {
      if (this.stopped) return;
      this.pushLifecycle('tab-closed', page);
    });
  }

  private pageIndexOf(page: Page): number {
    const index = this.pageOrder.indexOf(page);
    return index >= 0 ? index : 0;
  }

  private pushLifecycle(kind: 'tab-opened' | 'tab-closed', page: Page): void {
    this.events.push({
      kind: 'click',
      selectors: [],
      url: safeUrl(page),
      t: Date.now(),
      frame: [],
      pageIndex: this.pageIndexOf(page),
      lifecycle: kind,
    });
  }

  pause(): void {
    this.paused = true;
    logger.info('Gravação pausada');
  }

  resume(): void {
    this.paused = false;
    logger.info('Gravação retomada');
  }

  get eventCount(): number {
    return this.events.length;
  }

  private onRawEvent(frame: Frame, payload: string): void {
    if (this.paused || this.stopped) return;
    try {
      const raw = JSON.parse(payload) as RawEvent;
      this.events.push({ ...raw, frame: this.frameRef(frame), pageIndex: this.pageIndexOf(frame.page()) });
    } catch (err) {
      logger.warn({ err }, 'Evento de gravação inválido descartado');
    }
  }

  /** Caminho de frames até a raiz, do mais externo para o mais interno (RF-024). */
  private frameRef(frame: Frame): FrameRef[] {
    const chain: FrameRef[] = [];
    const rootFrame = frame.page().mainFrame();
    let current: Frame | null = frame;
    while (current && current !== rootFrame) {
      const parent: Frame | null = current.parentFrame();
      const siblings = parent?.childFrames() ?? [];
      chain.unshift({
        url: current.url(),
        index: Math.max(0, siblings.indexOf(current)),
        name: current.name() || undefined,
      });
      current = parent;
    }
    return chain;
  }

  private onNavigation(url: string, page: Page): void {
    const last = this.events.at(-1);
    const now = Date.now();
    // Navegação logo após clique/submit é consequência dele, não uma ação nova.
    if (last && now - last.t < IMPLICIT_NAV_WINDOW_MS && ['click', 'submit', 'keydown'].includes(last.kind)) {
      return;
    }
    this.events.push({
      kind: 'click', // placeholder substituído na compilação
      selectors: [],
      url,
      t: now,
      frame: [],
      pageIndex: this.pageIndexOf(page),
      tagName: '__navigate__',
    });
  }

  /** Encerra a gravação e devolve o fluxo compilado (RF-030). */
  async stop(): Promise<Flow> {
    this.stopped = true;
    const steps = compileEvents(this.events);

    if (steps.length === 0) {
      throw new Error('Nenhuma interação foi capturada. O fluxo não pode ser salvo vazio (RF-030).');
    }

    const now = new Date().toISOString();
    const viewport = this.options.viewport ?? this.page.viewportSize() ?? { width: 1366, height: 768 };

    const flow = FlowSchema.parse({
      schemaVersion: 1,
      id: `flow-${randomUUID().slice(0, 8)}`,
      name: this.options.name,
      startUrl: this.options.startUrl,
      viewport,
      variables: [],
      steps,
      createdAt: this.startedAt,
      updatedAt: now,
      needsReview: false,
    } satisfies Record<string, unknown>);

    logger.info({ flowId: flow.id, steps: flow.steps.length, rawEvents: this.events.length }, 'Gravação encerrada');
    return flow;
  }
}

/* ─────────────────────────  COMPILAÇÃO  ───────────────────────── */

/**
 * Converte eventos brutos em passos de fluxo, aplicando as regras de limpeza.
 *
 * Gravação crua é sempre ruidosa: cliques de foco, digitação caractere a
 * caractere e rajadas de scroll viram um fluxo ilegível se forem direto para o
 * JSON. A coalescência aqui é o que torna o resultado utilizável sem edição
 * manual — que é o critério de aceite nº 1 do MVP.
 *
 * É uma função pura de propósito: é a lógica mais sujeita a regressão do
 * gravador e precisa ser testável sem abrir navegador (RNF-022).
 */
export function compileEvents(events: TimedEvent[]): FlowStep[] {
  const steps: FlowStep[] = [];

  // Aba onde os passos estão executando no momento da compilação, e quais abas
  // nasceram durante a gravação (popups precisam ser esperados na reprodução).
  let currentPage = 0;
  const openedDuringFlow = new Set<number>();

  const push = (partial: Partial<FlowStep>, ev: TimedEvent, previousTime: number | null): void => {
    const gap = previousTime === null ? 0 : ev.t - previousTime;
    steps.push({
      index: steps.length,
      frame: ev.frame,
      timeoutMs: 15_000,
      onFailure: 'abort' as const,
      maxRetries: 2,
      screenshot: false,
      // Intervalo observado vira sugestão para o editor, não espera automática:
      // o motor já aguarda o elemento ficar visível antes de interagir (RF-043),
      // o que cobre a maioria dos casos sem inflar o fluxo com waits fixos.
      note: gap > 3_000 ? `Intervalo observado na gravação: ${Math.round(gap / 1000)}s` : undefined,
      // Valor bruto guardado sempre (independente do limiar do `note` acima),
      // para materializeTimingSteps poder aplicar seu próprio corte depois.
      recordedGapMs: previousTime === null ? undefined : gap,
      observedUrl: ev.url,
      ...partial,
    } as FlowStep);
  };

  /**
   * Garante que a aba correta esteja ativa antes do próximo passo.
   *
   * Um clique em link com target=_blank abre outra aba, e tudo que o usuário
   * fez depois aconteceu lá. Sem materializar essa troca como passo, a
   * reprodução seguiria procurando os elementos na aba antiga — que é
   * exatamente o sintoma de fluxo "se perdendo" depois de um redirecionamento.
   */
  const ensurePage = (ev: TimedEvent, previousTime: number | null): void => {
    if (ev.pageIndex === currentPage) return;
    push(
      {
        type: 'switchTab',
        tabIndex: ev.pageIndex,
        matchUrl: ev.url,
        waitForNew: openedDuringFlow.has(ev.pageIndex),
      } as Partial<FlowStep>,
      ev,
      previousTime,
    );
    currentPage = ev.pageIndex;
  };

  for (let i = 0; i < events.length; i += 1) {
    const ev = events[i];
    if (!ev) continue;
    const next = events[i + 1];
    const previousTime = events[i - 1]?.t ?? null;

    if (ev.lifecycle === 'tab-opened') {
      // A abertura em si não vira passo: ela é consequência do clique anterior.
      // Só registramos que essa aba é um popup, para a troca saber esperar.
      openedDuringFlow.add(ev.pageIndex);
      continue;
    }

    if (ev.lifecycle === 'tab-closed') {
      if (ev.pageIndex !== currentPage) continue; // aba secundária fechando: ruído
      push({ type: 'closeTab' } as Partial<FlowStep>, ev, previousTime);
      // Força uma troca explícita no próximo passo, seja qual for a aba.
      currentPage = -1;
      continue;
    }

    ensurePage(ev, previousTime);

    if (ev.tagName === '__navigate__') {
      push({ type: 'navigate', url: ev.url } as Partial<FlowStep>, ev, previousTime);
      continue;
    }

    // Alt+Clique marca asserção em vez de gravar a interação (RF-029).
    if (ev.kind === 'click' && ev.altKey) {
      push(
        { type: 'assertText', selectors: mapCandidates(ev.selectors), operator: 'contains', expected: ev.text ?? '' } as Partial<FlowStep>,
        ev,
        previousTime,
      );
      continue;
    }

    if (ev.kind === 'click') {
      // Clique seguido de digitação no mesmo elemento é apenas foco.
      if (next && next.kind === 'input' && sameElement(ev, next) && next.t - ev.t < FOCUS_CLICK_WINDOW_MS) continue;
      if (next && next.kind === 'dblclick' && sameElement(ev, next)) continue;
      push({ type: 'click', selectors: mapCandidates(ev.selectors), button: 'left' } as Partial<FlowStep>, ev, previousTime);
      continue;
    }

    if (ev.kind === 'dblclick') {
      const prev = steps.at(-1);
      if (prev?.type === 'click') steps.pop();
      push({ type: 'doubleClick', selectors: mapCandidates(ev.selectors) } as Partial<FlowStep>, ev, previousTime);
      continue;
    }

    if (ev.kind === 'input') {
      // Coalesce a sequência de teclas em um passo único com o valor final.
      let last = ev;
      let j = i;
      while (events[j + 1] && events[j + 1]!.kind === 'input' && sameElement(last, events[j + 1]!)) {
        j += 1;
        last = events[j]!;
      }
      i = j;

      const after = events[j + 1];
      const pressEnter = Boolean(after && after.kind === 'keydown' && after.key === 'Enter' && sameElement(last, after));
      if (pressEnter) i = j + 1;

      push(
        { type: 'type', selectors: mapCandidates(last.selectors), value: last.value ?? '', clearFirst: true, pressEnter } as Partial<FlowStep>,
        last,
        previousTime,
      );
      continue;
    }

    if (ev.kind === 'change') {
      if (ev.inputType === 'select') {
        push({ type: 'select', selectors: mapCandidates(ev.selectors), values: ev.selectedValues ?? [] } as Partial<FlowStep>, ev, previousTime);
      } else if (ev.inputType === 'checkbox' || ev.inputType === 'radio') {
        // O clique que marcou já foi gravado; `check` é idempotente e não
        // depende da posição visual, então substitui com vantagem.
        const prev = steps.at(-1);
        if (prev?.type === 'click') steps.pop();
        push({ type: 'check', selectors: mapCandidates(ev.selectors), checked: ev.checked ?? true } as Partial<FlowStep>, ev, previousTime);
      }
      continue;
    }

    if (ev.kind === 'keydown') {
      push({ type: 'press', key: ev.key ?? 'Enter' } as Partial<FlowStep>, ev, previousTime);
      continue;
    }

    if (ev.kind === 'scroll') {
      // Só a posição final de uma rajada interessa.
      if (next && next.kind === 'scroll' && next.scrollTarget === ev.scrollTarget && sameElement(ev, next)) continue;
      push(
        {
          type: 'scroll',
          target: ev.scrollTarget ?? 'document',
          selectors: ev.scrollTarget === 'element' ? mapCandidates(ev.selectors) : undefined,
          x: ev.scrollX ?? 0,
          y: ev.scrollY ?? 0,
        } as Partial<FlowStep>,
        ev,
        previousTime,
      );
      continue;
    }

    if (ev.kind === 'submit') {
      const prev = steps.at(-1);
      if (prev?.type === 'click') continue;
      push({ type: 'click', selectors: mapCandidates(ev.selectors) } as Partial<FlowStep>, ev, previousTime);
    }
  }

  return steps.map((step, index) => ({ ...step, index }));
}

/* ─────────────────────────  CONVERSÃO DE INTERVALOS  ───────────────────────── */

export interface MaterializeTimingsOptions {
  /** Intervalos abaixo disso são ignorados: ruído de digitação/leitura, não pausa real. */
  minMs?: number;
  /** Teto aplicado ao intervalo convertido — sem isso, uma pausa real de minutos
   *  vira uma espera fixa de minutos na reprodução, o que não é a intenção. */
  maxMs?: number;
}

export const DEFAULT_TIMING_MIN_MS = 3_000;
export const DEFAULT_TIMING_MAX_MS = 30_000;

/**
 * Converte os intervalos observados na gravação (`recordedGapMs`) em passos
 * `waitForTimeout` reais, inseridos imediatamente antes do passo que os
 * seguiu. É pura por propósito, como `compileEvents` — opera sobre passos já
 * compilados, sem tocar navegador nem arquivo (RNF-022).
 *
 * Fluxos gravados antes deste campo existir não têm `recordedGapMs` e, por
 * isso, não têm nada para converter — não há tentativa de recuperar o valor
 * a partir do texto arredondado em `note`.
 *
 * `recordedGapMs` é limpo do passo original depois de convertido: o gap virou
 * um passo real, então rodar a conversão de novo sobre o resultado é uma
 * operação neutra em vez de inserir a mesma espera outra vez.
 */
export function materializeTimingSteps(steps: FlowStep[], opts: MaterializeTimingsOptions = {}): FlowStep[] {
  const minMs = opts.minMs ?? DEFAULT_TIMING_MIN_MS;
  const maxMs = opts.maxMs ?? DEFAULT_TIMING_MAX_MS;

  const withWaits: FlowStep[] = [];
  for (const step of steps) {
    if (step.recordedGapMs !== undefined && step.recordedGapMs >= minMs) {
      withWaits.push({
        type: 'waitForTimeout',
        index: 0,
        frame: [],
        timeoutMs: 15_000,
        onFailure: 'abort' as const,
        maxRetries: 0,
        screenshot: false,
        ms: Math.min(step.recordedGapMs, maxMs),
      } as FlowStep);
      withWaits.push({ ...step, recordedGapMs: undefined });
    } else {
      withWaits.push(step);
    }
  }

  return withWaits.map((step, index) => ({ ...step, index }));
}

/* ─────────────────────────  HELPERS  ───────────────────────── */

function mapCandidates(raw: RawCandidate[]): SelectorCandidate[] {
  return raw.map((c) => {
    switch (c.kind) {
      case 'testId':
        return { kind: 'testId' as const, value: c.value, attribute: c.attribute ?? 'data-testid', stability: c.stability };
      case 'role':
        return { kind: 'role' as const, value: c.value, name: c.name, exact: false, stability: c.stability };
      case 'text':
        return { kind: 'text' as const, value: c.value, exact: false, stability: c.stability };
      case 'label':
        return { kind: 'label' as const, value: c.value, stability: c.stability };
      case 'placeholder':
        return { kind: 'placeholder' as const, value: c.value, stability: c.stability };
      case 'xpath':
        return { kind: 'xpath' as const, value: c.value, stability: c.stability };
      default:
        return { kind: 'css' as const, value: c.value, stability: c.stability };
    }
  });
}

/** URL da página tolerando aba já fechada. */
function safeUrl(page: Page): string {
  try {
    return page.url();
  } catch {
    return 'about:blank';
  }
}

/** Dois eventos apontam para o mesmo elemento se o seletor de topo coincide. */
function sameElement(a: RawEvent, b: RawEvent): boolean {
  const first = a.selectors[0];
  const second = b.selectors[0];
  if (!first || !second) return false;
  return first.kind === second.kind && first.value === second.value;
}
