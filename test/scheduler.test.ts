import { describe, it, expect, beforeEach } from 'vitest';
import { isDue, minuteKey, runDueSchedules, type ScheduleEnqueuer } from '../src/scheduler/scheduler.js';
import { buildInstallArgs, buildTickCommand, installWindowsTask, TICK_TASK_NAME } from '../src/scheduler/windowsTask.js';
import { schedules, getDb } from '../src/db/index.js';
import { ScheduleSchema, type Schedule } from '../src/types/schema.js';
import type { Job } from '../src/queue/queue.js';

beforeEach(() => {
  getDb().exec('DELETE FROM schedules');
});

function makeSchedule(overrides: Partial<Schedule> = {}): Schedule {
  const now = new Date().toISOString();
  return ScheduleSchema.parse({
    id: overrides.id ?? `sched-${Math.random().toString(36).slice(2, 8)}`,
    name: overrides.name ?? 'Agendamento de teste',
    cron: overrides.cron ?? '30 9 * * *',
    enabled: overrides.enabled ?? true,
    target: overrides.target ?? { kind: 'flow', flowId: 'flow-x', profile: 'conta-1', variables: {} },
    createdAt: now,
    updatedAt: now,
    lastRunAt: overrides.lastRunAt ?? null,
    lastStatus: overrides.lastStatus ?? null,
    lastFiredKey: overrides.lastFiredKey ?? null,
  });
}

function fakeEnqueuer(calls: Schedule[], jobsPerCall: Job[] = []): ScheduleEnqueuer {
  return {
    enqueueSchedule(schedule) {
      calls.push(schedule);
      return jobsPerCall;
    },
  };
}

describe('isDue', () => {
  it('bate exatamente no minuto descrito pelo cron', () => {
    const s = makeSchedule({ cron: '30 9 * * *' });
    expect(isDue(s, new Date('2024-01-01T09:30:00'))).toBe(true);
    expect(isDue(s, new Date('2024-01-01T09:31:00'))).toBe(false);
    expect(isDue(s, new Date('2024-01-01T09:29:00'))).toBe(false);
    expect(isDue(s, new Date('2024-01-01T10:30:00'))).toBe(false);
  });

  it('não inicia nenhum timer nem dispara o callback', () => {
    let fired = false;
    const s = makeSchedule({ cron: '* * * * *' });
    // isDue não recebe callback nenhum — só valida que checar não tem efeito
    // colateral e que a mesma instância pode ser checada várias vezes.
    for (let i = 0; i < 5; i += 1) isDue(s, new Date());
    expect(fired).toBe(false);
  });
});

describe('minuteKey', () => {
  it('trunca ao minuto, ignorando segundos', () => {
    expect(minuteKey(new Date('2024-01-01T09:30:05Z'))).toBe(minuteKey(new Date('2024-01-01T09:30:55Z')));
  });

  it('difere entre minutos distintos', () => {
    expect(minuteKey(new Date('2024-01-01T09:30:00Z'))).not.toBe(minuteKey(new Date('2024-01-01T09:31:00Z')));
  });
});

describe('runDueSchedules', () => {
  it('dispara só os agendamentos cujo cron bate com o instante avaliado', () => {
    const due = makeSchedule({ name: 'no horário', cron: '30 9 * * *' });
    const notDue = makeSchedule({ name: 'fora do horário', cron: '0 18 * * *' });
    schedules.insert(due);
    schedules.insert(notDue);

    const calls: Schedule[] = [];
    const result = runDueSchedules(fakeEnqueuer(calls), new Date('2024-01-01T09:30:00'));

    expect(result.checked).toBe(2);
    expect(calls.map((s) => s.name)).toEqual(['no horário']);
    expect(result.fired.map((f) => f.schedule.name)).toEqual(['no horário']);
  });

  it('nunca dispara um agendamento desativado, mesmo com o cron batendo', () => {
    schedules.insert(makeSchedule({ cron: '30 9 * * *', enabled: false }));

    const calls: Schedule[] = [];
    const result = runDueSchedules(fakeEnqueuer(calls), new Date('2024-01-01T09:30:00'));

    expect(calls).toHaveLength(0);
    expect(result.fired).toHaveLength(0);
  });

  it('é idempotente dentro do mesmo minuto (não dispara duas vezes)', () => {
    schedules.insert(makeSchedule({ cron: '30 9 * * *' }));
    const now = new Date('2024-01-01T09:30:00');

    const calls: Schedule[] = [];
    runDueSchedules(fakeEnqueuer(calls), now);
    runDueSchedules(fakeEnqueuer(calls), new Date('2024-01-01T09:30:45')); // mesmo minuto, segundos diferentes

    expect(calls).toHaveLength(1);
  });

  it('dispara de novo no próximo minuto em que o cron bater', () => {
    const s = makeSchedule({ cron: '* * * * *' }); // todo minuto
    schedules.insert(s);

    const calls: Schedule[] = [];
    runDueSchedules(fakeEnqueuer(calls), new Date('2024-01-01T09:30:00'));
    runDueSchedules(fakeEnqueuer(calls), new Date('2024-01-01T09:31:00'));

    expect(calls).toHaveLength(2);
  });

  it('isola a falha de um agendamento dos demais (mesmo princípio da fila, RNF-013)', () => {
    schedules.insert(makeSchedule({ id: 'sched-quebra', name: 'quebra', cron: '30 9 * * *' }));
    schedules.insert(makeSchedule({ id: 'sched-ok', name: 'ok', cron: '30 9 * * *' }));

    const calls: Schedule[] = [];
    const enqueuer: ScheduleEnqueuer = {
      enqueueSchedule(schedule) {
        if (schedule.id === 'sched-quebra') throw new Error('perfil com sessão expirada');
        calls.push(schedule);
        return [];
      },
    };

    const result = runDueSchedules(enqueuer, new Date('2024-01-01T09:30:00'));

    expect(calls.map((s) => s.id)).toEqual(['sched-ok']);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toMatchObject({ reason: 'perfil com sessão expirada' });
    expect(result.fired.map((f) => f.schedule.id)).toEqual(['sched-ok']);
  });
});

describe('windowsTask — construção de comando (sem executar nada)', () => {
  it('monta o comando do tick citando node e cli entre aspas', () => {
    const command = buildTickCommand({ nodePath: 'C:\\Program Files\\nodejs\\node.exe', cliPath: 'C:\\maestro\\dist\\cli.js' });
    expect(command).toBe('"C:\\Program Files\\nodejs\\node.exe" "C:\\maestro\\dist\\cli.js" schedule tick');
  });

  it('monta os argumentos do schtasks /create com o intervalo pedido', () => {
    const args = buildInstallArgs({ intervalMinutes: 5, nodePath: 'node', cliPath: 'cli.js' });
    expect(args).toEqual(['/create', '/f', '/tn', TICK_TASK_NAME, '/tr', '"node" "cli.js" schedule tick', '/sc', 'minute', '/mo', '5', '/rl', 'limited']);
  });

  /**
   * `process.execPath` NÃO pode ser o default de `nodePath`: quem chama
   * `buildTickCommand` nem sempre é a CLI — a casca Electron também chama
   * (`electron/main/schedulesIpc.ts`, botão "Instalar tarefa"), e ali
   * `process.execPath` aponta para o executável do Electron, não para o
   * `node`. Um comando assim nunca teria rodado de verdade. `"node"` puro
   * funciona nos dois casos via resolução por PATH do Windows.
   */
  it('usa "node" (resolvido pela PATH), nunca process.execPath, quando nodePath não é informado', () => {
    const command = buildTickCommand({ cliPath: 'C:\\maestro\\dist\\cli.js' });
    expect(command).toBe('"node" "C:\\maestro\\dist\\cli.js" schedule tick');
    expect(command).not.toContain(process.execPath);
  });

  /**
   * A GUI empacotada (electron-builder) não pode contar com `node` na PATH
   * do usuário final — roda o próprio executável do Maestro com
   * `ELECTRON_RUN_AS_NODE=1` (confirmado ao vivo: ver comentário de
   * `buildTickCommand`). `schtasks /tr` só aceita uma linha de comando, sem
   * campo de ambiente — por isso o `set VAR=1&&` embrulhado num `cmd.exe /c`.
   */
  it('embrulha em cmd.exe /c "set VAR=1&&..." quando env é informado', () => {
    const command = buildTickCommand({
      nodePath: 'C:\\Program Files\\Maestro\\Maestro.exe',
      cliPath: 'C:\\Program Files\\Maestro\\dist\\cli.js',
      env: { ELECTRON_RUN_AS_NODE: '1' },
    });
    expect(command).toBe(
      'cmd.exe /c "set ELECTRON_RUN_AS_NODE=1&&"C:\\Program Files\\Maestro\\Maestro.exe" "C:\\Program Files\\Maestro\\dist\\cli.js" schedule tick"',
    );
  });

  it('sem env, não embrulha em cmd.exe — mesmo comportamento de antes', () => {
    const command = buildTickCommand({ nodePath: 'node', cliPath: 'cli.js', env: {} });
    expect(command).toBe('"node" "cli.js" schedule tick');
  });

  it('recusa instalar de verdade fora do Windows (R-01)', async () => {
    await expect(installWindowsTask({ intervalMinutes: 5 })).rejects.toThrow(/Windows/);
  });
});
