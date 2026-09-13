import type { Page } from 'playwright-core';

export type BlockReason = 'captcha' | 'login_wall' | 'unknown';

export interface BlockDetection {
  blocked: boolean;
  reason?: BlockReason;
  evidence?: string;
}

/** Domínios/caminhos de provedores de desafio conhecidos. */
const CAPTCHA_FRAME_PATTERNS = [
  /google\.com\/recaptcha/i,
  /recaptcha\.net/i,
  /hcaptcha\.com/i,
  /challenges\.cloudflare\.com/i,
  /captcha-delivery\.com/i, // DataDome
  /geo\.captcha-delivery/i,
  /perimeterx|px-captcha/i,
  /funcaptcha|arkoselabs/i,
];

/** URLs que indicam interstício de bloqueio do próprio provedor de busca. */
const BLOCK_URL_PATTERNS = [
  /\/sorry\//i, // Google
  /ipv4\.google\.com\/sorry/i,
  /bing\.com\/challenge/i,
  /duckduckgo\.com\/challenge/i,
];

/**
 * Provedores de identidade: cair aqui é sinal forte de sessão expirada, porque
 * nenhum fluxo normal passa por eles quando a conta está válida.
 */
const IDENTITY_PROVIDER_PATTERNS = [
  /accounts\.google\.com\/(signin|v3\/signin|ServiceLogin)/i,
  /login\.live\.com/i,
  /login\.microsoftonline\.com/i,
  /okta\.com\/login/i,
  /auth0\.com\/(u\/)?login/i,
];

/**
 * Caminhos genéricos de login. Isoladamente NÃO bastam para bloquear: fluxos
 * legítimos visitam `/login` o tempo todo, e muitos sites usam `/auth/` como
 * prefixo de rotas comuns. Só contam quando houve redirecionamento — ou seja,
 * quando a página em que paramos não é a que pedimos.
 */
const GENERIC_LOGIN_PATTERNS = [
  /\/(login|signin|sign-in|entrar|autenticar)(\/|\?|$)/i,
  /\/sessions?\/new(\/|\?|$)/i,
];

/** Texto de interface que confirma um desafio, em pt-BR e en. */
const CHALLENGE_TEXT = [
  'não sou um robô',
  "i'm not a robot",
  'verifique se você é humano',
  'verify you are human',
  'tráfego incomum',
  'unusual traffic',
  'nossos sistemas detectaram',
  'our systems have detected',
  'checking your browser',
  'verificando seu navegador',
];

/**
 * Inspeciona a página para decidir se a execução deve parar com status
 * `bloqueado` (RF-046, RN-004).
 *
 * A decisão deliberadamente não tenta contornar nada (RNF-006): insistir em
 * cliques diante de um desafio só reforça a detecção contra a conta. Parar e
 * avisar preserva o perfil para a próxima execução.
 */
export interface DetectBlockOptions {
  /**
   * URL que a execução pediu. Sem ela não dá para distinguir "fui redirecionado
   * para o login" de "o fluxo navega para a tela de login de propósito" — e essa
   * distinção é o que evita abortar fluxos perfeitamente válidos.
   */
  intendedUrl?: string;
  /** Permite desligar a checagem de parede de login (config.detectLoginWall). */
  detectLoginWall?: boolean;
}

function matchesAny(url: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(url));
}

/** Compara apenas origem + caminho: query e fragmento variam sem significar redirecionamento. */
function samePage(a: string, b: string): boolean {
  try {
    const first = new URL(a);
    const second = new URL(b);
    return first.origin === second.origin && first.pathname.replace(/\/$/, '') === second.pathname.replace(/\/$/, '');
  } catch {
    return false;
  }
}

export async function detectBlock(page: Page, options: DetectBlockOptions = {}): Promise<BlockDetection> {
  const url = page.url();
  const { intendedUrl } = options;
  const checkLoginWall = options.detectLoginWall ?? true;

  for (const pattern of BLOCK_URL_PATTERNS) {
    if (pattern.test(url)) {
      return { blocked: true, reason: 'captcha', evidence: `URL de interstício: ${url}` };
    }
  }

  for (const frame of page.frames()) {
    const frameUrl = frame.url();
    for (const pattern of CAPTCHA_FRAME_PATTERNS) {
      if (pattern.test(frameUrl)) {
        return { blocked: true, reason: 'captcha', evidence: `Frame de desafio: ${frameUrl}` };
      }
    }
  }

  if (checkLoginWall) {
    // Se o próprio destino pedido já era uma tela de login, ir parar nela é o
    // comportamento esperado, não um bloqueio.
    const intendedIsLogin =
      intendedUrl !== undefined &&
      (matchesAny(intendedUrl, IDENTITY_PROVIDER_PATTERNS) || matchesAny(intendedUrl, GENERIC_LOGIN_PATTERNS));

    if (!intendedIsLogin) {
      if (matchesAny(url, IDENTITY_PROVIDER_PATTERNS)) {
        return { blocked: true, reason: 'login_wall', evidence: `Redirecionado para provedor de identidade: ${url}` };
      }
      // Caminho genérico só conta quando confirmamos que houve desvio.
      const redirected = intendedUrl !== undefined && !samePage(url, intendedUrl);
      if (redirected && matchesAny(url, GENERIC_LOGIN_PATTERNS)) {
        return {
          blocked: true,
          reason: 'login_wall',
          evidence: `Redirecionado de ${intendedUrl} para tela de login: ${url}`,
        };
      }
    }
  }

  // Texto só é consultado depois das checagens baratas, e limitado ao início
  // do body para não pagar o custo de páginas grandes.
  try {
    const snippet = (await page.locator('body').innerText({ timeout: 2_000 })).slice(0, 3_000).toLowerCase();
    const hit = CHALLENGE_TEXT.find((phrase) => snippet.includes(phrase));
    if (hit) {
      return { blocked: true, reason: 'captcha', evidence: `Texto de desafio na página: "${hit}"` };
    }
  } catch {
    /* página pode estar navegando; ausência de texto não é sinal de bloqueio */
  }

  return { blocked: false };
}
