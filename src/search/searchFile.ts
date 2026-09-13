import { readFileSync } from 'node:fs';
import { SearchFileSchema, type ResolvedSearch, type SearchFile, type Theme } from '../types/schema.js';
import { getEngine } from './engines.js';

export interface ValidationIssue {
  path: string;
  message: string;
}

export class SearchFileInvalidError extends Error {
  constructor(readonly issues: ValidationIssue[], filePath?: string) {
    super(
      `Arquivo de pesquisas inválido${filePath ? ` (${filePath})` : ''}:\n` +
        issues.map((i) => `  • ${i.path || '(raiz)'}: ${i.message}`).join('\n'),
    );
    this.name = 'SearchFileInvalidError';
  }
}

/**
 * Valida o conteúdo contra o schema (RF-010).
 * Devolve os problemas com o caminho do campo para que a interface possa
 * apontar exatamente onde está o erro, em vez de dizer só "JSON inválido".
 */
export function validateSearchFile(raw: unknown): { ok: true; data: SearchFile } | { ok: false; issues: ValidationIssue[] } {
  const parsed = SearchFileSchema.safeParse(raw);
  if (parsed.success) {
    const issues = validateEngineReferences(parsed.data);
    return issues.length > 0 ? { ok: false, issues } : { ok: true, data: parsed.data };
  }
  return {
    ok: false,
    issues: parsed.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    })),
  };
}

/** Mecanismo inexistente passa no schema (é string) mas quebra na execução. */
function validateEngineReferences(file: SearchFile): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const check = (id: string, path: string) => {
    try {
      getEngine(id);
    } catch (err) {
      issues.push({ path, message: err instanceof Error ? err.message : String(err) });
    }
  };

  check(file.defaults.engine, 'defaults.engine');
  file.themes.forEach((theme, i) => {
    if (theme.engine) check(theme.engine, `themes.${i}.engine`);
  });
  return issues;
}

/**
 * Carrega e valida o arquivo do disco (RF-009, RF-011).
 * Lança em vez de retornar parcial: a configuração anterior deve permanecer
 * intacta quando a importação falha.
 */
export function loadSearchFile(filePath: string): SearchFile {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new SearchFileInvalidError([{ path: '', message: `JSON malformado: ${err instanceof Error ? err.message : String(err)}` }], filePath);
  }

  const result = validateSearchFile(raw);
  if (!result.ok) throw new SearchFileInvalidError(result.issues, filePath);
  return result.data;
}

/* ─────────────────────────  EXPANSÃO  ───────────────────────── */

/** Produto cartesiano das variáveis declaradas em uma query (RF-015). */
function expandVars(text: string, vars: Record<string, string[]> | undefined): string[] {
  if (!vars || Object.keys(vars).length === 0) return [text];

  let combinations: Array<Record<string, string>> = [{}];
  for (const [name, values] of Object.entries(vars)) {
    const next: Array<Record<string, string>> = [];
    for (const combo of combinations) {
      for (const value of values) next.push({ ...combo, [name]: value });
    }
    combinations = next;
  }

  return combinations.map((combo) =>
    text.replace(/\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}/g, (whole, name: string) => combo[name] ?? whole),
  );
}

/**
 * Achata o arquivo em uma lista de pesquisas prontas para a fila, aplicando a
 * herança `defaults → tema → query` e expandindo variáveis e repetições.
 * Temas desativados são ignorados aqui, mas permanecem no arquivo (RN-009).
 */
export function expandSearches(file: SearchFile, opts: { themeIds?: string[]; sampleSize?: number } = {}): ResolvedSearch[] {
  const out: ResolvedSearch[] = [];
  const filter = opts.themeIds ? new Set(opts.themeIds) : null;

  for (const theme of file.themes) {
    if (!theme.enabled) continue;
    if (filter && !filter.has(theme.id)) continue;
    out.push(...expandTheme(theme, file));
  }

  // `sampleSize` limita a execução a N pesquisas sorteadas do total já
  // filtrado, sem repetir nenhuma dentro dessa mesma execução — pedido para
  // não precisar rodar as centenas de pesquisas do arquivo de uma vez só.
  // `undefined` (o padrão) preserva o comportamento de sempre: todas as
  // pesquisas ativas, na ordem do arquivo.
  if (opts.sampleSize !== undefined && opts.sampleSize < out.length) {
    return sampleWithoutReplacement(out, opts.sampleSize);
  }
  return out;
}

/** Fisher–Yates parcial: embaralha só o necessário para tirar `n` itens sem repetir. */
function sampleWithoutReplacement<T>(pool: T[], n: number): T[] {
  const arr = [...pool];
  const count = Math.min(Math.max(n, 0), arr.length);
  for (let i = 0; i < count; i += 1) {
    const j = i + Math.floor(Math.random() * (arr.length - i));
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
  return arr.slice(0, count);
}

function expandTheme(theme: Theme, file: SearchFile): ResolvedSearch[] {
  const d = file.defaults;
  const base = {
    themeId: theme.id,
    themeName: theme.name,
    engine: theme.engine ?? d.engine,
    browser: theme.browser ?? d.browser,
    profile: theme.profile ?? d.profile ?? 'default',
    headless: theme.headless ?? d.headless,
    screenshot: theme.screenshot ?? d.screenshot,
    maxRetries: d.maxRetries,
    delayRange: (theme.delayBetweenSearchesMs ?? d.delayBetweenSearchesMs) as [number, number],
  };

  const out: ResolvedSearch[] = [];
  for (const query of theme.queries) {
    if (typeof query === 'string') {
      out.push({ ...base, query });
      continue;
    }
    for (const text of expandVars(query.text, query.vars)) {
      for (let r = 0; r < query.repeat; r += 1) out.push({ ...base, query: text });
    }
  }
  return out;
}
