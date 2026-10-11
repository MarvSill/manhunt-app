import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import ConfigEditor from '../components/ConfigEditor';
import Guide, { type GuideStep } from '../components/Guide';
import ExtraRules from '../components/ExtraRules';
import IssueList from '../components/IssueList';
import QuickSettings from '../components/QuickSettings';
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

function guideSteps(custom: boolean): GuideStep[] {
  return [
    { title: 'Willkommen!', text: 'Ich zeige dir Schritt für Schritt, wie du ein Spiel erstellst. Du kannst den Helfer jederzeit schliessen und später über "❓ Helfer" wieder öffnen.' },
    { target: 'mode', title: 'Vorlage oder alles selbst', text: '"Vorlage" nimmt fertige Regeln (z. B. 3 Stunden in der Stadt). Mit "Alles selbst einstellen" wählst du Spieler, Hunter, Zeiten, Pings und Joker selbst.' },
    { target: 'name', title: 'Name', text: 'Gib dem Spiel einen Namen, z. B. den Ort. Den sehen alle, die mitspielen.' },
    { target: 'start', title: 'Startzeit', text: 'Freiwillig. Gestartet wird das Spiel später von dir in der Lobby, wenn alle bereit sind.' },
    ...(custom
      ? [
          { target: 'q-Spieler und Hunter', title: 'Spieler und Hunter', text: 'Wie viele Spieler sich verstecken und wie viele Hunter jagen. Die Spielleitung kann automatisch (App) oder ein Mensch sein.' },
          { target: 'q-Zeiten', title: 'Zeiten', text: 'Spieldauer, Vorsprung und jagdfreie Zeiten. Alles andere (Verkleinerung, Pings, Joker …) passt die App automatisch an die Spieldauer an.' },
          { target: 'q-Pings (Standort der Spieler)', title: 'Pings', text: 'Wie oft die Hunter sehen, wo die Spieler sind. Kürzer = schwerer für die Spieler.' },
          { target: 'q-Speedhunt (Live-Jagd)', title: 'Speedhunt', text: 'Kurze Live-Jagden auf einen Spieler. Mit wenigen Speedhunts pro Tag bleibt es spannend.' },
          { target: 'q-Joker für die Spieler', title: 'Joker', text: 'Wähle, welche Joker es gibt, wie viele pro Tag und ab wann sie verfügbar sind. Die Spieler setzen sie im Spiel unter "Aktionen" ein.' },
          { target: 'issues', title: 'Prüfung', text: 'Hier steht, was die App automatisch angepasst hat und ob noch etwas fehlt.' },
        ]
      : [
          { target: 'presets', title: 'Vorlage wählen', text: 'Tippe eine Vorlage an. Darunter siehst du die wichtigsten Zeiten. Mit dem ⓘ und "Alle Regeln anpassen" kannst du alles ändern.' },
          { target: 'issues', title: 'Prüfung', text: 'Hier steht, was die App automatisch angepasst hat und ob noch etwas fehlt.' },
        ]),
    { target: 'create', title: 'Spiel erstellen', text: 'Danach kommst du in die Lobby: dort zeichnest du die Karte (mit Assistent), schickst den Code an deine Freunde, verteilst die Rollen und startest.' },
  ];
}

export default function NewGamePage() {
  const navigate = useNavigate();
  const custom = useLocation().pathname.endsWith('/eigenes');
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
  const [guide, setGuide] = useState(false);

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
        custom ? 'eigenes' : presetId,
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
        <h1>{custom ? 'Eigenes Spiel' : 'Spiel erstellen'}</h1>
        <button type="button" className="small help-btn" onClick={() => setGuide(true)}>❓ Helfer</button>
      </div>
      {guide && <Guide steps={guideSteps(custom)} onClose={() => setGuide(false)} />}
      <div className="mode-switch" data-guide="mode" style={{ marginBottom: 12 }}>
        <Link to="/neu" replace className={`button${custom ? '' : ' primary'}`}>Vorlage</Link>
        <Link to="/neu/eigenes" replace className={`button${custom ? ' primary' : ''}`}>Alles selbst einstellen</Link>
      </div>
      <form className="stack" onSubmit={submit}>
        <label className="field" data-guide="name">
          Name des Spiels
          <input required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} placeholder="z. B. Zürich Altstadt" />
        </label>
        <label className="field" data-guide="start">
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

        {custom ? (
          <>
            <p className="muted small" style={{ margin: 0 }}>Startwerte von der Vorlage unten, alles lässt sich ändern.</p>
            <label className="field">
              Startwerte von
              <select value={presetId} onChange={(e) => pickPreset(e.target.value)}>
                {PRESETS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
            <QuickSettings config={result.config} onChange={edit} />
            <ExtraRules rules={config.extras.rules} onChange={(rules) => edit({ ...config, extras: { ...config.extras, rules } })} />
            <div data-guide="issues"><IssueList issues={result.issues} /></div>
            <details className="section">
              <summary>Alle weiteren Regeln ({'>'}150 Einstellungen)</summary>
              <div>
                {editError && <div className="notice error">{editError}</div>}
                <ConfigEditor config={result.config} baseline={baseline} problemPaths={problemPaths} onChange={edit} />
              </div>
            </details>
          </>
        ) : (
          <>
          <h2>Voreinstellung</h2>
          <div className="stack" data-guide="presets">
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
            <div>Dauer: {formatMinutes(result.config.game.duration_minutes)} ({result.config.game.days} Spieltage à {formatMinutes(result.config.game.day_length_minutes)})</div>
            <div>Vorsprung: {formatMinutes(result.config.start.head_start_minutes)} · Ping alle {formatMinutes(result.config.ping.interval_minutes)}</div>
            <div>
              Speedhunts: {result.config.speedhunt.enabled ? `${result.config.speedhunt.quota_per_day.join('/')} am Tag 1, danach ${result.config.speedhunt.quota_default}, je ${result.config.speedhunt.queries} Abfragen` : 'aus'}
            </div>
          </div>

          <div data-guide="issues"><IssueList issues={result.issues} /></div>

          <button type="button" data-guide="rules" onClick={() => setShowRules((s) => !s)}>
            {showRules ? 'Regeln ausblenden' : 'Alle Regeln anpassen'}
          </button>
          {showRules && (
            <>
              {editError && <div className="notice error">{editError}</div>}
              <ConfigEditor config={result.config} baseline={baseline} problemPaths={problemPaths} onChange={edit} />
            </>
          )}
          </>
        )}

        {error && <div className="notice error">{error}</div>}
        <button className="primary block" data-guide="create" disabled={busy || !name.trim()}>
          Spiel erstellen
        </button>
        {!result.canStart && (
          <p className="muted small">Du kannst das Spiel trotz Fehlern anlegen; starten lässt es sich erst, wenn sie behoben sind.</p>
        )}
      </form>
    </div>
  );
}
