/**
 * Script injetado em TODOS os frames da página, a cada navegação, via
 * `context.addInitScript` (RF-022, RF-024).
 *
 * Restrições importantes:
 *  - A função é serializada com `toString()`. Ela não pode capturar nada do
 *    escopo do Node: todos os helpers precisam estar declarados aqui dentro.
 *  - A única ponte com o processo Node é `window.__maestroRecord`, exposta por
 *    `context.exposeBinding`, que existe em todos os frames.
 */

/** Evento bruto emitido pela página. A coalescência acontece do lado do Node. */
export interface RawEvent {
  kind: 'click' | 'dblclick' | 'input' | 'change' | 'keydown' | 'scroll' | 'submit';
  selectors: RawCandidate[];
  value?: string;
  checked?: boolean;
  selectedValues?: string[];
  key?: string;
  scrollX?: number;
  scrollY?: number;
  scrollTarget?: 'document' | 'element';
  tagName?: string;
  inputType?: string;
  /** Alt+Clique marca o elemento como asserção em vez de gravar o clique (RF-029). */
  altKey?: boolean;
  /** Texto visível do elemento, usado como valor esperado da asserção. */
  text?: string;
  /** `true` quando `value` foi omitido de propósito por vir de um campo de senha (RNF-001). */
  redacted?: boolean;
  url: string;
  t: number;
}

export interface RawCandidate {
  kind: 'testId' | 'css' | 'role' | 'label' | 'placeholder' | 'text' | 'xpath';
  value: string;
  name?: string;
  attribute?: string;
  stability: number;
}

declare global {
  interface Window {
    __maestroRecord?: (payload: string) => void;
    __maestroInstalled?: boolean;
  }
}

export function injectedRecorder(): void {
  if (window.__maestroInstalled) return;
  window.__maestroInstalled = true;

  const TEST_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-qa', 'data-automation-id'];

  /* ───────── heurística de estabilidade de identificadores (RF-026) ───────── */

  /**
   * Rejeita identificadores que aparentam ser gerados em build ou em runtime.
   * Um seletor baseado em `css-1x7f3a9` ou `mui-4821` quebra no próximo deploy,
   * então é melhor descartá-lo na gravação do que descobrir na execução.
   */
  function looksGenerated(token: string): boolean {
    if (!token) return true;
    const patterns: RegExp[] = [
      /^(css|sc|jsx|emotion|styled|makeStyles|jss)[-_]?\d/i, // CSS-in-JS
      /^[a-z]+-[0-9a-f]{5,}$/i, // prefixo + hash
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i, // UUID
      /^[a-z]{1,3}[-_][A-Za-z0-9]{6,}$/, // módulo CSS: Btn_a8Xk2p
      /\d{5,}/, // sequência numérica longa
      /^(ember|react|ng|vue)\d+$/i, // ids de framework
      /^:r[0-9a-z]+:$/i, // React useId
    ];
    return patterns.some((p) => p.test(token));
  }

  function stableClasses(el: Element): string[] {
    return Array.from(el.classList).filter((c) => c.length > 1 && c.length < 40 && !looksGenerated(c));
  }

  function cssEscape(value: string): string {
    if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(value);
    return value.replace(/([^\w-])/g, '\\$1');
  }

  /* ───────── papel ARIA e nome acessível ───────── */

  function inferRole(el: Element): string | null {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.split(/\s+/)[0] ?? null;

    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') ?? '').toLowerCase();

    if (tag === 'a') return el.hasAttribute('href') ? 'link' : null;
    if (tag === 'button') return 'button';
    if (tag === 'select') return el.hasAttribute('multiple') ? 'listbox' : 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'img') return 'img';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'input') {
      if (['submit', 'button', 'reset', 'image'].includes(type)) return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'range') return 'slider';
      if (type === 'number') return 'spinbutton';
      if (['text', 'email', 'tel', 'url', ''].includes(type)) return 'textbox';
      if (type === 'search') return 'searchbox';
    }
    return null;
  }

  /** Aproximação do nome acessível seguindo a ordem de precedência do accname. */
  function accessibleName(el: Element): string {
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel?.trim()) return ariaLabel.trim();

    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const root = el.getRootNode() as Document | ShadowRoot;
      const text = labelledBy
        .split(/\s+/)
        .map((id) => (root as Document).getElementById?.(id)?.textContent ?? '')
        .join(' ')
        .trim();
      if (text) return text;
    }

    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
      const labels = (el as HTMLInputElement).labels;
      if (labels?.length) {
        const text = Array.from(labels)
          .map((l) => l.textContent ?? '')
          .join(' ')
          .trim();
        if (text) return text;
      }
      const placeholder = el.getAttribute('placeholder');
      if (placeholder?.trim()) return placeholder.trim();
    }

    const alt = el.getAttribute('alt');
    if (alt?.trim()) return alt.trim();

    const title = el.getAttribute('title');
    if (title?.trim()) return title.trim();

    const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    return text.length > 0 && text.length <= 80 ? text : '';
  }

  /* ───────── caminho CSS ───────── */

  function isUnique(root: Document | ShadowRoot, selector: string, el: Element): boolean {
    try {
      const matches = root.querySelectorAll(selector);
      return matches.length === 1 && matches[0] === el;
    } catch {
      return false;
    }
  }

  function localSegment(el: Element): string {
    const tag = el.tagName.toLowerCase();
    const classes = stableClasses(el).slice(0, 2);
    let segment = tag + classes.map((c) => `.${cssEscape(c)}`).join('');

    const parent = el.parentElement;
    if (parent) {
      const sameShape = Array.from(parent.children).filter((sibling) => {
        if (sibling.tagName !== el.tagName) return false;
        if (classes.length === 0) return true;
        return classes.every((c) => sibling.classList.contains(c));
      });
      if (sameShape.length > 1) {
        segment += `:nth-of-type(${Array.from(parent.children).filter((s) => s.tagName === el.tagName).indexOf(el) + 1})`;
      }
    }
    return segment;
  }

  /** Caminho CSS relativo ao root do elemento (documento ou shadow root). */
  function cssPath(el: Element): string | null {
    const root = el.getRootNode() as Document | ShadowRoot;
    const segments: string[] = [];
    let current: Element | null = el;
    let depth = 0;

    while (current && depth < 8) {
      const id = current.getAttribute('id');
      if (id && !looksGenerated(id)) {
        const candidate = [`#${cssEscape(id)}`, ...segments].join(' > ');
        if (isUnique(root, candidate, el)) return candidate;
      }

      segments.unshift(localSegment(current));
      const candidate = segments.join(' > ');
      if (isUnique(root, candidate, el)) return candidate;

      current = current.parentElement;
      depth += 1;
    }

    const fallback = segments.join(' > ');
    return fallback.length > 0 ? fallback : null;
  }

  /** Caminho absoluto em XPath — último recurso, sempre resolve (RF-025). */
  function xpath(el: Element): string {
    const parts: string[] = [];
    let current: Element | null = el;
    while (current && current.nodeType === Node.ELEMENT_NODE) {
      const parent: Element | null = current.parentElement;
      if (!parent) {
        parts.unshift(`/${current.tagName.toLowerCase()}`);
        break;
      }
      const index = Array.from(parent.children).filter((c) => c.tagName === current!.tagName).indexOf(current) + 1;
      parts.unshift(`/${current.tagName.toLowerCase()}[${index}]`);
      current = parent;
    }
    return parts.join('');
  }

  /**
   * Prefixo do host quando o elemento vive dentro de Shadow DOM.
   * O Playwright atravessa shadow root aberto em seletores CSS, mas encadear
   * explicitamente com ">>" evita ambiguidade quando o mesmo componente
   * aparece várias vezes na página.
   */
  function shadowHostPrefix(el: Element): string {
    const chain: string[] = [];
    let root = el.getRootNode();
    while (root instanceof ShadowRoot) {
      const host = root.host;
      const path = cssPath(host);
      if (!path) break;
      chain.unshift(path);
      root = host.getRootNode();
    }
    return chain.length > 0 ? chain.join(' >> ') + ' >> ' : '';
  }

  /** Monta a lista ordenada de candidatos para um elemento (RF-025). */
  function buildCandidates(el: Element): RawCandidate[] {
    const out: RawCandidate[] = [];
    const prefix = shadowHostPrefix(el);
    const push = (c: RawCandidate) => {
      if (!out.some((existing) => existing.kind === c.kind && existing.value === c.value)) out.push(c);
    };

    for (const attr of TEST_ATTRS) {
      const value = el.getAttribute(attr);
      if (value && !looksGenerated(value)) {
        push({ kind: 'testId', value, attribute: attr, stability: 100 });
      }
    }

    const id = el.getAttribute('id');
    if (id && !looksGenerated(id)) {
      push({ kind: 'css', value: `${prefix}#${cssEscape(id)}`, stability: 90 });
    }

    const role = inferRole(el);
    const name = accessibleName(el);
    if (role) {
      push({ kind: 'role', value: role, name: name || undefined, stability: name ? 80 : 40 });
    }

    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel?.trim()) push({ kind: 'label', value: ariaLabel.trim(), stability: 75 });

    const nameAttr = el.getAttribute('name');
    if (nameAttr && !looksGenerated(nameAttr)) {
      push({ kind: 'css', value: `${prefix}${el.tagName.toLowerCase()}[name="${nameAttr}"]`, stability: 70 });
    }

    const placeholder = el.getAttribute('placeholder');
    if (placeholder?.trim()) push({ kind: 'placeholder', value: placeholder.trim(), stability: 65 });

    const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (text && text.length <= 60 && ['a', 'button', 'summary', 'label'].includes(el.tagName.toLowerCase())) {
      push({ kind: 'text', value: text, exact: false, stability: 55 } as RawCandidate);
    }

    const path = cssPath(el);
    if (path) push({ kind: 'css', value: `${prefix}${path}`, stability: 45 });

    push({ kind: 'xpath', value: xpath(el), stability: 10 });

    return out.sort((a, b) => b.stability - a.stability);
  }

  /* ───────── emissão ───────── */

  function emit(event: RawEvent): void {
    try {
      window.__maestroRecord?.(JSON.stringify(event));
    } catch {
      /* binding ainda não disponível neste frame; evento é descartado */
    }
  }

  function resolveTarget(e: Event): Element | null {
    // composedPath dá o alvo real mesmo atravessando Shadow DOM fechado no topo.
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    const first = path.find((n): n is Element => n instanceof Element);
    return first ?? (e.target instanceof Element ? e.target : null);
  }

  function baseEvent(kind: RawEvent['kind'], el: Element): RawEvent {
    return {
      kind,
      selectors: buildCandidates(el),
      tagName: el.tagName.toLowerCase(),
      url: location.href,
      t: Date.now(),
    };
  }

  document.addEventListener(
    'click',
    (e) => {
      const el = resolveTarget(e);
      if (!el || !e.isTrusted) return;
      const event = baseEvent('click', el);
      if (e.altKey) {
        // Alt+Clique não é uma interação real: é o usuário marcando uma asserção.
        e.preventDefault();
        e.stopPropagation();
        event.altKey = true;
        event.text = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
      }
      emit(event);
    },
    { capture: true },
  );

  document.addEventListener(
    'dblclick',
    (e) => {
      const el = resolveTarget(e);
      if (!el || !e.isTrusted) return;
      emit(baseEvent('dblclick', el));
    },
    { capture: true },
  );

  document.addEventListener(
    'input',
    (e) => {
      const el = resolveTarget(e);
      if (!el || !e.isTrusted) return;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        const event = baseEvent('input', el);
        // Campo de senha nunca tem o valor capturado (RNF-001) — nem digitado
        // nem colado, já que colar também dispara 'input'. `type` só é
        // confiável em HTMLInputElement; textarea não tem variante senha.
        const isPassword = el instanceof HTMLInputElement && el.type === 'password';
        event.value = isPassword ? '' : el.value;
        event.inputType = el instanceof HTMLInputElement ? el.type : 'textarea';
        if (isPassword) event.redacted = true;
        emit(event);
      }
    },
    { capture: true },
  );

  document.addEventListener(
    'change',
    (e) => {
      const el = resolveTarget(e);
      if (!el || !e.isTrusted) return;
      const event = baseEvent('change', el);
      if (el instanceof HTMLSelectElement) {
        event.selectedValues = Array.from(el.selectedOptions).map((o) => o.value);
        event.inputType = 'select';
      } else if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
        event.checked = el.checked;
        event.inputType = el.type;
      } else {
        return;
      }
      emit(event);
    },
    { capture: true },
  );

  document.addEventListener(
    'keydown',
    (e) => {
      if (!e.isTrusted) return;
      // Só teclas com efeito estrutural. Digitação comum vem pelo evento 'input'.
      if (!['Enter', 'Tab', 'Escape', 'ArrowDown', 'ArrowUp', 'PageDown', 'PageUp'].includes(e.key)) return;
      const el = resolveTarget(e);
      if (!el) return;
      const event = baseEvent('keydown', el);
      event.key = e.key;
      emit(event);
    },
    { capture: true },
  );

  document.addEventListener(
    'submit',
    (e) => {
      const el = resolveTarget(e);
      if (!el || !e.isTrusted) return;
      emit(baseEvent('submit', el));
    },
    { capture: true },
  );

  /* Scroll é ruidoso: só a posição final de cada pausa interessa (RF-023). */
  let scrollTimer: number | undefined;
  const flushScroll = (target: EventTarget | null) => {
    window.clearTimeout(scrollTimer);
    scrollTimer = window.setTimeout(() => {
      if (target === document || target === window || target === document.documentElement) {
        emit({
          kind: 'scroll',
          selectors: [],
          scrollTarget: 'document',
          scrollX: Math.round(window.scrollX),
          scrollY: Math.round(window.scrollY),
          url: location.href,
          t: Date.now(),
        });
        return;
      }
      if (target instanceof Element) {
        const event = baseEvent('scroll', target);
        event.scrollTarget = 'element';
        event.scrollX = Math.round(target.scrollLeft);
        event.scrollY = Math.round(target.scrollTop);
        emit(event);
      }
    }, 250);
  };

  document.addEventListener('scroll', (e) => flushScroll(e.target), { capture: true, passive: true });
}
