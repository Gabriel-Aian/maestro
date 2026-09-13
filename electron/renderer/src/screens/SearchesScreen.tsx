import { useEffect, useState } from 'react';
import type { FlowRunDetail, LoadSearchFileResult, SearchEngineOption, SearchFileView } from '../../../shared/ipc.js';
import { StatusBadge } from '../components/StatusBadge.js';
import { consumeJobCompletion, useJobEvents, type JobCompletion } from '../jobEvents.js';

function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

interface JobTracker {
  jobId: string;
  status: 'running' | 'done' | 'failed';
  profileName: string;
  error: string | null;
  detail: FlowRunDetail | null;
}

export function SearchesScreen() {
  const [filePath, setFilePath] = useState<string | null>(null);
  const [file, setFile] = useState<SearchFileView | null>(null);
  const [loadError, setLoadError] = useState<{ reason: string; issues?: { path: string; message: string }[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sampleSize, setSampleSize] = useState('');
  const [engines, setEngines] = useState<SearchEngineOption[]>([]);
  const [engineOverride, setEngineOverride] = useState('');
  const [delayMinS, setDelayMinS] = useState('');
  const [delayMaxS, setDelayMaxS] = useState('');
  const [headed, setHeaded] = useState(false);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<JobTracker[]>([]);

  function applyResult(result: LoadSearchFileResult | null): void {
    if (!result) {
      setFilePath(null);
      setFile(null);
      setLoadError(null);
      return;
    }
    if (result.ok) {
      setFilePath(result.file.filePath);
      setFile(result.file);
      setLoadError(null);
      setSelected(new Set(result.file.themes.filter((t) => t.enabled).map((t) => t.id)));
    } else {
      setFilePath(result.filePath);
      setFile(null);
      setLoadError(result);
    }
  }

  useEffect(() => {
    window.maestro
      .getLastSearchFile()
      .then(applyResult)
      .finally(() => setLoading(false));
    window.maestro.listSearchEngines().then(setEngines);
  }, []);

  // Ponto central do fluxo pedido: o usuário edita o arquivo por fora (por
  // isso o atalho "Abrir pasta") e volta para a janela — recarrega sozinho
  // em vez de exigir clicar em "Recarregar" toda vez.
  useEffect(() => {
    if (!filePath) return;
    const onFocus = () => {
      window.maestro.reloadSearchFile(filePath).then(applyResult);
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath]);

  async function pickFile(): Promise<void> {
    const result = await window.maestro.pickSearchFile();
    if (result) applyResult(result);
  }

  function reload(): void {
    if (!filePath) return;
    window.maestro.reloadSearchFile(filePath).then(applyResult);
  }

  function openFolder(): void {
    if (filePath) window.maestro.openSearchFileFolder(filePath);
  }

  function toggleTheme(id: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function applyCompletion(job: JobTracker, completion: JobCompletion): JobTracker {
    return { ...job, status: completion.outcome, error: completion.job.error };
  }

  function fetchDetail(jobId: string, runId: string): void {
    window.maestro.getRun(runId).then((detail) => {
      setJobs((prev) => (detail ? prev.map((j) => (j.jobId === jobId ? { ...j, detail } : j)) : prev));
    });
  }

  // Assinatura ativa desde o mount (não só depois de um Rodar) — ver
  // jobEvents.ts: um job que falha na hora pode terminar antes mesmo de
  // `runSearch` devolver os jobIds para este componente.
  useJobEvents((jobId, completion) => {
    setJobs((prev) => (prev.some((j) => j.jobId === jobId) ? prev.map((j) => (j.jobId === jobId ? applyCompletion(j, completion) : j)) : prev));
    if (completion.job.runId) fetchDetail(jobId, completion.job.runId);
  });

  async function run(): Promise<void> {
    if (!filePath) return;
    const n = sampleSize.trim() ? Number(sampleSize) : undefined;
    const delayMin = delayMinS.trim() ? Number(delayMinS) : undefined;
    const delayMax = delayMaxS.trim() ? Number(delayMaxS) : undefined;
    if ((delayMin !== undefined) !== (delayMax !== undefined)) {
      setRunError('Informe os dois campos de atraso (mínimo e máximo), ou deixe ambos em branco.');
      return;
    }
    setRunning(true);
    setRunError(null);
    setJobs([]);
    const result = await window.maestro.runSearch(filePath, {
      themeIds: [...selected],
      sampleSize: Number.isInteger(n) && n! > 0 ? n : undefined,
      engine: engineOverride || undefined,
      delayRangeMs: delayMin !== undefined && delayMax !== undefined ? [delayMin * 1000, delayMax * 1000] : undefined,
      headed,
    });
    setRunning(false);
    if (result.ok) {
      // consumeJobCompletion() é de uso único — chamado aqui uma vez por
      // jobId, guardando o resultado tanto para montar o estado inicial
      // quanto para já disparar a busca do detalhe, sem esperar outro evento
      // que nunca mais vai chegar (ele já aconteceu).
      const alreadyDone = result.jobIds.map((jobId) => [jobId, consumeJobCompletion(jobId)] as const);

      setJobs(
        alreadyDone.map(([jobId, completion]) => {
          const base: JobTracker = { jobId, status: 'running', profileName: '', error: null, detail: null };
          return completion ? applyCompletion(base, completion) : base;
        }),
      );

      for (const [jobId, completion] of alreadyDone) {
        if (completion?.job.runId) fetchDetail(jobId, completion.job.runId);
      }
    } else {
      setRunError(result.reason);
    }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h2>Pesquisas</h2>
          <p>Aponta para um arquivo de pesquisas em lote (RF-016 a RF-020) já existente no disco — edite-o com seu editor de preferência.</p>
        </div>
        <div className="toolbar" style={{ marginBottom: 0 }}>
          <button className="btn" onClick={pickFile}>
            {filePath ? 'Trocar arquivo…' : 'Selecionar arquivo…'}
          </button>
          {filePath && (
            <>
              <button className="btn" onClick={reload}>
                Recarregar
              </button>
              <button className="btn" onClick={openFolder}>
                Abrir pasta
              </button>
            </>
          )}
        </div>
      </div>

      {loading ? (
        <div className="card">
          <div className="empty-state">Carregando…</div>
        </div>
      ) : !filePath ? (
        <div className="card">
          <div className="empty-state">Nenhum arquivo selecionado ainda.</div>
        </div>
      ) : (
        <>
          <div className="mono text-muted" style={{ marginBottom: 14, wordBreak: 'break-all' }}>
            {filePath}
          </div>

          {loadError && (
            <div className="error-banner">
              {loadError.reason}
              {loadError.issues && loadError.issues.length > 0 && (
                <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                  {loadError.issues.map((issue, i) => (
                    <li key={i}>
                      {issue.path || '(raiz)'}: {issue.message}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {file && (
            <div className="card">
              <table>
                <thead>
                  <tr>
                    <th></th>
                    <th>Tema</th>
                    <th>Pesquisas</th>
                  </tr>
                </thead>
                <tbody>
                  {file.themes.map((theme) => (
                    <tr key={theme.id}>
                      <td>
                        <input
                          type="checkbox"
                          disabled={!theme.enabled}
                          checked={selected.has(theme.id)}
                          onChange={() => toggleTheme(theme.id)}
                        />
                      </td>
                      <td>
                        {theme.name}
                        {!theme.enabled && (
                          <span className="text-muted" style={{ marginLeft: 8 }}>
                            (desativado no arquivo)
                          </span>
                        )}
                      </td>
                      <td>{theme.queryCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{ padding: '14px', borderTop: '1px solid var(--border)' }}>
                <span className="text-muted" style={{ fontSize: 13 }}>
                  {file.totalQueries} pesquisa(s) no total, {selected.size} tema(s) selecionado(s)
                </span>
                <div className="toolbar" style={{ margin: '10px 0 0' }}>
                  <label style={{ fontSize: 13 }}>
                    Rodar apenas{' '}
                    <input
                      type="text"
                      placeholder="todas"
                      value={sampleSize}
                      onChange={(e) => setSampleSize(e.target.value)}
                      style={{ width: 50, textAlign: 'center' }}
                    />{' '}
                    pesquisa(s) sorteada(s)
                  </label>
                  <label style={{ fontSize: 13 }}>
                    Mecanismo{' '}
                    <select value={engineOverride} onChange={(e) => setEngineOverride(e.target.value)}>
                      <option value="">do arquivo</option>
                      {engines.map((eng) => (
                        <option key={eng.id} value={eng.id}>
                          {eng.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label style={{ fontSize: 13 }}>
                    Atraso entre pesquisas{' '}
                    <input
                      type="text"
                      placeholder="arquivo"
                      value={delayMinS}
                      onChange={(e) => setDelayMinS(e.target.value)}
                      style={{ width: 44, textAlign: 'center' }}
                    />{' '}
                    –{' '}
                    <input
                      type="text"
                      placeholder="arquivo"
                      value={delayMaxS}
                      onChange={(e) => setDelayMaxS(e.target.value)}
                      style={{ width: 44, textAlign: 'center' }}
                    />{' '}
                    s
                  </label>
                  <label style={{ fontSize: 13 }}>
                    <input type="checkbox" checked={headed} onChange={(e) => setHeaded(e.target.checked)} /> executar visível (debug)
                  </label>
                  <button className="btn btn-primary" disabled={running || selected.size === 0} onClick={run}>
                    {running ? 'Enfileirando…' : 'Rodar'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {runError && <div className="error-banner" style={{ marginTop: 14 }}>{runError}</div>}

          {jobs.length > 0 && (
            <div className="card" style={{ marginTop: 14 }}>
              <table>
                <thead>
                  <tr>
                    <th>Job</th>
                    <th>Status</th>
                    <th>Concluídas</th>
                    <th>Observação</th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.map((job) => {
                    const ok = job.detail?.steps.filter((s) => s.status === 'success').length ?? null;
                    const total = job.detail?.steps.length ?? null;
                    return (
                      <tr key={job.jobId}>
                        <td className="mono">{job.jobId}</td>
                        <td>
                          <StatusBadge status={job.status === 'running' ? 'running' : (job.detail?.status ?? job.status)} />
                        </td>
                        <td>{ok !== null && total !== null ? `${ok}/${total}` : '—'}</td>
                        <td className="text-muted">
                          {job.detail?.blockReason ? `bloqueado: ${job.detail.blockReason}` : (job.error ?? job.detail?.error ?? '—')}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
