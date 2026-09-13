import { useEffect, useState } from 'react';
import { QueueScreen } from './screens/QueueScreen.js';
import { HistoryScreen } from './screens/HistoryScreen.js';

type Screen = 'queue' | 'history';

const NAV: Array<{ id: Screen; label: string }> = [
  { id: 'queue', label: 'Fila' },
  { id: 'history', label: 'Histórico' },
];

export function App() {
  const [screen, setScreen] = useState<Screen>('queue');
  const [dataDir, setDataDir] = useState<string | null>(null);

  useEffect(() => {
    window.maestro.getStatus().then((s) => setDataDir(s.dataDir));
  }, []);

  return (
    <div className="app-shell">
      <nav className="sidebar">
        <h1>Maestro</h1>
        {NAV.map((item) => (
          <button
            key={item.id}
            className={`nav-item${screen === item.id ? ' active' : ''}`}
            onClick={() => setScreen(item.id)}
          >
            {item.label}
          </button>
        ))}
        <div className="sidebar-footer">{dataDir && <span title={dataDir}>Dados: …{dataDir.slice(-28)}</span>}</div>
      </nav>
      <main className="main">
        {screen === 'queue' && <QueueScreen />}
        {screen === 'history' && <HistoryScreen />}
      </main>
    </div>
  );
}
