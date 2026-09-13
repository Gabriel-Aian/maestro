import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths, ensureDataDirs } from '../config/paths.js';
import { FlowSchema, type Flow } from '../types/schema.js';
import { flowsIndex } from '../db/index.js';
import { logger } from '../logger.js';

/**
 * Armazenamento de fluxos em arquivo, com histórico de versões (RF-037).
 *
 * Cada salvamento arquiva a versão anterior em `flows/<id>/<timestamp>.json`
 * antes de sobrescrever. Edição de fluxo quebra com frequência — sem poder
 * voltar, o usuário perde uma gravação que custou tempo real para produzir.
 */
export function saveFlow(flow: Flow): Flow {
  ensureDataDirs();
  const parsed = FlowSchema.parse({ ...flow, updatedAt: new Date().toISOString() });
  const target = paths.flowFile(parsed.id);

  if (existsSync(target)) {
    const versionsDir = paths.flowVersionsDir(parsed.id);
    mkdirSync(versionsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    copyFileSync(target, join(versionsDir, `${stamp}.json`));
  }

  writeFileSync(target, JSON.stringify(parsed, null, 2), 'utf8');
  flowsIndex.upsert({
    id: parsed.id,
    name: parsed.name,
    startUrl: parsed.startUrl,
    stepCount: parsed.steps.length,
    needsReview: parsed.needsReview,
    updatedAt: parsed.updatedAt,
  });

  logger.info({ flowId: parsed.id, steps: parsed.steps.length }, 'Fluxo salvo');
  return parsed;
}

export function loadFlow(id: string): Flow {
  const file = paths.flowFile(id);
  if (!existsSync(file)) {
    throw new Error(`Fluxo "${id}" não encontrado em ${file}.`);
  }
  return FlowSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
}

export function listFlowVersions(id: string): string[] {
  const dir = paths.flowVersionsDir(id);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).sort().reverse();
}

export function restoreFlowVersion(id: string, versionFile: string): Flow {
  const source = join(paths.flowVersionsDir(id), versionFile);
  if (!existsSync(source)) throw new Error(`Versão "${versionFile}" não existe para o fluxo ${id}.`);
  const flow = FlowSchema.parse(JSON.parse(readFileSync(source, 'utf8')));
  return saveFlow(flow);
}
