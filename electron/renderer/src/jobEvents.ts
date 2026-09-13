import { useEffect, useRef } from 'react';
import type { QueueEvent, QueueJobView } from '../../shared/ipc.js';

export interface JobCompletion {
  job: QueueJobView;
  outcome: 'done' | 'failed';
}

/**
 * Um job que falha na hora (ex.: "navegador não detectado", um throw
 * síncrono) pode terminar e disparar seu evento de fila antes mesmo de a
 * chamada que o criou (`runFlow`/`runSearch`) retornar para o renderer —
 * visto ao vivo neste projeto. Se a tela só passa a "ligar" para aquele
 * jobId depois desse retorno (setJobId/setJobs), o evento já passou e o
 * resultado nunca aparece; a tela fica presa em "Executando…" para sempre.
 *
 * Por isso um buffer módulo-level: toda conclusão fica guardada aqui até
 * alguém consumi-la, independente de quando a tela decidiu que aquele job
 * importa.
 */
const buffer = new Map<string, JobCompletion>();
const MAX_BUFFER = 200;

function remember(jobId: string, completion: JobCompletion): void {
  buffer.set(jobId, completion);
  if (buffer.size > MAX_BUFFER) {
    const oldest = buffer.keys().next().value;
    if (oldest !== undefined) buffer.delete(oldest);
  }
}

/** Consulta e remove — chame logo depois de descobrir um jobId, antes de exibir "em execução". */
export function consumeJobCompletion(jobId: string): JobCompletion | undefined {
  const completion = buffer.get(jobId);
  if (completion) buffer.delete(jobId);
  return completion;
}

/**
 * Assina os eventos de fila uma única vez (efeito sem dependências) e
 * alimenta o buffer global, além de repassar cada conclusão ao callback mais
 * recente — via ref, para não exigir re-assinar quando o callback muda.
 */
export function useJobEvents(onCompletion: (jobId: string, completion: JobCompletion) => void): void {
  const handlerRef = useRef(onCompletion);
  handlerRef.current = onCompletion;

  useEffect(
    () =>
      window.maestro.onQueueEvent((event: QueueEvent) => {
        if (event.type !== 'finished' && event.type !== 'failed') return;
        const completion: JobCompletion = { job: event.job, outcome: event.type === 'finished' ? 'done' : 'failed' };
        remember(event.job.id, completion);
        handlerRef.current(event.job.id, completion);
      }),
    [],
  );
}
