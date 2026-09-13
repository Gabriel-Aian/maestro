import { describe, it, expect, beforeEach } from 'vitest';
import { JobQueue } from '../src/queue/queue.js';
import { getDb } from '../src/db/index.js';

/**
 * A fila é testada com um handler falso, sem navegador: as invariantes que
 * importam aqui — serialização por perfil e teto de concorrência — são de
 * escalonamento, não de automação. A raiz de dados vem do vitest.config.
 */
beforeEach(() => {
  getDb().exec('DELETE FROM jobs');
});

function fakeResult(runId: string) {
  return {
    runId,
    kind: 'flow' as const,
    status: 'success' as const,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: 1,
    artifactsDir: '',
    steps: [],
    degraded: false,
  };
}

describe('JobQueue — invariantes de escalonamento', () => {
  it('nunca roda dois jobs do mesmo perfil ao mesmo tempo (RN-001)', async () => {
    let concurrentOnProfile = 0;
    let maxConcurrentOnProfile = 0;

    const queue = new JobQueue(
      async (job: { id: string }) => {
        concurrentOnProfile += 1;
        maxConcurrentOnProfile = Math.max(maxConcurrentOnProfile, concurrentOnProfile);
        await new Promise((r) => setTimeout(r, 40));
        concurrentOnProfile -= 1;
        return fakeResult(job.id);
      },
      { maxConcurrent: 4, jobTimeoutMs: 10_000, pollIntervalMs: 10 },
    );

    queue.start();
    for (let i = 0; i < 4; i += 1) {
      queue.enqueue({ kind: 'flow', payload: {}, profileId: 'mesma-conta' });
    }

    await queue.waitForIdle();
    await queue.stop();

    expect(maxConcurrentOnProfile).toBe(1);
  });

  it('roda perfis diferentes em paralelo (RF-049, RF-050)', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;

    const queue = new JobQueue(
      async (job: { id: string }) => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 50));
        concurrent -= 1;
        return fakeResult(job.id);
      },
      { maxConcurrent: 3, jobTimeoutMs: 10_000, pollIntervalMs: 10 },
    );

    queue.start();
    queue.enqueue({ kind: 'flow', payload: {}, profileId: 'conta-1' });
    queue.enqueue({ kind: 'flow', payload: {}, profileId: 'conta-2' });
    queue.enqueue({ kind: 'search', payload: {}, profileId: 'conta-3' });

    await queue.waitForIdle();
    await queue.stop();

    expect(maxConcurrent).toBeGreaterThan(1);
  });

  it('respeita o teto global de navegadores simultâneos (RF-051)', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;

    const queue = new JobQueue(
      async (job: { id: string }) => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 40));
        concurrent -= 1;
        return fakeResult(job.id);
      },
      { maxConcurrent: 2, jobTimeoutMs: 10_000, pollIntervalMs: 10 },
    );

    queue.start();
    for (let i = 0; i < 6; i += 1) {
      queue.enqueue({ kind: 'flow', payload: {}, profileId: `conta-${i}` });
    }

    await queue.waitForIdle();
    await queue.stop();

    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  it('isola a falha de um job dos demais (RNF-013)', async () => {
    const completed: string[] = [];

    const queue = new JobQueue(
      async (job: { id: string; profileId: string }) => {
        if (job.profileId === 'quebrada') throw new Error('falha proposital');
        completed.push(job.profileId);
        return fakeResult(job.id);
      },
      { maxConcurrent: 3, jobTimeoutMs: 10_000, pollIntervalMs: 10 },
    );

    queue.start();
    queue.enqueue({ kind: 'flow', payload: {}, profileId: 'quebrada' });
    queue.enqueue({ kind: 'flow', payload: {}, profileId: 'ok-1' });
    queue.enqueue({ kind: 'flow', payload: {}, profileId: 'ok-2' });

    await queue.waitForIdle();
    await queue.stop();

    expect(completed.sort()).toEqual(['ok-1', 'ok-2']);
  });

  it('aborta job que excede o tempo máximo (RNF-014)', async () => {

    const queue = new JobQueue(
      (_job: unknown, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('abortado')));
        }),
      { maxConcurrent: 1, jobTimeoutMs: 120, pollIntervalMs: 10 },
    );

    queue.start();
    queue.enqueue({ kind: 'flow', payload: {}, profileId: 'travada' });

    await queue.waitForIdle();
    await queue.stop();

    expect(queue.activeCount).toBe(0);
  });

  it('kill switch cancela pendentes e limpa a fila (RF-054)', async () => {

    const queue = new JobQueue(
      async (job: { id: string }) => {
        await new Promise((r) => setTimeout(r, 500));
        return fakeResult(job.id);
      },
      { maxConcurrent: 1, jobTimeoutMs: 10_000, pollIntervalMs: 10 },
    );

    queue.start();
    for (let i = 0; i < 5; i += 1) queue.enqueue({ kind: 'flow', payload: {}, profileId: `c-${i}` });

    await new Promise((r) => setTimeout(r, 60));
    await queue.killAll();

    expect(queue.pendingCount()).toBe(0);
  });
});
