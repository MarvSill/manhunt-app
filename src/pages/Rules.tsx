import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import ConfigEditor from '../components/ConfigEditor';
import ExtraRules from '../components/ExtraRules';
import IssueList from '../components/IssueList';
import { useAuth } from '../lib/auth';
import { diffConfig, getGame, updateConfig, type Game } from '../lib/games';
import { errorText } from '../lib/supabase';
import { gameConfigSchema, parseConfig, type GameConfig } from '../shared/config';
import { configFromPreset, getPreset } from '../shared/presets';
import { validateConfig } from '../shared/validation';

export default function RulesPage() {
  const { id } = useParams<{ id: string }>();
  const { session } = useAuth();
  const [game, setGame] = useState<Game | null>(null);
  const [saved, setSaved] = useState<GameConfig | null>(null);
  const [config, setConfig] = useState<GameConfig | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!id) return;
    getGame(id).then(
      (g) => {
        setGame(g);
        if (g) {
          const c = parseConfig(g.config_json);
          setSaved(c);
          setConfig(c);
        }
      },
      (e) => setMsg({ kind: 'error', text: errorText(e) }),
    );
  }, [id]);

  const baseline = useMemo(() => {
    if (!game?.preset_id || !getPreset(game.preset_id) || !config) return undefined;
    const b = configFromPreset(game.preset_id);
    b.game.timezone = config.game.timezone;
    return b;
  }, [game?.preset_id, config?.game.timezone]);

  const result = useMemo(() => (config ? validateConfig(config) : null), [config]);
  const problemPaths = useMemo(
    () => new Set(result?.issues.filter((i) => i.level !== 'autofix').flatMap((i) => i.paths) ?? []),
    [result],
  );

  if (!game || !config || !saved || !result) {
    return <div className="app">{msg ? <div className="notice error">{msg.text}</div> : <span className="muted">Lade …</span>}</div>;
  }

  const editable = game.host_id === session?.user.id && ['entwurf', 'geplant', 'lobby'].includes(game.status);
  const changes = diffConfig(saved, result.config);

  function edit(next: GameConfig) {
    const parsed = gameConfigSchema.safeParse(next);
    if (parsed.success) {
      setConfig(parsed.data);
      setMsg(null);
    } else {
      setMsg({ kind: 'error', text: 'Ungültiger Wert: ' + parsed.error.issues.map((i) => i.path.join('.')).join(', ') });
    }
  }

  async function save() {
    if (!game || !result) return;
    setBusy(true);
    try {
      await updateConfig(game.id, result.config, changes);
      setSaved(result.config);
      setConfig(result.config);
      setMsg({ kind: 'ok', text: `${changes.length} Änderung(en) gespeichert.` });
    } catch (err) {
      setMsg({ kind: 'error', text: errorText(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app">
      <div className="topbar">
        <Link to={`/spiel/${game.id}`} className="button ghost small">←</Link>
        <h1>Regeln</h1>
      </div>
      {!editable && <div className="notice info" style={{ marginBottom: 12 }}>Nur der Host kann die Regeln vor dem Start ändern.</div>}
      <IssueList issues={result.issues} />
      <div style={{ height: 12 }} />
      <ExtraRules rules={config.extras.rules} readOnly={!editable}
        onChange={(rules) => edit({ ...config, extras: { ...config.extras, rules } })} />
      <div style={{ height: 12 }} />
      <ConfigEditor config={config} baseline={baseline} readOnly={!editable} problemPaths={problemPaths} onChange={edit} />
      {msg && <div className={`notice ${msg.kind}`} style={{ margin: '12px 0' }}>{msg.text}</div>}
      {editable && (
        <button className="primary block" disabled={busy || changes.length === 0} onClick={save}>
          {changes.length === 0 ? 'Keine Änderungen' : `${changes.length} Änderung(en) speichern`}
        </button>
      )}
    </div>
  );
}
