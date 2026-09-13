import { describe, it, expect, beforeEach } from 'vitest';
import { JSDOM } from 'jsdom';
import { injectedRecorder, type RawEvent } from '../src/recorder/injected.js';

/**
 * O script injetado é o código de maior risco do gravador: se ele gerar
 * seletores ruins, todo fluxo gravado nasce quebrado. Rodá-lo sob jsdom permite
 * validar a geração de candidatos sem depender de navegador real (RNF-022).
 */
function setup(html: string): { dom: JSDOM; events: RawEvent[] } {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
    url: 'https://exemplo.com/pagina',
    pretendToBeVisual: true,
  });

  const events: RawEvent[] = [];
  const win = dom.window as unknown as Window & typeof globalThis;



  win.__maestroRecord = (payload: string) => {
    events.push(JSON.parse(payload) as RawEvent);
  };

  // O script assume globais de navegador; injeta no escopo do jsdom.
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    location: globalThis.location,
    Node: globalThis.Node,
    Element: globalThis.Element,
    HTMLInputElement: globalThis.HTMLInputElement,
    HTMLTextAreaElement: globalThis.HTMLTextAreaElement,
    HTMLSelectElement: globalThis.HTMLSelectElement,
    ShadowRoot: globalThis.ShadowRoot,
    CSS: globalThis.CSS,
  };
  Object.assign(globalThis, {
    window: win,
    document: win.document,
    location: win.location,
    Node: win.Node,
    Element: win.Element,
    HTMLInputElement: win.HTMLInputElement,
    HTMLTextAreaElement: win.HTMLTextAreaElement,
    HTMLSelectElement: win.HTMLSelectElement,
    ShadowRoot: win.ShadowRoot,
    CSS: win.CSS,
  });

  forgeTrustedEvents(win);
  injectedRecorder();
  void previous;
  return { dom, events };
}

/**
 * O gravador só aceita eventos com `isTrusted` — guard que impede que o próprio
 * JavaScript da página (carrosséis, dropdowns customizados) polua a gravação
 * com cliques sintéticos que o usuário nunca deu.
 *
 * Reproduzir interação humana no jsdom exige contornar isso. `isTrusted` é um
 * getter próprio não-configurável e, pior, o dispatch o zera durante a
 * propagação, então nem sobrescrever antes funciona. A saída é marcar a flag na
 * implementação interna (alcançável pelo símbolo `impl`) em um listener no
 * Window: como o Window está acima do document no caminho de captura, ele roda
 * antes dos listeners do gravador. O acoplamento a um detalhe interno do jsdom
 * é aceitável por ficar confinado ao teste e por ser a única forma de exercitar
 * o guard sem enfraquecê-lo em produção.
 */
function forgeTrustedEvents(win: Window & typeof globalThis): void {
  const types = ['click', 'dblclick', 'input', 'change', 'keydown', 'submit', 'scroll'];
  for (const type of types) {
    win.addEventListener(
      type,
      (event: Event) => {
        const implSymbol = Object.getOwnPropertySymbols(event).find((s) => String(s) === 'Symbol(impl)');
        if (implSymbol) {
          (event as unknown as Record<symbol, { isTrusted: boolean }>)[implSymbol].isTrusted = true;
        }
      },
      { capture: true },
    );
  }
}

function click(dom: JSDOM, selector: string, init: MouseEventInit = {}): void {
  const el = dom.window.document.querySelector(selector);
  if (!el) throw new Error(`Elemento não encontrado no fixture: ${selector}`);
  el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
}

describe('injectedRecorder — geração de seletores', () => {
  beforeEach(() => {
    // cada teste monta seu próprio DOM; o guard de dupla injeção é por window
  });

  it('prioriza atributo de teste sobre qualquer outra estratégia', () => {
    const { dom, events } = setup(`<button data-testid="salvar" id="btn-x" class="a">Salvar</button>`);
    click(dom, 'button');

    expect(events).toHaveLength(1);
    const first = events[0]!.selectors[0]!;
    expect(first.kind).toBe('testId');
    expect(first.value).toBe('salvar');
    expect(first.stability).toBe(100);
  });

  it('descarta id gerado dinamicamente e cai para papel ARIA', () => {
    const { dom, events } = setup(`<button id="css-1a2b3c4d">Enviar</button>`);
    click(dom, 'button');

    const kinds = events[0]!.selectors.map((s) => s.kind);
    expect(kinds).not.toContain('testId');
    // id com cara de hash não pode virar candidato CSS por id
    const cssById = events[0]!.selectors.find((s) => s.kind === 'css' && s.value.startsWith('#'));
    expect(cssById).toBeUndefined();
    expect(kinds).toContain('role');
  });

  it('aceita id estável como candidato de alta prioridade', () => {
    const { dom, events } = setup(`<button id="botao-salvar">Salvar</button>`);
    click(dom, 'button');

    const cssById = events[0]!.selectors.find((s) => s.kind === 'css' && s.value === '#botao-salvar');
    expect(cssById).toBeDefined();
    expect(cssById!.stability).toBe(90);
  });

  it('extrai papel e nome acessível de um link', () => {
    const { dom, events } = setup(`<a href="/pedidos" aria-label="Ver pedidos">Pedidos</a>`);
    click(dom, 'a');

    const role = events[0]!.selectors.find((s) => s.kind === 'role');
    expect(role).toMatchObject({ kind: 'role', value: 'link', name: 'Ver pedidos' });
  });

  it('sempre inclui XPath como último recurso', () => {
    const { dom, events } = setup(`<div><span><em>clique</em></span></div>`);
    click(dom, 'em');

    const selectors = events[0]!.selectors;
    const last = selectors[selectors.length - 1]!;
    expect(last.kind).toBe('xpath');
    expect(last.value).toContain('/em[1]');
  });

  it('ordena candidatos por estabilidade decrescente', () => {
    const { dom, events } = setup(`<button data-testid="ok" id="ok" aria-label="Confirmar">OK</button>`);
    click(dom, 'button');

    const scores = events[0]!.selectors.map((s) => s.stability);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it('marca Alt+Clique como asserção e captura o texto', () => {
    const { dom, events } = setup(`<h1 id="titulo">Painel de Pedidos</h1>`);
    click(dom, 'h1', { altKey: true });

    expect(events[0]!.altKey).toBe(true);
    expect(events[0]!.text).toBe('Painel de Pedidos');
  });

  it('ignora classes de CSS-in-JS ao montar o caminho CSS', () => {
    const { dom, events } = setup(`<div class="container"><p class="css-8xk2ns texto">Olá</p></div>`);
    click(dom, 'p');

    const css = events[0]!.selectors.find((s) => s.kind === 'css');
    expect(css?.value).not.toContain('css-8xk2ns');
  });

  it('captura o valor digitado em campos de texto', () => {
    const { dom, events } = setup(`<input id="email" placeholder="Seu e-mail" />`);
    const input = dom.window.document.querySelector('input') as HTMLInputElement;
    input.value = 'teste@exemplo.com';
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));

    expect(events[0]!.kind).toBe('input');
    expect(events[0]!.value).toBe('teste@exemplo.com');
    expect(events[0]!.selectors.some((s) => s.kind === 'placeholder')).toBe(true);
  });

  it('nunca captura o valor de um campo type="password" (RNF-001) — vale para digitação e para colar, já que ambos disparam "input"', () => {
    const { dom, events } = setup(`<input id="senha" type="password" />`);
    const input = dom.window.document.querySelector('input') as HTMLInputElement;
    input.value = 'hunter2';
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));

    expect(events[0]!.kind).toBe('input');
    expect(events[0]!.value).toBe('');
    expect(events[0]!.redacted).toBe(true);
  });
});
