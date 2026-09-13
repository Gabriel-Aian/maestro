import { useCallback, useEffect, useState } from 'react';
import type { FlowDetailView, FlowListItem, FlowRunDetail, ProfileView, RecordFlowStatusView } from '../../../shared/ipc.js';
import { StatusBadge } from '../components/StatusBadge.js';
import { consumeJobCompletion, useJobEvents, type JobCompletion } from '../jobEvents.js';

function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function FlowsScreen() {
  const [flows, setFlows] = useState<FlowListItem[] | null>(null);
  const [profiles, setProfiles] = useState<ProfileView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const refresh = useCallback(() => {
    window.maestro
      .listFlows()
      .then(setFlows)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    refresh();
    window.maestro.listProfiles().then(setProfiles);
  }, [refresh]);

  return (
    <div>
      <div className="page-header">
        <div>
          <h2>Fluxos</h2>
          <p>Grave um fluxo novo abaixo ou pela CLI (`maestro record`). Rodar aqui dispara direto na fila e mostra o resultado ao final, sem confirmação passo a passo.</p>
        </div>
        <button className="btn" onClick={refresh}>
          Atualizar
        </button>
      </div>

      <RecordFlowCard profiles={profiles} onRecorded={refresh} />

      {error && <div className="error-banner">{error}</div>}

      {flows === null ? (
        <div className="card">
          <div className="empty-state">Carregando…</div>
        </div>
      ) : flows.length === 0 ? (
        <div className="card">
          <div className="empty-state">Nenhum fluxo gravado ainda. Use o formulário acima ou "maestro record" na linha de comando.</div>
        </div>
      ) : (
        <div className="card">
          <table>
            <thead>
              <tr>
                <th></th>
                <th>Nome</th>
                <th>Passos</th>
                <th>Última execução</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {flows.map((flow) => (
                <FlowRow
                  key={flow.id}
                  flow={flow}
                  profiles={profiles}
                  expanded={expandedId === flow.id}
                  onToggle={() => setExpandedId(expandedId === flow.id ? null : flow.id)}
                  onRan={refresh}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * Gravação de fluxo pela GUI (RF-021 a RF-030) — mesma capacidade que já
 * existia só na CLI (`maestro record`). O estado de "gravando" vive no
 * processo principal (`electron/main/recordIpc.ts`), não aqui: por isso
 * busca o status ao montar (cobre reabrir a tela com uma gravação já em
 * andamento) e reage a `onRecordEvent` em vez de fazer polling, mesmo padrão
 * de fila/histórico.
 */
function RecordFlowCard({ profiles, onRecorded }: { profiles: ProfileView[]; onRecorded: () => void }) {
  const [status, setStatus] = useState<RecordFlowStatusView | null>(null);
  const [name, setName] = useState('');
  const [startUrl, setStartUrl] = useState('');
  const [profileId, setProfileId] = useState('');
  const [convertTimings, setConvertTimings] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [result, setResult] = useState<{ flowName: string; stepCount: number; needsReview: boolean; redactedCount: number } | null>(null);

  useEffect(() => {
    window.maestro.getRecordStatus().then(setStatus);
    return window.maestro.onRecordEvent(setStatus);
  }, []);

  useEffect(() => {
    if (!profileId && profiles.length > 0) setProfileId(profiles[0]!.id);
  }, [profiles, profileId]);

  async function start(): Promise<void> {
    setFormError(null);
    if (!name.trim()) return setFormError('Dê um nome ao fluxo.');
    if (!startUrl.trim()) return setFormError('Informe a URL inicial.');
    if (!profileId) return setFormError('Cadastre um perfil antes de gravar.');

    setBusy(true);
    setResult(null);
    const r = await window.maestro.startRecording({ name: name.trim(), startUrl: startUrl.trim(), profileId, convertTimings });
    setBusy(false);
    if (!r.ok) {
      setFormError(r.reason);
      return;
    }
    window.maestro.getRecordStatus().then(setStatus);
  }

  async function stop(): Promise<void> {
    setBusy(true);
    const r = await window.maestro.stopRecording();
    setBusy(false);
    if (!r.ok) {
      setFormError(r.reason);
      return;
    }
    setName('');
    setStartUrl('');
    setResult({ flowName: r.flowName, stepCount: r.stepCount, needsReview: r.needsReview, redactedCount: r.redactedCount });
    onRecorded();
  }

  async function cancel(): Promise<void> {
    setBusy(true);
    await window.maestro.cancelRecording();
    setBusy(false);
  }

  if (status?.recording) {
    return (
      <div className="card" style={{ padding: '14px 18px', marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span className="badge badge-running">gravando</span>
          <strong>{status.name}</strong>
          <span className="text-muted mono">{status.startUrl}</span>
          <span className="text-muted">perfil: {status.profileName}</span>
          <span className="text-muted">{status.eventCount} evento(s) capturado(s)</span>
        </div>
        <p className="text-muted" style={{ margin: '8px 0 12px', fontSize: 13 }}>
          Navegue normalmente na janela do navegador que abriu. Cliques, digitação e scroll são capturados. Alt+Clique em um elemento insere uma
          asserção de texto. Campos de senha nunca têm o valor gravado (RNF-001).
        </p>
        <div className="toolbar">
          <button className="btn btn-primary" disabled={busy} onClick={stop}>
            {busy ? 'Salvando…' : 'Parar e salvar'}
          </button>
          <button className="btn btn-ghost" disabled={busy} onClick={cancel}>
            Cancelar sem salvar
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="card" style={{ padding: '14px 18px', marginBottom: 16 }}>
      <div className="section-title">Gravar novo fluxo</div>
      <div className="toolbar" style={{ flexWrap: 'wrap' }}>
        <input placeholder="Nome do fluxo" value={name} onChange={(e) => setName(e.target.value)} style={{ minWidth: 180 }} />
        <input placeholder="URL inicial (https://…)" value={startUrl} onChange={(e) => setStartUrl(e.target.value)} style={{ minWidth: 260 }} />
        <select value={profileId} onChange={(e) => setProfileId(e.target.value)}>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <label style={{ fontSize: 13 }}>
          <input type="checkbox" checked={convertTimings} onChange={(e) => setConvertTimings(e.target.checked)} /> converter intervalos
          observados em esperas
        </label>
        <button className="btn btn-primary" disabled={busy || profiles.length === 0} onClick={start}>
          {busy ? 'Abrindo…' : 'Gravar'}
        </button>
      </div>
      {profiles.length === 0 && <p className="text-muted" style={{ fontSize: 13 }}>Cadastre um perfil na tela de Perfis antes de gravar.</p>}
      {formError && <div className="error-banner">{formError}</div>}
      {result && (
        <div className="card" style={{ marginTop: 10, padding: '10px 14px', background: '#fafaf9' }}>
          Fluxo "{result.flowName}" salvo com {result.stepCount} passo(s).
          {result.redactedCount > 0 && (
            <div style={{ marginTop: 6, color: '#92400e' }}>
              ⚠ {result.redactedCount} campo(s) de senha foram detectados e <strong>não</strong> tiveram o valor gravado (RNF-001). Abra o fluxo
              em "Ver e rodar" e substitua o passo pelo valor via uma variável sensível antes de rodar.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function FlowRow({
  flow,
  profiles,
  expanded,
  onToggle,
  onRan,
}: {
  flow: FlowListItem;
  profiles: ProfileView[];
  expanded: boolean;
  onToggle: () => void;
  onRan: () => void;
}) {
  return (
    <>
      <tr>
        <td>
          <button className="btn btn-ghost" onClick={onToggle}>
            {expanded ? '▾' : '▸'}
          </button>
        </td>
        <td>
          {flow.name}
          {flow.needsReview && (
            <span className="badge badge-blocked" style={{ marginLeft: 8 }} title="Algum passo usou seletor de fallback (RN-006)">
              revisar
            </span>
          )}
        </td>
        <td>{flow.stepCount}</td>
        <td>{flow.lastStatus ? <StatusBadge status={flow.lastStatus} /> : <span className="text-muted">nunca rodou</span>}</td>
        <td>
          <button className="btn btn-ghost" onClick={onToggle}>
            {expanded ? 'Fechar' : 'Ver e rodar'}
          </button>
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={5} style={{ background: '#fafaf9', padding: 0 }}>
            <FlowRunPanel flowId={flow.id} profiles={profiles} onRan={onRan} />
          </td>
        </tr>
      )}
    </>
  );
}

function FlowRunPanel({ flowId, profiles, onRan }: { flowId: string; profiles: ProfileView[]; onRan: () => void }) {
  const [detail, setDetail] = useState<FlowDetailView | null>(null);
  const [profileId, setProfileId] = useState('');
  const [headed, setHeaded] = useState(false);
  const [vars, setVars] = useState<Record<string, string>>({});
  const [jobId, setJobId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<FlowRunDetail | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  useEffect(() => {
    window.maestro.getFlow(flowId).then((d) => {
      setDetail(d);
      setVars(Object.fromEntries(d.variables.map((v) => [v.name, v.default])));
    });
  }, [flowId]);

  useEffect(() => {
    if (!profileId && profiles.length > 0) setProfileId(profiles[0]!.id);
  }, [profiles, profileId]);

  function handleCompletion(completion: JobCompletion): void {
    setRunning(false);
    onRan();
    if (completion.job.runId) {
      window.maestro.getRun(completion.job.runId).then(setResult);
    } else {
      setRunError(completion.job.error ?? 'Falhou antes de produzir um resultado.');
    }
  }

  // Assinatura ativa desde o mount, não só depois de setJobId — um job que
  // falha na hora (ex.: navegador não detectado) pode terminar e disparar
  // seu evento antes mesmo de `runFlow` devolver o jobId para este
  // componente. Sem isso a tela ficava presa em "Executando…" para sempre
  // nesse caso (visto ao vivo, não hipotético — ver jobEvents.ts).
  useJobEvents((completedJobId, completion) => {
    if (completedJobId === jobId) handleCompletion(completion);
  });

  async function run(): Promise<void> {
    setRunning(true);
    setRunError(null);
    setResult(null);
    const r = await window.maestro.runFlow(flowId, profileId, vars, headed);
    if (!r.ok) {
      setRunning(false);
      setRunError(r.reason);
      return;
    }
    setJobId(r.jobId);
    const already = consumeJobCompletion(r.jobId);
    if (already) handleCompletion(already);
  }

  if (!detail) {
    return <div className="empty-state">Carregando passos…</div>;
  }

  return (
    <div style={{ padding: '16px 20px' }}>
      <div style={{ marginBottom: 14 }}>
        <strong>URL inicial:</strong> <span className="mono">{detail.startUrl}</span>
      </div>

      <ol style={{ margin: '0 0 16px', paddingLeft: 20, fontSize: 13 }}>
        {detail.steps.map((step) => (
          <li key={step.index} style={{ marginBottom: 3 }}>
            <span style={{ fontWeight: 600 }}>{step.type}</span> {step.summary && <span className="mono">{step.summary}</span>}
            {step.note && <span className="text-muted"> — {step.note}</span>}
          </li>
        ))}
      </ol>

      {detail.variables.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div className="section-title">Variáveis</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            {detail.variables.map((v) => (
              <label key={v.name} style={{ fontSize: 12.5 }}>
                {v.name}
                {v.description && <span className="text-muted"> ({v.description})</span>}
                <br />
                <input
                  type={v.sensitive ? 'password' : 'text'}
                  value={vars[v.name] ?? ''}
                  onChange={(e) => setVars((prev) => ({ ...prev, [v.name]: e.target.value }))}
                  style={{ marginTop: 4 }}
                />
              </label>
            ))}
          </div>
        </div>
      )}

      <div className="toolbar">
        <select value={profileId} onChange={(e) => setProfileId(e.target.value)}>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <label style={{ fontSize: 13 }}>
          <input type="checkbox" checked={headed} onChange={(e) => setHeaded(e.target.checked)} /> executar visível
        </label>
        <button className="btn btn-primary" disabled={running || !profileId} onClick={run}>
          {running ? 'Executando…' : 'Executar'}
        </button>
      </div>

      {runError && <div className="error-banner">{runError}</div>}

      {result && (
        <div className="card" style={{ marginTop: 12 }}>
          <div style={{ padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 10 }}>
            <StatusBadge status={result.status} />
            <span className="text-muted">{formatDuration(result.durationMs)}</span>
            {result.degraded && <span title="Algum passo usou seletor de fallback (RN-006)">⚠ degradado</span>}
            {result.blockReason && <span>bloqueado: {result.blockReason}</span>}
            {result.artifactsDir && <span className="mono text-muted">{result.artifactsDir}</span>}
          </div>
          {result.error && <div className="error-banner" style={{ margin: '0 14px 12px' }}>{result.error}</div>}
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Passo</th>
                <th>Status</th>
                <th>Duração</th>
                <th>Erro</th>
              </tr>
            </thead>
            <tbody>
              {result.steps.map((s) => (
                <tr key={s.index}>
                  <td>{s.index}</td>
                  <td>
                    {s.type}
                    {s.degraded && <span title="Resolvido por seletor de fallback"> ⚠</span>}
                  </td>
                  <td>
                    <StatusBadge status={s.status} />
                  </td>
                  <td>{formatDuration(s.durationMs)}</td>
                  <td className="text-muted" title={s.error ?? undefined}>
                    {s.error ? s.error.slice(0, 50) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
