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

type CronMode = 'simple' | 'advanced';
type Periodicity = 'daily' | 'weekly' | 'everyMinutes' | 'everyHours';

const WEEKDAY_LABELS: { value: number; label: string }[] = [
  { value: 0, label: 'dom' },
  { value: 1, label: 'seg' },
  { value: 2, label: 'ter' },
  { value: 3, label: 'qua' },
  { value: 4, label: 'qui' },
  { value: 5, label: 'sex' },
  { value: 6, label: 'sáb' },
];

/**
 * Traduz a escolha do "modo simples" (periodicidade + horário) para a
 * expressão cron que o núcleo já entende — o núcleo continua falando só cron
 * (RF-057 a RF-063), essa tradução é só uma conveniência da GUI. `null`
 * significa "ainda não dá pra montar um cron válido com o que foi
 * preenchido" (ex.: nenhum dia da semana marcado, ou N fora do intervalo).
 */
function buildSimpleCron(periodicity: Periodicity, time: string, weekdays: Set<number>, everyN: string): string | null {
  const [hh, mm] = time.split(':').map(Number);
  switch (periodicity) {
    case 'daily':
      return Number.isInteger(hh) && Number.isInteger(mm) ? `${mm} ${hh} * * *` : null;
    case 'weekly': {
      if (!Number.isInteger(hh) || !Number.isInteger(mm) || weekdays.size === 0) return null;
      const days = [...weekdays].sort((a, b) => a - b).join(',');
      return `${mm} ${hh} * * ${days}`;
    }
    case 'everyMinutes': {
      const n = Number(everyN);
      return Number.isInteger(n) && n >= 1 && n <= 59 ? `*/${n} * * * *` : null;
    }
    case 'everyHours': {
      const n = Number(everyN);
      return Number.isInteger(n) && n >= 1 && n <= 23 ? `0 */${n} * * *` : null;
    }
  }
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

  const [cronMode, setCronMode] = useState<CronMode>('simple');
  const [periodicity, setPeriodicity] = useState<Periodicity>('daily');
  const [time, setTime] = useState('09:00');
  const [weekdays, setWeekdays] = useState<Set<number>>(new Set([1, 2, 3, 4, 5]));
  const [everyN, setEveryN] = useState('30');

  const [flowId, setFlowId] = useState('');
  const [profileId, setProfileId] = useState('');
  const [flowDetail, setFlowDetail] = useState<FlowDetailView | null>(null);
  const [vars, setVars] = useState<Record<string, string>>({});

  const [searchFile, setSearchFile] = useState<string | null>(null);
  const [themes, setThemes] = useState<SearchThemeView[]>([]);
  const [selectedThemes, setSelectedThemes] = useState<Set<string>>(new Set());
  const [sampleSize, setSampleSize] = useState('');
  const [pickError, setPickError] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Mantém `cron` sincronizado com os controles do modo simples — o núcleo
  // só entende cron (RF-057 a RF-063), essa é a única ponte. No modo
  // avançado o usuário edita `cron` direto e este efeito não roda.
  useEffect(() => {
    if (cronMode !== 'simple') return;
    setCron(buildSimpleCron(periodicity, time, weekdays, everyN) ?? '');
  }, [cronMode, periodicity, time, weekdays, everyN]);

  function toggleWeekday(value: number): void {
    setWeekdays((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  }

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
    if (!name.trim()) {
      setFormError('Dê um nome ao agendamento.');
      return;
    }
    if (cronMode === 'simple' && periodicity === 'weekly' && weekdays.size === 0) {
      setFormError('Selecione ao menos um dia da semana.');
      return;
    }
    if (!cron.trim()) {
      setFormError(cronMode === 'simple' ? 'Horário inválido.' : 'Informe a expressão cron.');
      return;
    }
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
      const n = sampleSize.trim() ? Number(sampleSize) : null;
      target = {
        kind: 'search',
        searchFile,
        themeIds: allSelected ? null : [...selectedThemes],
        sampleSize: Number.isInteger(n) && n! > 0 ? n : null,
      };
    }

    setBusy(true);
    try {
      const result = await window.maestro.createSchedule({ name: name.trim(), cron: cron.trim(), target });
      if (result.ok) {
        setName('');
        // No modo simples `cron` é derivado de periodicidade/horário, que
        // persistem de propósito (mesma razão de flowId/profileId abaixo) —
        // zerar aqui só seria desfeito no próximo render pelo efeito de
        // sincronização. No modo avançado o texto é digitado à mão, então
        // limpa como antes.
        if (cronMode === 'advanced') setCron('');
        setSearchFile(null);
        setThemes([]);
        setSelectedThemes(new Set());
        setSampleSize('');
        onCreated();
      } else {
        setFormError(result.reason);
      }
    } finally {
      setBusy(false);
    }
  }

  // Só bloqueia por `busy` — validar campo por campo aqui (em vez de manter
  // os mesmos requisitos duplicados em `create()`) fazia o botão ficar cinza
  // sem nenhuma explicação sempre que name/cron voltavam a vazio após criar
  // um agendamento (ficam vazios de propósito; flowId/profileId/kind
  // persistem para facilitar criar o próximo agendamento parecido). Clicar
  // sempre é permitido; `create()` mostra a mensagem específica que falta.
  const canSubmit = !busy;

  return (
    <div className="card" style={{ padding: 14 }}>
      <div className="toolbar" style={{ marginBottom: 12 }}>
        <input type="text" placeholder="Nome do agendamento" value={name} onChange={(e) => setName(e.target.value)} style={{ width: 200 }} />
      </div>

      <div style={{ display: 'flex', gap: 16, marginBottom: 10, fontSize: 13 }}>
        <label>
          <input type="radio" checked={cronMode === 'simple'} onChange={() => setCronMode('simple')} /> Horário (simples)
        </label>
        <label>
          <input type="radio" checked={cronMode === 'advanced'} onChange={() => setCronMode('advanced')} /> Cron (avançado)
        </label>
      </div>

      {cronMode === 'simple' ? (
        <div style={{ marginBottom: 12 }}>
          <div className="toolbar" style={{ marginBottom: periodicity === 'weekly' ? 8 : 0 }}>
            <select value={periodicity} onChange={(e) => setPeriodicity(e.target.value as Periodicity)}>
              <option value="daily">Todos os dias</option>
              <option value="weekly">Dias específicos da semana</option>
              <option value="everyMinutes">A cada N minutos</option>
              <option value="everyHours">A cada N horas</option>
            </select>
            {(periodicity === 'daily' || periodicity === 'weekly') && (
              <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
            )}
            {(periodicity === 'everyMinutes' || periodicity === 'everyHours') && (
              <>
                <span className="text-muted" style={{ fontSize: 13 }}>
                  a cada
                </span>
                <input
                  type="text"
                  value={everyN}
                  onChange={(e) => setEveryN(e.target.value)}
                  style={{ width: 44, textAlign: 'center' }}
                />
                <span className="text-muted" style={{ fontSize: 13 }}>
                  {periodicity === 'everyMinutes' ? 'minuto(s)' : 'hora(s)'}
                </span>
              </>
            )}
          </div>
          {periodicity === 'weekly' && (
            <div style={{ display: 'flex', gap: 10, fontSize: 12.5, marginBottom: 8 }}>
              {WEEKDAY_LABELS.map((d) => (
                <label key={d.value}>
                  <input type="checkbox" checked={weekdays.has(d.value)} onChange={() => toggleWeekday(d.value)} /> {d.label}
                </label>
              ))}
            </div>
          )}
          <div className="mono text-muted" style={{ fontSize: 12 }}>
            cron equivalente: {cron || '—'}
          </div>
        </div>
      ) : (
        <div className="toolbar" style={{ marginBottom: 12 }}>
          <input
            type="text"
            placeholder="Cron (ex.: 30 9 * * *)"
            value={cron}
            onChange={(e) => setCron(e.target.value)}
            className="mono"
            style={{ width: 180 }}
          />
        </div>
      )}

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
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 10 }}>
              {themes.map((t) => (
                <label key={t.id} style={{ fontSize: 12.5 }}>
                  <input type="checkbox" disabled={!t.enabled} checked={selectedThemes.has(t.id)} onChange={() => toggleTheme(t.id)} /> {t.name}
                  {!t.enabled && <span className="text-muted"> (desativado)</span>}
                </label>
              ))}
            </div>
          )}
          {themes.length > 0 && (
            <label style={{ fontSize: 13 }}>
              Rodar apenas{' '}
              <input
                type="text"
                placeholder="todas"
                value={sampleSize}
                onChange={(e) => setSampleSize(e.target.value)}
                style={{ width: 50, textAlign: 'center' }}
              />{' '}
              pesquisa(s) sorteada(s) a cada disparo, sem repetir
            </label>
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
  const themesPart = target.themeIds ? `${target.themeIds.length} tema(s)` : 'todos os temas';
  const samplePart = target.sampleSize ? ` · ${target.sampleSize} sorteada(s)` : '';
  return `pesquisas · ${themesPart}${samplePart}`;
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
