import { describe, it, expect, beforeEach } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Maestro } from '../src/orchestrator.js';
import { profiles, getDb } from '../src/db/index.js';
import { AppConfigSchema, type ProfileStatus } from '../src/types/schema.js';

/**
 * `enqueueSearches` agrupa pesquisas por perfil e enfileira um job por grupo.
 * Antes da correção, a validação de cada perfil (RN-004) acontecia dentro do
 * mesmo laço que enfileira — um perfil inválido no meio do lote deixava os
 * jobs de perfis anteriores já enfileirados e rodando, enquanto o chamador
 * via só uma exceção, sem saber que algo tinha sido disparado mesmo assim.
 */
beforeEach(() => {
  getDb().exec('DELETE FROM jobs');
  getDb().exec('DELETE FROM profiles');
});

function seedProfile(id: string, name: string, status: ProfileStatus = 'authenticated'): void {
  profiles.insert({
    id,
    name,
    browserId: 'chrome',
    userDataDir: `/tmp/${id}`,
    status,
    lastUsedAt: null,
    createdAt: new Date().toISOString(),
  });
}

function writeSearchFile(themes: Array<{ id: string; profile: string }>): string {
  const dir = mkdtempSync(join(tmpdir(), 'maestro-search-'));
  const filePath = join(dir, 'searches.json');
  writeFileSync(
    filePath,
    JSON.stringify({
      schemaVersion: 1,
      defaults: { browser: 'chrome', engine: 'google', headless: true, delayBetweenSearchesMs: [100, 200], screenshot: 'none', maxRetries: 1 },
      themes: themes.map((t) => ({ id: t.id, name: t.id, enabled: true, profile: t.profile, queries: ['consulta'] })),
    }),
  );
  return filePath;
}

describe('Maestro.enqueueSearches — atomicidade por perfil (RN-004, mesmo princípio de RN-015)', () => {
  it('não enfileira nenhum job se qualquer perfil do lote for inválido, mesmo com outros perfis válidos', () => {
    seedProfile('prof-1', 'conta-1', 'authenticated');
    seedProfile('prof-2', 'conta-2', 'session_expired');

    const filePath = writeSearchFile([
      { id: 't1', profile: 'conta-1' },
      { id: 't2', profile: 'conta-2' },
    ]);

    const maestro = new Maestro(AppConfigSchema.parse({}));
    expect(() => maestro.enqueueSearches(filePath)).toThrow(/sessão expirada/);

    const count = getDb().prepare('SELECT COUNT(*) AS n FROM jobs').get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('enfileira um job por perfil quando todos são válidos', () => {
    seedProfile('prof-1', 'conta-1');
    seedProfile('prof-2', 'conta-2');

    const filePath = writeSearchFile([
      { id: 't1', profile: 'conta-1' },
      { id: 't2', profile: 'conta-2' },
    ]);

    const maestro = new Maestro(AppConfigSchema.parse({}));
    const jobs = maestro.enqueueSearches(filePath);

    expect(jobs).toHaveLength(2);
    const count = getDb().prepare('SELECT COUNT(*) AS n FROM jobs').get() as { n: number };
    expect(count.n).toBe(2);
  });
});
