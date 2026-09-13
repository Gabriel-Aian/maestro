import { describe, it, expect } from 'vitest';
import { validateSearchFile, expandSearches } from '../src/search/searchFile.js';

const base = {
  schemaVersion: 1 as const,
  defaults: { browser: 'chrome', profile: 'conta-1', engine: 'google', headless: true },
  themes: [{ id: 't1', name: 'Tecnologia', queries: ['playwright'] }],
};

describe('validateSearchFile', () => {
  it('aceita um arquivo mínimo válido', () => {
    const result = validateSearchFile(base);
    expect(result.ok).toBe(true);
  });

  it('aponta o caminho exato do campo inválido', () => {
    const result = validateSearchFile({ ...base, themes: [{ id: 't1', name: 'X', queries: [] }] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]!.path).toBe('themes.0.queries');
  });

  it('rejeita ids de tema duplicados', () => {
    const result = validateSearchFile({
      ...base,
      themes: [
        { id: 'dup', name: 'A', queries: ['a'] },
        { id: 'dup', name: 'B', queries: ['b'] },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]!.message).toContain('duplicado');
  });

  it('rejeita mecanismo de busca inexistente antes da execução', () => {
    const result = validateSearchFile({ ...base, themes: [{ id: 't1', name: 'X', engine: 'yahoo', queries: ['a'] }] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]!.path).toBe('themes.0.engine');
  });

  it('rejeita faixa de atraso invertida', () => {
    const result = validateSearchFile({ ...base, defaults: { ...base.defaults, delayBetweenSearchesMs: [9000, 1000] } });
    expect(result.ok).toBe(false);
  });
});

describe('expandSearches', () => {
  function parse(raw: unknown) {
    const result = validateSearchFile(raw);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    return result.data;
  }

  it('expande o produto cartesiano das variáveis', () => {
    const file = parse({
      ...base,
      themes: [
        {
          id: 't1',
          name: 'Compras',
          queries: [{ text: 'melhor {tipo} para {uso}', vars: { tipo: ['notebook', 'tablet'], uso: ['trabalho', 'estudo'] } }],
        },
      ],
    });

    const expanded = expandSearches(file).map((s) => s.query);
    expect(expanded).toHaveLength(4);
    expect(expanded).toContain('melhor notebook para trabalho');
    expect(expanded).toContain('melhor tablet para estudo');
  });

  it('multiplica pela repetição declarada', () => {
    const file = parse({ ...base, themes: [{ id: 't1', name: 'X', queries: [{ text: 'a', repeat: 3 }] }] });
    expect(expandSearches(file)).toHaveLength(3);
  });

  it('aplica a herança defaults → tema', () => {
    const file = parse({
      ...base,
      defaults: { ...base.defaults, engine: 'google', profile: 'conta-1' },
      themes: [
        { id: 't1', name: 'Herda', queries: ['a'] },
        { id: 't2', name: 'Sobrescreve', engine: 'bing', profile: 'conta-2', queries: ['b'] },
      ],
    });

    const [herda, sobrescreve] = expandSearches(file);
    expect(herda).toMatchObject({ engine: 'google', profile: 'conta-1' });
    expect(sobrescreve).toMatchObject({ engine: 'bing', profile: 'conta-2' });
  });

  it('ignora temas desativados mas não os apaga', () => {
    const file = parse({
      ...base,
      themes: [
        { id: 't1', name: 'Ativo', queries: ['a'] },
        { id: 't2', name: 'Inativo', enabled: false, queries: ['b'] },
      ],
    });

    expect(expandSearches(file)).toHaveLength(1);
    expect(file.themes).toHaveLength(2);
  });

  it('respeita o filtro por tema', () => {
    const file = parse({
      ...base,
      themes: [
        { id: 't1', name: 'A', queries: ['a'] },
        { id: 't2', name: 'B', queries: ['b'] },
      ],
    });

    expect(expandSearches(file, { themeIds: ['t2'] }).map((s) => s.query)).toEqual(['b']);
  });
});
