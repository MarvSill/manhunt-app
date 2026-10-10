import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import IssueList from '../components/IssueList';
import { useAuth } from '../lib/auth';
import {
  ROLE_LABELS,
  STATUS_LABELS,
  getGame,
  getRoster,
  removeParticipant,
  setReady,
  setRole,
  type Game,
  type Role,
  type RosterEntry,
} from '../lib/games';
import { db, errorText } from '../lib/supabase';
import { parseConfig } from '../shared/config';
import { formatMinutes } from '../shared/format';
import { getPreset } from '../shared/presets';
import { distributeRoles, lobbyIssues } from '../shared/roles';
import { validateConfig } from '../shared/validation';

const ASSIGNABLE: Role[] = ['offen', 'spieler', 'hunter', 'zentrale', 'gm', 'zuschauer'];
const WISHABLE: Role[] = ['spieler', 'hunter', 'zentrale', 'zuschauer'];

export default function GamePage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { session } = useAuth();
  const [game, setGame] = useState<Game | null>(null);
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [g, r] = await Promise.all([getGame(id), getRoster(id)]);
      setGame(g);
      setRoster(r);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoaded(true);
    }
  }, [id]);

  useEffect(() => {
    void load();
    if (!id) return;
    const channel = db()
      .channel(`lobby:${id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'participants', filter: `game_id=eq.${id}` }, () => void load())
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'games', filter: `id=eq.${id}` }, () => void load())
      .subscribe();
    return () => {
      void db().removeChannel(channel);
    };
  }, [id, load]);

  const config = useMemo(() => (game ? parseConfig(game.config_json) : null), [game]);
  const me = roster.find((r) => r.user_id === session?.user.id);
  const isHost = !!game && game.host_id === session?.user.id;
  const inLobby = !!game && ['entwurf', 'geplant', 'lobby'].includes(game.status);

  const checks = useMemo(() => {
    if (!config) return null;
    const players = roster.filter((r) => r.role === 'spieler');
    const hunters = roster.filter((r) => r.role === 'hunter' || r.role === 'zentrale');
    const hasMinors = [...players, ...hunters].some((r) => !r.is_adult);
    const validation = validateConfig(config, { players: players.length, hunters: hunters.length, hasMinors });
    const lobby = lobbyIssues(
      { players: players.length, hunters: hunters.length, unassigned: roster.filter((r) => r.role === 'offen').length },
      config.roles,
      roster.filter((r) => !r.ready).length,
    );
    const issues = [...lobby.map((i) => ({ ...i, paths: [] })), ...validation.issues];
    return { issues, canStart: !issues.some((i) => i.level === 'error'), players: players.length, hunters: hunters.length };
  }, [config, roster]);

  async function run(action: () => Promise<void>) {
    setError(null);
    try {
      await action();
      await load();
    } catch (err) {
      setError(errorText(err));
    }
  }

  function shuffleRoles() {
    if (!config) return;
    const candidates = roster.filter((r) => r.role !== 'gm' || r.user_id !== game?.host_id);
    const result = distributeRoles(candidates.map((r) => r.participant_id), config.roles);
    return run(async () => {
      for (const [pid, role] of Object.entries(result)) await setRole(pid, role);
    });
  }

  function applyWishes() {
    return run(async () => {
      for (const r of roster) if (r.wished_role && r.wished_role !== r.role) await setRole(r.participant_id, r.wished_role);
    });
  }

  async function share() {
    if (!game) return;
    const url = `${window.location.origin}/beitreten/${game.code}`;
    const text = `Spiel "${game.name}" beitreten: Code ${game.code}`;
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Hunt Mode', text, url });
        return;
      } catch {
        // abgebrochen: auf Kopieren ausweichen
      }
    }
    await navigator.clipboard.writeText(`${text}\n${url}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  if (!loaded) return <div className="app muted">Lade …</div>;
  if (!game || !config || !checks) {
    return (
      <div className="app">
        <div className="notice error">{error ?? 'Spiel nicht gefunden oder du bist nicht dabei.'}</div>
        <Link to="/">Zur Startseite</Link>
      </div>
    );
  }

  const preset = game.preset_id ? getPreset(game.preset_id) : undefined;

  return (
    <div className="app">
      <div className="topbar">
        <Link to="/" className="button ghost small">←</Link>
        <h1>{game.name}</h1>
        <span className="badge">{STATUS_LABELS[game.status] ?? game.status}</span>
      </div>

      {inLobby && (
        <div className="card stack">
          <div className="muted small" style={{ textAlign: 'center' }}>Beitritts-Code</div>
          <div className="code-big">{game.code}</div>
          <button onClick={share}>{copied ? 'Kopiert!' : 'Einladung teilen'}</button>
        </div>
      )}

      <div className="card small">
        <div>
          {preset?.name ?? 'Eigene Regeln'} · {formatMinutes(config.game.duration_minutes)} · {config.game.days} Spieltage
        </div>
        {game.start_at && (
          <div>Start: {new Date(game.start_at).toLocaleString('de-CH', { dateStyle: 'medium', timeStyle: 'short' })}</div>
        )}
        <div className="row" style={{ marginTop: 8 }}>
          <Link to={`/spiel/${game.id}/regeln`} className="button small">
            {isHost && inLobby ? 'Regeln bearbeiten' : 'Regeln ansehen'}
          </Link>
        </div>
      </div>

      <h2>
        Teilnehmende ({roster.length}) · {checks.players}/{config.roles.players_max} Spieler · {checks.hunters}/{config.roles.hunters_max} Hunter
      </h2>
      <div className="card">
        <ul className="list">
          {roster.map((r) => (
            <li key={r.participant_id}>
              <div className="avatar">{r.display_name.charAt(0).toUpperCase()}</div>
              <div className="spacer">
                <div>
                  {r.display_name} {r.user_id === game.host_id && <span className="badge">Host</span>}
                </div>
                <div className="muted small">
                  @{r.username}
                  {r.wished_role && ` · möchte ${ROLE_LABELS[r.wished_role]}`}
                  {r.ready ? ' · bereit' : ' · nicht bereit'}
                </div>
              </div>
              {isHost && inLobby ? (
                <div className="stack" style={{ gap: 4, width: 150 }}>
                  <select
                    value={r.role}
                    aria-label={`Rolle von ${r.display_name}`}
                    onChange={(e) => run(() => setRole(r.participant_id, e.target.value as Role))}
                  >
                    {ASSIGNABLE.map((role) => (
                      <option key={role} value={role}>
                        {ROLE_LABELS[role]}
                      </option>
                    ))}
                  </select>
                  {r.user_id !== game.host_id && (
                    <button className="small ghost" onClick={() => run(() => removeParticipant(r.participant_id))}>
                      Entfernen
                    </button>
                  )}
                </div>
              ) : (
                <span className={`badge${r.role === 'hunter' || r.role === 'zentrale' ? ' red' : r.role === 'spieler' ? ' green' : ''}`}>
                  {ROLE_LABELS[r.role]}
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>

      {error && <div className="notice error" style={{ marginBottom: 12 }}>{error}</div>}

      {inLobby && me && !isHost && (
        <div className="card stack">
          <label className="field">
            Wunschrolle
            <select
              value={me.wished_role ?? ''}
              onChange={(e) => run(() => setReady(game.id, me.ready, (e.target.value || null) as Role | null))}
            >
              <option value="">Egal</option>
              {WISHABLE.map((role) => (
                <option key={role} value={role}>
                  {ROLE_LABELS[role]}
                </option>
              ))}
            </select>
          </label>
          <label className="check">
            <input type="checkbox" checked={me.ready} onChange={(e) => run(() => setReady(game.id, e.target.checked, null))} />
            <span>Ich habe die Regeln gelesen und bin bereit.</span>
          </label>
          <button className="ghost" onClick={() => run(async () => { await removeParticipant(me.participant_id); navigate('/'); })}>
            Spiel verlassen
          </button>
        </div>
      )}

      {inLobby && isHost && (
        <>
          <div className="row" style={{ marginBottom: 12 }}>
            <button onClick={shuffleRoles}>Rollen zufällig verteilen</button>
            {roster.some((r) => r.wished_role) && <button onClick={applyWishes}>Wunschrollen übernehmen</button>}
          </div>
          <h2>Startprüfung</h2>
          <IssueList issues={checks.issues} />
          <button className="primary block" style={{ marginTop: 12 }} disabled title="Kommt mit Schritt 3">
            Spiel starten
          </button>
          <p className="muted small">
            {checks.canStart ? 'Alles bereit. ' : ''}Der Spielstart wird mit Schritt 3 (Spiel-Engine) freigeschaltet.
          </p>
        </>
      )}
    </div>
  );
}
