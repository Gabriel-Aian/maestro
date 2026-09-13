import { describe, it, expect } from 'vitest';
import { detectBlock } from '../src/engine/blockDetection.js';
import type { Page } from 'playwright-core';

/**
 * Page falso: a detecção depende só de URL, frames e texto do body, então um
 * dublê cobre os casos que importam sem precisar de navegador.
 */
function fakePage(url: string, opts: { frames?: string[]; text?: string } = {}): Page {
  return {
    url: () => url,
    frames: () => (opts.frames ?? []).map((f) => ({ url: () => f })),
    locator: () => ({ innerText: async () => opts.text ?? '' }),
  } as unknown as Page;
}

describe('detectBlock — parede de login', () => {
  it('não bloqueia quando o fluxo pede a tela de login de propósito', async () => {
    const page = fakePage('https://app.exemplo.com/login');
    const result = await detectBlock(page, { intendedUrl: 'https://app.exemplo.com/login' });
    expect(result.blocked).toBe(false);
  });

  it('não bloqueia caminho genérico de login sem evidência de redirecionamento', async () => {
    // Sem intendedUrl não dá para saber se houve desvio; na dúvida, deixa passar.
    const page = fakePage('https://app.exemplo.com/auth/callback');
    const result = await detectBlock(page, {});
    expect(result.blocked).toBe(false);
  });

  it('bloqueia quando pedimos o painel e caímos no login', async () => {
    const page = fakePage('https://app.exemplo.com/login?next=/painel');
    const result = await detectBlock(page, { intendedUrl: 'https://app.exemplo.com/painel' });
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('login_wall');
  });

  it('bloqueia redirecionamento para provedor de identidade mesmo sem URL pretendida', async () => {
    const page = fakePage('https://accounts.google.com/v3/signin/identifier');
    const result = await detectBlock(page, {});
    expect(result).toMatchObject({ blocked: true, reason: 'login_wall' });
  });

  it('ignora diferença apenas de query string', async () => {
    const page = fakePage('https://app.exemplo.com/painel?aba=2');
    const result = await detectBlock(page, { intendedUrl: 'https://app.exemplo.com/painel' });
    expect(result.blocked).toBe(false);
  });

  it('respeita o desligamento da checagem de login', async () => {
    const page = fakePage('https://accounts.google.com/ServiceLogin');
    const result = await detectBlock(page, { detectLoginWall: false });
    expect(result.blocked).toBe(false);
  });
});

describe('detectBlock — desafios', () => {
  it('bloqueia CAPTCHA mesmo com a checagem de login desligada', async () => {
    const page = fakePage('https://exemplo.com/', { frames: ['https://www.google.com/recaptcha/api2/anchor'] });
    const result = await detectBlock(page, { detectLoginWall: false });
    expect(result).toMatchObject({ blocked: true, reason: 'captcha' });
  });

  it('bloqueia interstício de tráfego incomum', async () => {
    const page = fakePage('https://www.google.com/sorry/index?continue=x');
    expect((await detectBlock(page, {})).blocked).toBe(true);
  });

  it('detecta desafio pelo texto da página em português', async () => {
    const page = fakePage('https://exemplo.com/', { text: 'Nossos sistemas detectaram tráfego incomum' });
    const result = await detectBlock(page, {});
    expect(result).toMatchObject({ blocked: true, reason: 'captcha' });
  });

  it('não bloqueia uma página comum', async () => {
    const page = fakePage('https://app.exemplo.com/painel', { text: 'Pedidos do mês' });
    expect((await detectBlock(page, { intendedUrl: 'https://app.exemplo.com/painel' })).blocked).toBe(false);
  });
});
