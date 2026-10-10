import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import ConfigEditor from '../components/ConfigEditor';
import IssueList from '../components/IssueList';
import { createGame } from '../lib/games';
import { db, errorText } from '../lib/supabase';
import { gameConfigSchema, type GameConfig } from '../shared/config';
import { PRESETS, configFromPreset } from '../shared/presets';
import { validateConfig } from '../shared/validation';
import { formatMinutes } from '../shared/format';

function presetConfig(id: string): GameConfig {
  const c = configFromPreset(id);
  c.game.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || c.game.timezone;
  return c;
}

export default function NewGamePage() {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [presetId, setPresetId] = useState('stadtabend_3h');
  const [baseline, setBaseline] = useState(() => presetConfig('stadtabend_3h'));
  const [config, setConfig] = useState(baseline);
  const [startAt, setStartAt] = useState('');
  const [showRules, setShowRules] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [groups, setGroups] = useState<{ id: string; name: string }[]>([]);
  const [groupId, setGroupId] = useState('');

  useEffect(() => {
    void db().from('groups').select('id,name').then(({ data }) => setGroups((data ?? []) as { id: string; name: string }[]));
  }, []);

  const result = useMemo(() => validateConfig(config), [config]);
  const problemPaths = useMemo(
    () => new Set(result.issues.filter((i) => i.level !== 'autofix').flatMap((i) => i.paths)),
    [result],
  );

  function pickPreset(id: string) {
    const c = presetConfig(id);
    setPresetId(id);
    setBaseline(c);
    setConfig(c);
  }

  function edit(next: GameConfig) {
    const parsed = gameConfigSchema.safeParse(next);
    if (parsed.success) {
      setConfig(parsed.data);
      setEditError(null);
    } else {
      setEditError('Ungültiger Wert: ' + parsed.error.issues.map((i) => i.path.join('.')).join(', '));
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const game = await createGame(
        name.trim(),
        presetId,
        result.config,
        startAt ? new Date(startAt).toISOString() : null,
      );
      if (groupId) {
        const { error: gErr } = await db().rpc('set_game_group', { p_game_id: game.id, p_group_id: groupId });
        if (gErr) throw gErr;
      }
      navigate(`/spiel/${game.id}`, { replace: true });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app">
      <div className="topbar">
        <Link to="/" className="button ghost small">←</Link>
        <h1>Spiel erstellen</h1>
      </div>
      <form className="stack" onSubmit={submit}>
        <label className="field">
          Name des Spiels
          <input required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} placeholder="z. B. Zürich Altstadt" />
        </label>
        <label className="field">
          Geplanter Start (optional)
          <input type="datetime-local" value={startAt} onChange={(e) => setStartAt(e.target.value)} />
        </label>

        {groups.length > 0 && (
          <label className="field">
            Gruppe (optional)
            <select value={groupId} onChange={(e) => setGroupId(e.target.value)}>
              <option value="">Keine</option>
              {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </label>
        )}

        <h2>Voreinstellung</h2>
        <div className="stack">
          {PRESETS.map((p) => (
            <button
              type="button"
              key={p.id}
              className={`card preset${p.id === presetId ? ' selected' : ''}`}
              onClick={() => pickPreset(p.id)}
              aria-pressed={p.id === presetId}
            >
              <div className="row">
                <strong className="spacer">{p.name}</strong>
                <span className="badge">
                  {p.suggested.players} Spieler / {p.suggested.hunters} Hunter
                </span>
              </div>
              <div className="muted small">{p.description}</div>
            </button>
          ))}
        </div>

        <div className="card small">
          <div>Dauer: {formatMinutes(config.game.duration_minutes)} ({config.game.days} Spieltage à {formatMinutes(config.game.day_length_minutes)})</div>
          <div>Vorsprung: {formatMinutes(config.start.head_start_minutes)} · Ping alle {formatMinutes(config.ping.interval_minutes)}</div>
          <div>
            Speedhunts: {config.speedhunt.enabled ? `${config.speedhunt.quota_per_day.join('/')} am Tag 1, danach ${config.speedhunt.quota_default}, je ${config.speedhunt.queries} Abfragen` : 'aus'}
          </div>
        </div>

        <IssueList issues={result.issues} />

        <button type="button" onClick={() => setShowRules((s) => !s)}>
          {showRules ? 'Regeln ausblenden' : 'Alle Regeln anpassen'}
        </button>
        {showRules && (
          <>
            {editError && <div className="notice error">{editError}</div>}
            <ConfigEditor config={config} baseline={baseline} problemPaths={problemPaths} onChange={edit} />
          </>
        )}

        {error && <div className="notice error">{error}</div>}
        <button className="primary block" disabled={busy || !name.trim()}>
          Spiel erstellen
        </button>
        {!result.canStart && (
          <p className="muted small">Du kannst das Spiel trotz Fehlern anlegen; starten lässt es sich erst, wenn sie behoben sind.</p>
        )}
      </form>
    </div>
  );
}
