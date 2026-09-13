import { useCallback, useEffect, useState } from 'react';
import type { BrowserView, ProfileView } from '../../../shared/ipc.js';
import { StatusBadge } from '../components/StatusBadge.js';

const LOGIN_URL = 'https://www.google.com/';

function formatTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function ProfilesScreen() {
  const [browsers, setBrowsers] = useState<BrowserView[] | null>(null);
  const [profiles, setProfiles] = useState<ProfileView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    Promise.all([window.maestro.listBrowsers(), window.maestro.listProfiles()])
      .then(([b, p]) => {
        setBrowsers(b);
        setProfiles(p);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    refresh();
    return window.maestro.onProfilesEvent(() => refresh());
  }, [refresh]);

  return (
    <div>
      <div className="page-header">
        <div>
          <h2>Perfis e navegadores</h2>
          <p>Cada perfil é um diretório de sessão isolado (RF-004); autenticação é sempre manual, sem senha guardada (RNF-001).</p>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <h3 className="section-title">Navegadores</h3>
      <BrowsersCard browsers={browsers} onChanged={refresh} />

      <h3 className="section-title" style={{ marginTop: 24 }}>
        Perfis
      </h3>
      <ProfilesCard profiles={profiles} browsers={browsers ?? []} onChanged={refresh} />
    </div>
  );
}

function BrowsersCard({ browsers, onChanged }: { browsers: BrowserView[] | null; onChanged: () => void }) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);

  async function savePath(id: string): Promise<void> {
    setBusy(true);
    setRowError(null);
    try {
      const result = await window.maestro.addBrowserPath(id, path.trim());
      if (result.ok) {
        setEditingId(null);
        setPath('');
        onChanged();
      } else {
        setRowError(result.reason);
      }
    } finally {
      setBusy(false);
    }
  }

  if (!browsers) {
    return (
      <div className="card">
        <div className="empty-state">Carregando…</div>
      </div>
    );
  }

  return (
    <div className="card">
      <table>
        <thead>
          <tr>
            <th>Navegador</th>
            <th>Origem</th>
            <th>Caminho</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {browsers.map((b) => (
            <tr key={b.id}>
              <td>{b.name}</td>
              <td className="text-muted">{b.source === 'none' ? 'não encontrado' : b.source}</td>
              <td className="mono" title={b.executablePath ?? undefined}>
                {b.executablePath ? `…${b.executablePath.slice(-42)}` : '—'}
              </td>
              <td>
                {editingId === b.id ? (
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <input
                      type="text"
                      placeholder="Caminho do executável"
                      value={path}
                      onChange={(e) => setPath(e.target.value)}
                      style={{ width: 220 }}
                    />
                    <button className="btn btn-primary" disabled={busy || !path.trim()} onClick={() => savePath(b.id)}>
                      Salvar
                    </button>
                    <button
                      className="btn btn-ghost"
                      onClick={() => {
                        setEditingId(null);
                        setRowError(null);
                      }}
                    >
                      Cancelar
                    </button>
                  </div>
                ) : (
                  <button
                    className="btn btn-ghost"
                    onClick={() => {
                      setEditingId(b.id);
                      setPath('');
                    }}
                  >
                    {b.executablePath ? 'Trocar caminho' : 'Registrar caminho'}
                  </button>
                )}
                {editingId === b.id && rowError && <div className="error-banner" style={{ marginTop: 8 }}>{rowError}</div>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ProfilesCard({
  profiles,
  browsers,
  onChanged,
}: {
  profiles: ProfileView[] | null;
  browsers: BrowserView[];
  onChanged: () => void;
}) {
  const [name, setName] = useState('');
  const [browserId, setBrowserId] = useState(browsers[0]?.id ?? '');
  const [addError, setAddError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (!browserId && browsers.length > 0) setBrowserId(browsers[0]!.id);
  }, [browsers, browserId]);

  async function addProfile(): Promise<void> {
    if (!name.trim() || !browserId) return;
    setBusyId('__add__');
    setAddError(null);
    try {
      const result = await window.maestro.addProfile(name.trim(), browserId);
      if (result.ok) {
        setName('');
        onChanged();
      } else {
        setAddError(result.reason);
      }
    } finally {
      setBusyId(null);
    }
  }

  async function login(profileId: string): Promise<void> {
    setBusyId(profileId);
    try {
      const result = await window.maestro.startLogin(profileId, LOGIN_URL);
      if (!result.ok) setAddError(result.reason);
    } finally {
      setBusyId(null);
    }
  }

  async function remove(profile: ProfileView): Promise<void> {
    if (!window.confirm(`Remover o perfil "${profile.name}"? Os dados de sessão ficam no disco; a conta só some da lista.`)) return;
    setBusyId(profile.id);
    try {
      await window.maestro.removeProfile(profile.id);
      onChanged();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="card">
      <div className="toolbar" style={{ padding: '14px 14px 0' }}>
        <input type="text" placeholder="Nome do perfil" value={name} onChange={(e) => setName(e.target.value)} />
        <select value={browserId} onChange={(e) => setBrowserId(e.target.value)}>
          {browsers.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
        <button className="btn btn-primary" disabled={busyId === '__add__' || !name.trim()} onClick={addProfile}>
          Novo perfil
        </button>
      </div>
      {addError && (
        <div className="error-banner" style={{ margin: '10px 14px 0' }}>
          {addError}
        </div>
      )}

      {profiles === null ? (
        <div className="empty-state">Carregando…</div>
      ) : profiles.length === 0 ? (
        <div className="empty-state">Nenhum perfil cadastrado ainda.</div>
      ) : (
        <table style={{ marginTop: 14 }}>
          <thead>
            <tr>
              <th>Nome</th>
              <th>Navegador</th>
              <th>Status</th>
              <th>Último uso</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {profiles.map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td>{browsers.find((b) => b.id === p.browserId)?.name ?? p.browserId}</td>
                <td>
                  <StatusBadge status={p.status} />
                  {p.locked && (
                    <span className="badge" style={{ marginLeft: 6, background: '#ececea', color: '#48473f' }} title="Navegador aberto agora">
                      navegador aberto
                    </span>
                  )}
                </td>
                <td className="mono">{formatTime(p.lastUsedAt)}</td>
                <td style={{ display: 'flex', gap: 6 }}>
                  <button className="btn btn-ghost" disabled={p.locked || busyId === p.id} onClick={() => login(p.id)}>
                    Fazer login
                  </button>
                  <button className="btn btn-ghost-danger" disabled={busyId === p.id} onClick={() => remove(p)}>
                    Remover
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
