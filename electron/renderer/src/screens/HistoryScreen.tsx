import { useCallback, useEffect, useState } from 'react';
import type { HistoryRunView } from '../../../shared/ipc.js';
import { StatusBadge } from '../components/StatusBadge.js';

const PAGE_SIZE = 25;
const STATUSES = ['pending', 'running', 'success', 'failed', 'blocked', 'cancelled', 'timeout'];

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function HistoryScreen() {
  const [status, setStatus] = useState('');
  const [kind, setKind] = useState('');
  const [rows, setRows] = useState<HistoryRunView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);

  const load = useCallback((offset: number, replace: boolean) => {
    setLoading(true);
    window.maestro
      .listHistory({ status: status || undefined, kind: kind || undefined, limit: PAGE_SIZE, offset })
      .then((page) => {
        setRows((prev) => (replace ? page : [...prev, ...page]));
        setHasMore(page.length === PAGE_SIZE);
        setError(null);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [status, kind]);

  useEffect(() => {
    load(0, true);
    return window.maestro.onQueueEvent((event) => {
      if (event.type === 'finished' || event.type === 'failed') load(0, true);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, kind]);

  return (
    <div>
      <div className="page-header">
        <div>
          <h2>Histórico</h2>
          <p>Execuções de fluxos e pesquisas já concluídas (RF-074).</p>
        </div>
      </div>

      <div className="toolbar">
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Todos os status</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">Fluxos e pesquisas</option>
          <option value="flow">Só fluxos</option>
          <option value="search">Só pesquisas</option>
        </select>
        <button className="btn" onClick={() => load(0, true)}>
          Atualizar
        </button>
      </div>

      {error && <div className="error-banner">Erro ao consultar o histórico: {error}</div>}

      {rows.length === 0 && !loading ? (
        <div className="card">
          <div className="empty-state">Nenhuma execução registrada com esse filtro.</div>
        </div>
      ) : (
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>Status</th>
                <th>Tipo</th>
                <th>Alvo</th>
                <th>Perfil</th>
                <th>Início</th>
                <th>Duração</th>
                <th>Observação</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((run) => (
                <tr key={run.id}>
                  <td>
                    <StatusBadge status={run.status} />
                  </td>
                  <td>{run.kind === 'flow' ? 'Fluxo' : 'Pesquisa'}</td>
                  <td>{run.targetName ?? '—'}</td>
                  <td>{run.profileName ?? '—'}</td>
                  <td className="mono">{formatTime(run.startedAt)}</td>
                  <td>{formatDuration(run.durationMs)}</td>
                  <td className="text-muted" title={run.error ?? undefined}>
                    {run.degraded && <span title="Algum passo usou seletor de fallback (RN-006)">⚠ degradado </span>}
                    {run.blockReason ? `bloqueado: ${run.blockReason}` : run.error ? run.error.slice(0, 50) : run.degraded ? null : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {hasMore && (
        <div style={{ textAlign: 'center', marginTop: 16 }}>
          <button className="btn" disabled={loading} onClick={() => load(rows.length, false)}>
            {loading ? 'Carregando…' : 'Carregar mais'}
          </button>
        </div>
      )}
    </div>
  );
}
