import { describe, it, expect } from 'vitest';
import { compileEvents, type TimedEvent } from '../src/recorder/recorder.js';
import type { RawCandidate } from '../src/recorder/injected.js';

/** Atalho para montar eventos brutos com um seletor identificável. */
function ev(partial: Partial<TimedEvent> & { kind: TimedEvent['kind']; id: string; t: number }): TimedEvent {
  const selectors: RawCandidate[] = [{ kind: 'css', value: `#${partial.id}`, stability: 90 }];
  const { id, ...rest } = partial;
  return { selectors, url: 'https://exemplo.com', frame: [], pageIndex: 0, ...rest } as TimedEvent;
}

/** Evento sintético de ciclo de vida de aba. */
function tab(lifecycle: 'tab-opened' | 'tab-closed', pageIndex: number, t: number, url = 'https://exemplo.com/popup'): TimedEvent {
  return { kind: 'click', selectors: [], url, t, frame: [], pageIndex, lifecycle } as TimedEvent;
}

describe('compileEvents — limpeza da gravação bruta', () => {
  it('coalesce digitação caractere a caractere em um único passo', () => {
    const steps = compileEvents([
      ev({ kind: 'input', id: 'email', t: 1000, value: 'a' }),
      ev({ kind: 'input', id: 'email', t: 1100, value: 'an' }),
      ev({ kind: 'input', id: 'email', t: 1200, value: 'ana@x.com' }),
    ]);

    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ type: 'type', value: 'ana@x.com', clearFirst: true });
  });

  it('nunca grava o valor de um campo de senha (RNF-001), mesmo colado (paste dispara "input" igual digitação)', () => {
    const steps = compileEvents([
      ev({ kind: 'input', id: 'senha', t: 1000, value: 'h', redacted: true }),
      ev({ kind: 'input', id: 'senha', t: 1050, value: 'hunter2', redacted: true }),
    ]);

    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ type: 'type', value: '', redacted: true });
    expect((steps[0] as { note?: string }).note).toMatch(/senha/i);
  });

  it('preserva a nota de intervalo observado em campos normais (não deixa o tratamento de senha vazar "note: undefined" para o caso comum)', () => {
    const steps = compileEvents([
      ev({ kind: 'click', id: 'outro', t: 0 }),
      ev({ kind: 'input', id: 'email', t: 5000, value: 'ana@x.com' }),
    ]);

    expect(steps.at(-1)).toMatchObject({ type: 'type', redacted: false });
    expect((steps.at(-1) as { note?: string }).note).toMatch(/Intervalo observado/);
  });

  it('descarta o clique de foco que antecede a digitação', () => {
    const steps = compileEvents([
      ev({ kind: 'click', id: 'email', t: 1000 }),
      ev({ kind: 'input', id: 'email', t: 1200, value: 'texto' }),
    ]);

    expect(steps.map((s) => s.type)).toEqual(['type']);
  });

  it('preserva o clique quando ele não é seguido de digitação no mesmo campo', () => {
    const steps = compileEvents([
      ev({ kind: 'click', id: 'botao', t: 1000 }),
      ev({ kind: 'input', id: 'outro-campo', t: 1200, value: 'x' }),
    ]);

    expect(steps.map((s) => s.type)).toEqual(['click', 'type']);
  });

  it('funde Enter logo após digitação em pressEnter', () => {
    const steps = compileEvents([
      ev({ kind: 'input', id: 'busca', t: 1000, value: 'playwright' }),
      ev({ kind: 'keydown', id: 'busca', t: 1100, key: 'Enter' }),
    ]);

    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ type: 'type', pressEnter: true });
  });

  it('substitui clique em checkbox por passo check idempotente', () => {
    const steps = compileEvents([
      ev({ kind: 'click', id: 'aceite', t: 1000 }),
      ev({ kind: 'change', id: 'aceite', t: 1010, inputType: 'checkbox', checked: true }),
    ]);

    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ type: 'check', checked: true });
  });

  it('colapsa rajada de scroll na posição final', () => {
    const steps = compileEvents([
      ev({ kind: 'scroll', id: 'doc', t: 1000, scrollTarget: 'document', scrollY: 200 }),
      ev({ kind: 'scroll', id: 'doc', t: 1100, scrollTarget: 'document', scrollY: 600 }),
      ev({ kind: 'scroll', id: 'doc', t: 1200, scrollTarget: 'document', scrollY: 900 }),
    ]);

    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ type: 'scroll', y: 900 });
  });

  it('remove o clique simples que precede um clique duplo', () => {
    const steps = compileEvents([
      ev({ kind: 'click', id: 'item', t: 1000 }),
      ev({ kind: 'dblclick', id: 'item', t: 1050 }),
    ]);

    expect(steps.map((s) => s.type)).toEqual(['doubleClick']);
  });

  it('converte Alt+Clique em asserção de texto', () => {
    const steps = compileEvents([ev({ kind: 'click', id: 'titulo', t: 1000, altKey: true, text: 'Pedidos' })]);

    expect(steps[0]).toMatchObject({ type: 'assertText', operator: 'contains', expected: 'Pedidos' });
  });

  it('anota o intervalo observado quando a pausa foi longa', () => {
    const steps = compileEvents([
      ev({ kind: 'click', id: 'a', t: 1000 }),
      ev({ kind: 'click', id: 'b', t: 9000 }),
    ]);

    expect(steps[1]!.note).toContain('8s');
    expect(steps[1]!.recordedGapMs).toBe(8000);
  });

  it('guarda o intervalo bruto mesmo abaixo do limiar usado para a nota', () => {
    const steps = compileEvents([
      ev({ kind: 'click', id: 'a', t: 1000 }),
      ev({ kind: 'click', id: 'b', t: 1500 }),
    ]);

    expect(steps[1]!.note).toBeUndefined();
    expect(steps[1]!.recordedGapMs).toBe(500);
  });

  it('não guarda intervalo bruto no primeiro passo, que não tem antecessor', () => {
    const steps = compileEvents([ev({ kind: 'click', id: 'a', t: 1000 })]);

    expect(steps[0]!.recordedGapMs).toBeUndefined();
  });

  it('reindexa os passos sequencialmente após as remoções', () => {
    const steps = compileEvents([
      ev({ kind: 'click', id: 'campo', t: 1000 }),
      ev({ kind: 'input', id: 'campo', t: 1100, value: 'x' }),
      ev({ kind: 'click', id: 'enviar', t: 2000 }),
    ]);

    expect(steps.map((s) => s.index)).toEqual([0, 1]);
  });
});

describe('compileEvents — navegação entre abas', () => {
  it('insere switchTab quando a interação migra para a aba aberta pelo clique', () => {
    const steps = compileEvents([
      ev({ kind: 'click', id: 'link-externo', t: 1000 }),
      tab('tab-opened', 1, 1100),
      ev({ kind: 'click', id: 'botao-popup', t: 1500, pageIndex: 1, url: 'https://outro.com/detalhe' }),
    ]);

    expect(steps.map((s) => s.type)).toEqual(['click', 'switchTab', 'click']);
    expect(steps[1]).toMatchObject({
      type: 'switchTab',
      tabIndex: 1,
      matchUrl: 'https://outro.com/detalhe',
      waitForNew: true,
    });
  });

  it('não gera passo algum quando a aba abre mas ninguém interage nela', () => {
    const steps = compileEvents([
      ev({ kind: 'click', id: 'link', t: 1000 }),
      tab('tab-opened', 1, 1100),
      ev({ kind: 'click', id: 'seguinte', t: 2000 }),
    ]);

    expect(steps.map((s) => s.type)).toEqual(['click', 'click']);
  });

  it('volta para a aba original quando o usuário retorna a ela', () => {
    const steps = compileEvents([
      ev({ kind: 'click', id: 'link', t: 1000, url: 'https://exemplo.com/lista' }),
      tab('tab-opened', 1, 1100),
      ev({ kind: 'click', id: 'no-popup', t: 1500, pageIndex: 1, url: 'https://outro.com/x' }),
      ev({ kind: 'click', id: 'de-volta', t: 2000, pageIndex: 0, url: 'https://exemplo.com/lista' }),
    ]);

    const switches = steps.filter((s) => s.type === 'switchTab');
    expect(switches).toHaveLength(2);
    expect(switches[1]).toMatchObject({ tabIndex: 0, matchUrl: 'https://exemplo.com/lista', waitForNew: false });
  });

  it('grava o fechamento da aba ativa e a troca subsequente', () => {
    const steps = compileEvents([
      tab('tab-opened', 1, 1000),
      ev({ kind: 'click', id: 'no-popup', t: 1100, pageIndex: 1, url: 'https://outro.com/x' }),
      tab('tab-closed', 1, 1200, 'https://outro.com/x'),
      ev({ kind: 'click', id: 'original', t: 1300, pageIndex: 0, url: 'https://exemplo.com/lista' }),
    ]);

    expect(steps.map((s) => s.type)).toEqual(['switchTab', 'click', 'closeTab', 'switchTab', 'click']);
  });

  it('ignora o fechamento de aba que não era a ativa', () => {
    const steps = compileEvents([
      ev({ kind: 'click', id: 'a', t: 1000 }),
      tab('tab-closed', 1, 1100),
      ev({ kind: 'click', id: 'b', t: 1200 }),
    ]);

    expect(steps.map((s) => s.type)).toEqual(['click', 'click']);
  });
});
