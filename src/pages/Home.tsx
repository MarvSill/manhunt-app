import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { STATUS_LABELS, myGames, type Game } from '../lib/games';
import { errorText } from '../lib/supabase';

export default function HomePage() {
  const { profile } = useAuth();
  const [games, setGames] = useState<Game[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    myGames().then(setGames, (e) => setError(errorText(e)));
  }, []);

  return (
    <div className="app">
      <div className="topbar">
        <span className="brand">Hunt Mode</span>
        <span className="spacer" />
        <span className="muted small">Hallo {profile?.display_name}</span>
      </div>

      <div className="stack">
        <Link to="/neu" className="button primary block">
          Spiel erstellen
        </Link>
        <Link to="/neu/eigenes" className="button block">
          Eigenes Spiel (alles selbst einstellen)
        </Link>
        <Link to="/beitreten" className="button block">
          Spiel beitreten
        </Link>
      </div>

      <h2>Meine Spiele</h2>
      {error && <div className="notice error">{error}</div>}
      {games === null && !error && <p className="muted">Lade …</p>}
      {games?.length === 0 && <p className="muted">Noch keine Spiele. Erstelle eins oder tritt mit einem Code bei.</p>}
      {games && games.length > 0 && (
        <div className="card">
          <ul className="list">
            {games.map((g) => (
              <li key={g.id}>
                <Link to={`/spiel/${g.id}`} className="spacer" style={{ color: 'inherit', textDecoration: 'none' }}>
                  <div>{g.name}</div>
                  <div className="muted small">
                    Code {g.code}
                    {g.start_at && ` · Start ${new Date(g.start_at).toLocaleString('de-CH', { dateStyle: 'short', timeStyle: 'short' })}`}
                  </div>
                </Link>
                <span className="badge">{STATUS_LABELS[g.status] ?? g.status}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
