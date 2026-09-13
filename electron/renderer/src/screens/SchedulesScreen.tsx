import { useCallback, useEffect, useState } from 'react';
import type {
  CreateScheduleInput,
  FlowDetailView,
  FlowListItem,
  ProfileView,
  ScheduleTargetView,
  ScheduleView,
  SearchThemeView,
  WindowsTaskStatusResult,
} from '../../../shared/ipc.js';
import { StatusBadge } from '../components/StatusBadge.js';

function formatTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function SchedulesScreen() {
  const [schedules, setSchedules] = useState<ScheduleView[] | null>(null);
  const [flows, setFlows] = useState<FlowListItem[]>([]);
  const [profiles, setProfiles] = useState<ProfileView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [runMessage, setRunMessage] = useState<string | null>(null);

  const refresh = useCallback(() => {
    window.maestro
      .listSchedules()
      .then(setSchedules)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    refresh();
    Promise.all([window.maestro.listFlows(), window.maestro.listProfiles()]).then(([f, p]) => {
      setFlows(f);
      setProfiles(p);
    });
  }, [refresh]);

  // "Rodar agora" só enfileira — o job termina depois, de forma assíncrona.
  // Sem reagir aos eventos da fila (mesmo padrão de QueueScreen/HistoryScreen),
  // "última execução" ficaria presa em "nunca rodou" até a próxima vez que a
  // tela fosse remontada.
  useEffect(() => window.maestro.onQueueEvent(() => refresh()), [refresh]);

  async function toggle(s: ScheduleView): Promise<void> {
    setBusyId(s.id);
    try {
      const result = await window.maestro.setScheduleEnabled(s.id, !s.enabled);
      if (result.ok) refresh();
      else setError(result.reason);
    } finally {
      setBusyId(null);
    }
  }

  async function remove(s: ScheduleView): Promise<void> {
    if (!window.confirm(`Remover o agendamento "${s.name}"?`)) return;
    setBusyId(s.id);
    try {
      await window.maestro.removeSchedule(s.id);
      refresh();
    } finally {
      setBusyId(null);
    }
  }

  async function run(s: ScheduleView): Promise<void> {
    setBusyId(s.id);
    setRunMessage(null);
    try {
      const result = await window.maestro.runSchedule(s.id);
      if (result.ok) {
        setRunMessage(`"${s.name}": ${result.jobIds.length} job(s) enfileirado(s) — acompanhe na tela Fila.`);
        refresh();
      } else {
        setError(result.reason);
      }
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h2>Agendamentos</h2>
          <p>Dispara fluxos ou pesquisas em horários fixos, sempre headless (RN-007, RF-057 a RF-063).</p>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {runMessage && (
        <div className="card" style={{ padding: '10px 14px', marginBottom: 16, fontSize: 13 }}>
          {runMessage}
        </div>
      )}

      <h3 className="section-title">Tarefa do Agendador do Windows</h3>
      <WindowsTaskCard />

      <h3 className="section-title" style={{ marginTop: 24 }}>
        Novo agendamento
      </h3>
      <NewScheduleCard flows={flows} profiles={profiles} onCreated={refresh} />

      <h3 className="section-title" style={{ marginTop: 24 }}>
        Agendamentos
      </h3>
      <SchedulesTable schedules={schedules} busyId={busyId} onToggle={toggle} onRemove={remove} onRun={run} />
    </div>
  );
}

function WindowsTaskCard() {
  const [status, setStatus] = useState<WindowsTaskStatusResult | null>(null);
  const [interval, setInterval_] = useState('5');
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    window.maestro.getTaskStatus().then(setStatus);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  function parsedInterval(): number | null {
    const n = Number(interval);
    return Number.isInteger(n) && n >= 1 ? n : null;
  }

  async function showPreview(): Promise<void> {
    const n = parsedInterval();
    if (!n) {
      setActionError('Intervalo precisa ser um número inteiro maior ou igual a 1.');
      return;
    }
    setActionError(null);
    setPreview(await window.maestro.previewInstallCommand(n));
  }

  async function install(): Promise<void> {
    const n = parsedInterval();
    if (!n) {
      setActionError('Intervalo precisa ser um número inteiro maior ou igual a 1.');
      return;
    }
    if (!window.confirm(`Isso registra "MaestroScheduleTick" no Agendador de Tarefas do Windows, checando a cada ${n} minuto(s). Continuar?`)) {
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      const result = await window.maestro.installTask(n);
      if (result.ok) refresh();
      else setActionError(result.reason);
    } finally {
      setBusy(false);
    }
  }

  async function uninstall(): Promise<void> {
    if (!window.confirm('Remover a tarefa do Agendador de Tarefas do Windows? Os agendamentos param de disparar sozinhos até reinstalar.')) {
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      const result = await window.maestro.uninstallTask();
      if (result.ok) refresh();
      else setActionError(result.reason);
    } finally {
      setBusy(false);
    }
  }

  const installed = status?.ok && status.installed;

  return (
    <div className="card" style={{ padding: 14, marginBottom: 4 }}>
      <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--text-muted)' }}>
        Uma única tarefa chama "maestro schedule tick" periodicamente — é o que faz os agendamentos abaixo dispararem sozinhos mesmo com a
        janela fechada. Só funciona no Windows real; não foi testado contra um Agendador de Tarefas de verdade neste ambiente de
        desenvolvimento.
      </p>

      <div style={{ marginBottom: 12 }}>
        {status === null ? (
          <span className="text-muted">Consultando…</span>
        ) : status.ok ? (
          <span className={`badge ${status.installed ? 'badge-done' : 'badge-cancelled'}`}>
            {status.installed ? 'tarefa registrada' : 'tarefa não registrada'}
          </span>
        ) : (
          <span className="text-muted">{status.reason}</span>
        )}
      </div>

      <div className="toolbar" style={{ marginBottom: preview ? 10 : 0 }}>
        <label style={{ fontSize: 13 }}>
          Checar a cada{' '}
          <input
            type="text"
            value={interval}
            onChange={(e) => {
              setInterval_(e.target.value);
              setPreview(null);
            }}
            style={{ width: 44, textAlign: 'center' }}
          />{' '}
          minuto(s)
        </label>
        <button className="btn" onClick={showPreview}>
          Ver comando
        </button>
        <button className="btn btn-primary" disabled={busy} onClick={install}>
          {installed ? 'Reinstalar' : 'Instalar tarefa'}
        </button>
        {installed && (
          <button className="btn btn-danger" disabled={busy} onClick={uninstall}>
            Remover tarefa
          </button>
        )}
        <button className="btn btn-ghost" onClick={refresh}>
          Verificar status
        </button>
      </div>

      {preview && (
        <div className="mono text-muted" style={{ marginBottom: actionError ? 10 : 0 }}>
          {preview}
        </div>
      )}
      {actionError && (
        <div className="error-banner" style={{ margin: 0 }}>
          {actionError}
        </div>
      )}
    </div>
  );
}

function NewScheduleCard({
  flows,
  profiles,
  onCreated,
}: {
  flows: FlowListItem[];
  profiles: ProfileView[];
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [cron, setCron] = useState('');
  const [kind, setKind] = useState<'flow' | 'search'>('flow');

  const [flowId, setFlowId] = useState('');
  const [profileId, setProfileId] = useState('');
  const [flowDetail, setFlowDetail] = useState<FlowDetailView | null>(null);
  const [vars, setVars] = useState<Record<string, string>>({});

  const [searchFile, setSearchFile] = useState<string | null>(null);
  const [themes, setThemes] = useState<SearchThemeView[]>([]);
  const [selectedThemes, setSelectedThemes] = useState<Set<string>>(new Set());
  const [pickError, setPickError] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!flowId && flows.length > 0) setFlowId(flows[0]!.id);
  }, [flows, flowId]);

  useEffect(() => {
    if (!profileId && profiles.length > 0) setProfileId(profiles[0]!.id);
  }, [profiles, profileId]);

  useEffect(() => {
    if (!flowId) {
      setFlowDetail(null);
      return;
    }
    window.maestro.getFlow(flowId).then((d) => {
      setFlowDetail(d);
      setVars(Object.fromEntries(d.variables.map((v) => [v.name, v.default])));
    });
  }, [flowId]);

  async function pickFile(): Promise<void> {
    setPickError(null);
    const result = await window.maestro.pickScheduleSearchFile();
    if (!result) return;
    if (result.ok) {
      setSearchFile(result.filePath);
      setThemes(result.themes);
      setSelectedThemes(new Set(result.themes.filter((t) => t.enabled).map((t) => t.id)));
    } else {
      setSearchFile(null);
      setThemes([]);
      setPickError(result.reason);
    }
  }

  function toggleTheme(id: string): void {
    setSelectedThemes((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function create(): Promise<void> {
    setFormError(null);
    let target: CreateScheduleInput['target'];
    if (kind === 'flow') {
      if (!flowId || !profileId) {
        setFormError('Selecione um fluxo e um perfil.');
        return;
      }
      target = { kind: 'flow', flowId, profileId, variables: vars };
    } else {
      if (!searchFile) {
        setFormError('Selecione um arquivo de pesquisas.');
        return;
      }
      // Tudo selecionado = sem filtro, para acompanhar o arquivo (temas novos
      // habilitados nele entram sozinhos nos próximos disparos) — igual ao
      // comportamento do `--themes` opcional da CLI.
      const allSelected = selectedThemes.size === themes.length;
      target = { kind: 'search', searchFile, themeIds: allSelected ? null : [...selectedThemes] };
    }

    setBusy(true);
    try {
      const result = await window.maestro.createSchedule({ name: name.trim(), cron: cron.trim(), target });
      if (result.ok) {
        setName('');
        setCron('');
        setSearchFile(null);
        setThemes([]);
        setSelectedThemes(new Set());
        onCreated();
      } else {
        setFormError(result.reason);
      }
    } finally {
      setBusy(false);
    }
  }

  const canSubmit = Boolean(name.trim() && cron.trim() && (kind === 'flow' ? flowId && profileId : searchFile) && !busy);

  return (
    <div className="card" style={{ padding: 14 }}>
      <div className="toolbar" style={{ marginBottom: 12 }}>
        <input type="text" placeholder="Nome do agendamento" value={name} onChange={(e) => setName(e.target.value)} style={{ width: 200 }} />
        <input
          type="text"
          placeholder="Cron (ex.: 30 9 * * *)"
          value={cron}
          onChange={(e) => setCron(e.target.value)}
          className="mono"
          style={{ width: 180 }}
        />
      </div>

      <div style={{ display: 'flex', gap: 16, marginBottom: 12, fontSize: 13 }}>
        <label>
          <input type="radio" checked={kind === 'flow'} onChange={() => setKind('flow')} /> Fluxo
        </label>
        <label>
          <input type="radio" checked={kind === 'search'} onChange={() => setKind('search')} /> Pesquisas
        </label>
      </div>

      {kind === 'flow' ? (
        <div style={{ marginBottom: 12 }}>
          {flows.length === 0 ? (
            <div className="text-muted" style={{ fontSize: 13 }}>
              Nenhum fluxo gravado ainda.
            </div>
          ) : (
            <div className="toolbar" style={{ marginBottom: flowDetail?.variables.length ? 10 : 0 }}>
              <select value={flowId} onChange={(e) => setFlowId(e.target.value)}>
                {flows.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
              <select value={profileId} onChange={(e) => setProfileId(e.target.value)}>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          {flowDetail && flowDetail.variables.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
              {flowDetail.variables.map((v) => (
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
          )}
        </div>
      ) : (
        <div style={{ marginBottom: 12 }}>
          <div className="toolbar" style={{ marginBottom: themes.length > 0 ? 10 : 0 }}>
            <button className="btn" onClick={pickFile}>
              {searchFile ? 'Trocar arquivo…' : 'Selecionar arquivo…'}
            </button>
            {searchFile && <span className="mono text-muted">{searchFile}</span>}
          </div>
          {pickError && (
            <div className="error-banner" style={{ marginBottom: 10 }}>
              {pickError}
            </div>
          )}
          {themes.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
              {themes.map((t) => (
                <label key={t.id} style={{ fontSize: 12.5 }}>
                  <input type="checkbox" disabled={!t.enabled} checked={selectedThemes.has(t.id)} onChange={() => toggleTheme(t.id)} /> {t.name}
                  {!t.enabled && <span className="text-muted"> (desativado)</span>}
                </label>
              ))}
            </div>
          )}
        </div>
      )}

      {formError && <div className="error-banner">{formError}</div>}

      <button className="btn btn-primary" disabled={!canSubmit} onClick={create}>
        {busy ? 'Criando…' : 'Criar agendamento'}
      </button>
    </div>
  );
}

function describeTarget(target: ScheduleTargetView): string {
  if (target.kind === 'flow') return `fluxo "${target.flowName}" · perfil ${target.profileName}`;
  return `pesquisas · ${target.themeIds ? `${target.themeIds.length} tema(s)` : 'todos os temas'}`;
}

function SchedulesTable({
  schedules,
  busyId,
  onToggle,
  onRemove,
  onRun,
}: {
  schedules: ScheduleView[] | null;
  busyId: string | null;
  onToggle: (s: ScheduleView) => void;
  onRemove: (s: ScheduleView) => void;
  onRun: (s: ScheduleView) => void;
}) {
  if (schedules === null) {
    return (
      <div className="card">
        <div className="empty-state">Carregando…</div>
      </div>
    );
  }

  if (schedules.length === 0) {
    return (
      <div className="card">
        <div className="empty-state">Nenhum agendamento cadastrado ainda.</div>
      </div>
    );
  }

  return (
    <div className="card">
      <table>
        <thead>
          <tr>
            <th>Nome</th>
            <th>Cron</th>
            <th>Alvo</th>
            <th>Status</th>
            <th>Próxima</th>
            <th>Última</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {schedules.map((s) => (
            <tr key={s.id}>
              <td>{s.name}</td>
              <td className="mono">{s.cron}</td>
              <td className="text-muted">{describeTarget(s.target)}</td>
              <td>
                <span className={`badge ${s.enabled ? 'badge-done' : 'badge-cancelled'}`}>{s.enabled ? 'ativo' : 'desativado'}</span>
              </td>
              <td className="mono">{formatTime(s.nextRunAt)}</td>
              <td>
                {s.lastRunAt ? (
                  <>
                    <span className="mono">{formatTime(s.lastRunAt)}</span> <StatusBadge status={s.lastStatus ?? ''} />
                  </>
                ) : (
                  <span className="text-muted">nunca rodou</span>
                )}
              </td>
              <td style={{ display: 'flex', gap: 6 }}>
                <button className="btn btn-ghost" disabled={busyId === s.id} onClick={() => onRun(s)}>
                  Rodar agora
                </button>
                <button className="btn btn-ghost" disabled={busyId === s.id} onClick={() => onToggle(s)}>
                  {s.enabled ? 'Desativar' : 'Ativar'}
                </button>
                <button className="btn btn-ghost-danger" disabled={busyId === s.id} onClick={() => onRemove(s)}>
                  Remover
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
