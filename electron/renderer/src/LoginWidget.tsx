import { useEffect, useState } from 'react';

function readHashParams(): URLSearchParams {
  const hash = window.location.hash; // "#/login-widget?profileId=x&name=y"
  const queryStart = hash.indexOf('?');
  return new URLSearchParams(queryStart >= 0 ? hash.slice(queryStart + 1) : '');
}

/**
 * Janela flutuante, discreta e semi-transparente que substitui o "pressione
 * Enter no terminal" da CLI (`profile login`). O navegador foi aberto sem
 * automação (RNF-006) — este processo não tem CDP nem qualquer visibilidade
 * sobre ele, então só um clique explícito confirma o login; o botão fica
 * desabilitado enquanto a janela do navegador ainda estiver aberta.
 */
export function LoginWidget() {
  const params = readHashParams();
  const profileId = params.get('profileId') ?? '';
  const profileName = params.get('name') ?? '';

  const [locked, setLocked] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    const check = () => {
      window.maestro.checkLogin(profileId).then((r) => {
        if (alive) setLocked(r.locked);
      });
    };
    check();
    const timer = setInterval(check, 1200);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [profileId]);

  async function complete(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const result = await window.maestro.completeLogin(profileId);
      if (result.ok) {
        window.close();
      } else {
        setLocked(true);
        setError(result.reason);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="widget-card">
      <div className="widget-drag" />
      <div className="widget-body">
        <div className="widget-title">Login — {profileName}</div>
        <div className="widget-status">{locked ? 'Aguardando você concluir no navegador…' : 'Pronto para confirmar.'}</div>
        {error && <div className="widget-error">{error}</div>}
        <div className="widget-actions">
          <button className="widget-btn widget-btn-ghost" onClick={() => window.close()}>
            Cancelar
          </button>
          <button className="widget-btn widget-btn-primary" disabled={locked || busy} onClick={complete}>
            {busy ? 'Confirmando…' : 'Concluí o login'}
          </button>
        </div>
      </div>
    </div>
  );
}
