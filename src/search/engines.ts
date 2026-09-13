/**
 * Mecanismos de busca são definidos declarativamente (RNF-023): adicionar um
 * novo é acrescentar uma entrada aqui, sem tocar no motor de execução.
 */
export interface SearchEngineDef {
  id: string;
  name: string;
  homeUrl: string;
  /** Monta a URL de resultados diretamente, sem digitar na caixa. */
  buildUrl: (query: string) => string;
  /** Caixa de busca, usada no modo de submissão por digitação. */
  inputSelector: string;
  /** Elemento que confirma que a página de resultados carregou. */
  resultsSelector: string;
}

export const SEARCH_ENGINES: Record<string, SearchEngineDef> = {
  google: {
    id: 'google',
    name: 'Google',
    homeUrl: 'https://www.google.com/',
    buildUrl: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
    inputSelector: 'textarea[name="q"], input[name="q"]',
    resultsSelector: '#search, #rso, div[role="main"]',
  },
  bing: {
    id: 'bing',
    name: 'Bing',
    homeUrl: 'https://www.bing.com/',
    buildUrl: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}`,
    inputSelector: 'input[name="q"], textarea[name="q"]',
    resultsSelector: '#b_results, main',
  },
  duckduckgo: {
    id: 'duckduckgo',
    name: 'DuckDuckGo',
    homeUrl: 'https://duckduckgo.com/',
    buildUrl: (q) => `https://duckduckgo.com/?q=${encodeURIComponent(q)}`,
    inputSelector: 'input[name="q"]',
    resultsSelector: '[data-testid="mainline"], #links, main',
  },
};

export function getEngine(id: string): SearchEngineDef {
  const engine = SEARCH_ENGINES[id];
  if (!engine) {
    throw new Error(`Mecanismo de busca desconhecido: "${id}". Disponíveis: ${Object.keys(SEARCH_ENGINES).join(', ')}.`);
  }
  return engine;
}
