import { createTask } from 'node-cron';
import { schedules } from '../db/index.js';
import { logger } from '../logger.js';
import type { Job } from '../queue/queue.js';
import type { Schedule } from '../types/schema.js';

/**
 * O disparo em si depende de navegador/perfil/fila reais — não é pura por
 * natureza. Isolada atrás desta interface mínima para que `runDueSchedules`
 * continue testável sem `Maestro` de verdade (mesmo espírito de injetar um
 * handler falso em `JobQueue` nos testes de fila).
 */
export interface ScheduleEnqueuer {
  enqueueSchedule(schedule: Schedule): Job[];
}

/**
 * `node-cron` expõe `match(date)` num `ScheduledTask` sem nunca iniciar o
 * timer interno (`createTask` não agenda nada, só compila a expressão) — dá
 * para perguntar "essa expressão bate com este instante?" sem efeito
 * colateral algum, o que é exatamente o que o tick precisa: uma checagem
 * pontual, não um agendador rodando em segundo plano.
 */
export function isDue(schedule: Schedule, now: Date): boolean {
  const task = createTask(schedule.cron, () => undefined);
  try {
    return task.match(now);
  } finally {
    void task.destroy();
  }
}

/**
 * Chave de idempotência do tick: dois disparos dentro do mesmo minuto contam
 * como o mesmo disparo. Sem isso, invocações próximas do `schedule tick`
 * (ex.: uma tarefa do Windows atrasada que se sobrepõe à seguinte) poderiam
 * enfileirar o mesmo agendamento duas vezes.
 */
export function minuteKey(date: Date): string {
  return date.toISOString().slice(0, 16); // "AAAA-MM-DDTHH:MM"
}

export interface TickResult {
  checked: number;
  fired: Array<{ schedule: Schedule; jobs: Job[] }>;
  skipped: Array<{ schedule: Schedule; reason: string }>;
}

/**
 * Avalia todos os agendamentos habilitados contra `now` e dispara os que
 * baterem. Usada tanto por `schedule tick` (um disparo, chamado
 * periodicamente pelo Agendador de Tarefas do Windows) quanto por
 * `schedule run` para um único agendamento.
 *
 * Falha ao enfileirar um agendamento (perfil com sessão expirada, fluxo
 * removido etc.) não impede os demais — mesmo princípio de isolamento de
 * falhas da fila (RNF-013).
 */
export function runDueSchedules(enqueuer: ScheduleEnqueuer, now: Date = new Date()): TickResult {
  const all = schedules.list().filter((s) => s.enabled);
  const key = minuteKey(now);

  const fired: TickResult['fired'] = [];
  const skipped: TickResult['skipped'] = [];

  for (const schedule of all) {
    if (!isDue(schedule, now)) continue;
    if (schedule.lastFiredKey === key) continue; // já disparado neste minuto

    try {
      const jobs = enqueuer.enqueueSchedule(schedule);
      schedules.recordFire(schedule.id, key);
      fired.push({ schedule, jobs });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn({ scheduleId: schedule.id, err: reason }, 'Agendamento não pôde ser disparado');
      skipped.push({ schedule, reason });
    }
  }

  return { checked: all.length, fired, skipped };
}
