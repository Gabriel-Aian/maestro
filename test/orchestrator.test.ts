import { describe, it, expect, beforeEach } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Maestro } from '../src/orchestrator.js';
import { profiles, schedules, getDb } from '../src/db/index.js';
import { saveFlow } from '../src/store/flowStore.js';
import { AppConfigSchema, ScheduleSchema, type ProfileStatus } from '../src/types/schema.js';

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
  getDb().exec('DELETE FROM schedules');
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

/**
 * `recordOutcome` (que grava `schedules.lastRunAt`/`lastStatus`) só roda
 * depois que o handler do job devolve um RunResult. Um job pode lançar ANTES
 * disso — perfil travado, navegador não detectado (o caso testado aqui, já
 * que este ambiente não tem Chromium instalado) — e sem o fix em
 * `Maestro.handle()` o agendamento ficava "nunca rodou" para sempre, mesmo
 * falhando a cada tick.
 */
describe('Maestro — agendamento registra falha mesmo quando o job lança antes de um RunResult', () => {
  it('grava lastStatus "failed" quando o navegador do perfil não é detectado', async () => {
    seedProfile('prof-1', 'conta-1');
    const now = new Date().toISOString();
    saveFlow({
      schemaVersion: 1,
      id: 'flow-teste',
      name: 'Fluxo de teste',
      startUrl: 'https://example.com/',
      viewport: { width: 1366, height: 768 },
      variables: [],
      steps: [{ index: 0, type: 'navigate', url: 'https://example.com/' }],
      createdAt: now,
      updatedAt: now,
      needsReview: false,
    });

    const schedule = ScheduleSchema.parse({
      id: 'sched-teste',
      name: 'Agendamento de teste',
      cron: '0 9 * * *',
      enabled: true,
      target: { kind: 'flow', flowId: 'flow-teste', profile: 'conta-1', variables: {} },
      createdAt: now,
      updatedAt: now,
    });
    schedules.insert(schedule);

    const maestro = new Maestro(AppConfigSchema.parse({}));
    await maestro.init();
    maestro.enqueueSchedule(schedule);
    await maestro.queue.waitForIdle();
    await maestro.shutdown();

    const updated = schedules.find('sched-teste');
    expect(updated?.lastStatus).toBe('failed');
    expect(updated?.lastRunAt).not.toBeNull();
  });
});
