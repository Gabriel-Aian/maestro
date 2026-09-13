import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { formatError } from '../src/errors.js';

/**
 * `ZodError.message` é o array de issues inteiro serializado em JSON — visto
 * ao vivo vazando pra tela de Configurações como `[ { "code": "too_big", ... } ]`
 * quando um campo violava um limite do `AppConfigSchema`. `formatError`
 * existe para nenhum chamador (CLI ou GUI) precisar lembrar disso sozinho.
 */
describe('formatError', () => {
  it('formata ZodError como "campo: mensagem", nunca o JSON cru dos issues', () => {
    const schema = z.object({ retries: z.number().max(10) });
    const result = schema.safeParse({ retries: 999 });
    expect(result.success).toBe(false);

    const message = formatError(result.error);
    expect(message).not.toContain('{');
    expect(message).toContain('retries');
  });

  it('usa "(raiz)" quando o issue não tem path (ex.: erro no valor de topo)', () => {
    const schema = z.string();
    const result = schema.safeParse(123);
    expect(result.success).toBe(false);

    expect(formatError(result.error)).toContain('(raiz)');
  });

  it('cai para err.message em erros comuns, igual ao comportamento anterior', () => {
    expect(formatError(new Error('algo falhou'))).toBe('algo falhou');
  });

  it('cai para String(err) quando nem é um Error', () => {
    expect(formatError('string crua')).toBe('string crua');
  });
});
