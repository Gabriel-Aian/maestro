import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import pino from 'pino';
import { paths } from './config/paths.js';

/** Valores a mascarar em logs — preenchido por execução com variáveis sensíveis (RNF-005). */
const secrets = new Set<string>();

export function registerSecret(value: string): void {
  if (value && value.length >= 3) secrets.add(value);
}

export function clearSecrets(): void {
  secrets.clear();
}

export function redact(text: string): string {
  let out = text;
  for (const secret of secrets) out = out.split(secret).join('«oculto»');
  return out;
}

function dailyLogPath(): string {
  mkdirSync(paths.logs, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  return join(paths.logs, `maestro-${day}.jsonl`);
}

/**
 * Log estruturado em JSON Lines com rotação diária (RNF-024).
 * O hook de método aplica o mascaramento de segredos antes de a mensagem
 * chegar ao transporte, cobrindo arquivo e stderr de uma vez só.
 */
export const logger = pino(
  {
    level: process.env.MAESTRO_LOG_LEVEL ?? 'info',
    timestamp: pino.stdTimeFunctions.isoTime,
    hooks: {
      logMethod(args, method) {
        const patched = args.map((a) => {
          if (typeof a === 'string') return redact(a);
          if (a && typeof a === 'object') {
            const out: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(a)) out[k] = typeof v === 'string' ? redact(v) : v;
            return out;
          }
          return a;
        });
        return method.apply(this, patched as never);
      },
    },
  },
  pino.multistream([
    { stream: createWriteStream(dailyLogPath(), { flags: 'a' }), level: 'debug' },
    { stream: process.stderr, level: 'warn' },
  ]),
);

/** Logger filho carregando o id de correlação da execução (RNF-025). */
export function runLogger(runId: string) {
  return logger.child({ runId });
}
