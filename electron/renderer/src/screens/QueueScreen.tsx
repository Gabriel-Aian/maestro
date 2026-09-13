import { useCallback, useEffect, useState } from 'react';
import type { QueueJobView } from '../../../shared/ipc.js';
import { StatusBadge } from '../components/StatusBadge.js';

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function QueueScreen() {
  const [jobs, setJobs] = useState<QueueJobView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyJobId, setBusyJobId] = useState<string | null>(null);
  const [killing, setKilling] = useState(false);

  const refresh = useCallback(() => {
    window.maestro
      .listQueue()
      .then(setJobs)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    refresh();
    return window.maestro.onQueueEvent(() => refresh());
  }, [refresh]);

  async function cancel(jobId: string): Promise<void> {
    setBusyJobId(jobId);
    try {
      await window.maestro.cancelJob(jobId);
      refresh();
    } finally {
      setBusyJobId(null);
    }
  }

  async function killAll(): Promise<void> {
    if (!window.confirm('Isso cancela todos os jobs pendentes e interrompe os em execução agora. Continuar?')) return;
    setKilling(true);
    try {
      await window.maestro.killAllJobs();
      refresh();
    } finally {
      setKilling(false);
    }
  }

  const active = jobs?.filter((j) => j.status === 'pending' || j.status === 'running') ?? [];
  const recent = jobs?.filter((j) => j.status !== 'pending' && j.status !== 'running') ?? [];

  return (
    <div>
      <div className="page-header">
        <div>
          <h2>Fila</h2>
          <p>Jobs pendentes e em execução (RF-052). Cada perfil roda no máximo um job por vez (RN-001).</p>
        </div>
        <div className="toolbar" style={{ marginBottom: 0 }}>
          <button className="btn" onClick={refresh}>
            Atualizar
          </button>
          <button className="btn btn-danger" onClick={killAll} disabled={killing || active.length === 0}>
            {killing ? 'Parando…' : 'Parar tudo'}
          </button>
        </div>
      </div>

      {error && <div className="error-banner">Erro ao consultar a fila: {error}</div>}

      <JobTable
        jobs={active}
        emptyLabel="Nenhum job pendente ou em execução."
        onCancel={cancel}
        busyJobId={busyJobId}
        loading={jobs === null}
      />

      {recent.length > 0 && (
        <>
          <h3 style={{ fontSize: 13, color: 'var(--text-muted)', margin: '24px 0 10px', textTransform: 'uppercase', letterSpacing: '0.03em' }}>
            Concluídos recentemente
          </h3>
          <JobTable jobs={recent.slice(0, 20)} emptyLabel="" onCancel={cancel} busyJobId={busyJobId} loading={false} />
        </>
      )}
    </div>
  );
}

function JobTable({
  jobs,
  emptyLabel,
  onCancel,
  busyJobId,
  loading,
}: {
  jobs: QueueJobView[];
  emptyLabel: string;
  onCancel: (id: string) => void;
  busyJobId: string | null;
  loading: boolean;
}) {
  if (loading) {
    return (
      <div className="card">
        <div className="empty-state">Carregando…</div>
      </div>
    );
  }

  if (jobs.length === 0) {
    return emptyLabel ? (
      <div className="card">
        <div className="empty-state">{emptyLabel}</div>
      </div>
    ) : null;
  }

  return (
    <div className="card">
      <table>
        <thead>
          <tr>
            <th>Status</th>
            <th>Tipo</th>
            <th>Alvo</th>
            <th>Perfil</th>
            <th>Criado em</th>
            <th>Tentativas</th>
            <th>Erro</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => (
            <tr key={job.id}>
              <td>
                <StatusBadge status={job.status} />
              </td>
              <td>{job.kind === 'flow' ? 'Fluxo' : 'Pesquisa'}</td>
              <td>{job.label}</td>
              <td>{job.profileName}</td>
              <td className="mono">{formatTime(job.createdAt)}</td>
              <td>{job.attempts}</td>
              <td className="text-muted" title={job.error ?? undefined}>
                {job.error ? job.error.slice(0, 60) : '—'}
              </td>
              <td>
                {(job.status === 'pending' || job.status === 'running') && (
                  <button className="btn btn-ghost" disabled={busyJobId === job.id} onClick={() => onCancel(job.id)}>
                    Cancelar
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
