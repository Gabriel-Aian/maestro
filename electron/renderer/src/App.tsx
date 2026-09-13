import { useEffect, useState } from 'react';

type Status = Awaited<ReturnType<Window['maestro']['getStatus']>>;

/**
 * Prova de vida da Frente 1: nenhuma tela de verdade ainda, só confirma que o
 * renderer consegue chamar o processo principal, que por sua vez chama o
 * núcleo real (mesmas funções que `maestro doctor` na CLI).
 */
export function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    window.maestro
      .getStatus()
      .then((s) => {
        console.log('status recebido do núcleo:', JSON.stringify(s));
        setStatus(s);
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error('falha ao consultar o núcleo:', message);
        setError(message);
      });
  }, []);

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem', color: '#1a1a1a' }}>
      <h1>Maestro</h1>
      <p>Casca Electron — frente 1 (fundação).</p>
      {error && <p style={{ color: '#b00020' }}>Erro ao falar com o núcleo: {error}</p>}
      {!status && !error && <p>Consultando o núcleo…</p>}
      {status && (
        <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', columnGap: '1rem', rowGap: '0.4rem' }}>
          <dt>Node</dt>
          <dd>{status.node}</dd>
          <dt>Electron</dt>
          <dd>{status.electron}</dd>
          <dt>Plataforma</dt>
          <dd>{status.platform}</dd>
          <dt>Diretório de dados</dt>
          <dd>{status.dataDir}</dd>
          <dt>Navegadores detectados</dt>
          <dd>{status.browsersDetected.length > 0 ? status.browsersDetected.join(', ') : 'nenhum'}</dd>
          <dt>Perfis</dt>
          <dd>
            {status.profiles.total} ({status.profiles.authenticated} autenticados)
          </dd>
          <dt>Fluxos</dt>
          <dd>{status.flows}</dd>
          <dt>Agendamentos</dt>
          <dd>{status.schedules}</dd>
          <dt>Jobs pendentes</dt>
          <dd>{status.pendingJobs}</dd>
        </dl>
      )}
    </main>
  );
}
