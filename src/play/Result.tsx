import { useEffect, useMemo, useState } from 'react';
import MapView, { type Marker } from '../components/MapView';
import { api, clock, STATE_LABELS, type GameState, type MapFeature, type Replay } from '../lib/engine';
import { errorText } from '../lib/supabase';
import { colorFor, nameOf } from './common';

const REASONS: Record<string, string> = {
  zeit_abgelaufen: 'Die Zeit ist abgelaufen.', alle_gefangen: 'Alle Spieler wurden gefangen.', alle_im_ziel_oder_gefangen: 'Alle sind am Exit oder gefangen.',
  letzter_ueberlebender: 'Nur noch eine Person ist frei.', alle_ausgeschieden: 'Alle Spieler sind ausgeschieden.', abgebrochen: 'Die Spielleitung hat das Spiel beendet.',
};

export default function Result({ s, zones }: { s: GameState; zones: MapFeature[] }) {
  const r = s.game.result;
  const [replay, setReplay] = useState<Replay | null>(null);
  const [t, setT] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    api.replay(s.game.id).then((x) => {
      setReplay(x);
      setT(new Date(x.start ?? x.end).getTime() / 1000);
    }, (e) => setErr(errorText(e)));
  }, [s.game.id]);

  const start = replay?.start ? new Date(replay.start).getTime() / 1000 : 0;
  const end = replay ? new Date(replay.end).getTime() / 1000 : 0;

  useEffect(() => {
    if (!playing) return;
    const i = setInterval(() => setT((x) => {
      const n = x + Math.max(60, (end - start) / 120);
      if (n >= end) { setPlaying(false); return end; }
      return n;
    }), 100);
    return () => clearInterval(i);
  }, [playing, start, end]);

  const { markers, lines } = useMemo(() => {
    const markers: Marker[] = [];
    const lines: { id: string; points: [number, number][]; color: string }[] = [];
    if (!replay) return { markers, lines };
    for (const [pid, pts] of Object.entries(replay.tracks)) {
      const upto = pts.filter((p) => p[0] <= t);
      if (!upto.length) continue;
      const color = colorFor(s, pid);
      lines.push({ id: pid, color, points: upto.slice(-60).map((p) => [p[1], p[2]]) });
      const last = upto[upto.length - 1];
      const p = s.participants.find((x) => x.id === pid);
      markers.push({ id: pid, lat: last[1], lng: last[2], color, label: p?.name ?? '?', kind: p?.role === 'spieler' ? 'player' : 'hunter' });
    }
    for (const pg of replay.pings) {
      const at = new Date(pg.at).getTime() / 1000;
      if (at <= t && at > t - 3600) markers.push({ id: `p${pg.at}${pg.participant_id}`, lat: pg.lat, lng: pg.lng, color: pg.is_fake ? '#8b949e' : colorFor(s, pg.participant_id), label: `${nameOf(s, pg.participant_id)} · ${pg.source}${pg.is_fake ? ' (Fake)' : ''}`, kind: 'ping', opacity: 0.7 });
    }
    return { markers, lines };
  }, [replay, t, s]);

  const players = s.participants.filter((p) => p.role === 'spieler' || p.state === 'gefangen');
  const winners = new Set(r?.winners ?? []);

  return (
    <div className="stack">
      <div className="card stack" style={{ textAlign: 'center' }}>
        <div className="brand">Spielende</div>
        <h1 style={{ margin: 0 }}>{winners.size ? `Sieger: ${[...winners].map((w) => nameOf(s, w)).join(', ')}` : 'Die Taskforce gewinnt'}</h1>
        <div className="muted">{REASONS[r?.reason ?? ''] ?? ''}</div>
        {r && <div className="small">{r.hours} h · {r.catches} Fänge · {r.speedhunts} Speedhunts · {r.pings} Pings</div>}
        {s.game.config.win.prize && winners.size > 0 && <div className="badge green" style={{ alignSelf: 'center' }}>Preis: {s.game.config.win.prize}</div>}
      </div>
      <div className="card">
        <ul className="list">
          {players.map((p) => (
            <li key={p.id}>
              <span className="dot" style={{ background: colorFor(s, p.id) }} />
              <span className="spacer">{p.name}</span>
              <span className={`badge${winners.has(p.id) ? ' green' : ''}`}>{winners.has(p.id) ? 'Sieg' : STATE_LABELS[p.state] ?? p.state}</span>
              {r?.mode === 'punkte' && <span className="badge">{r.scores[p.id] ?? 0} P</span>}
            </li>
          ))}
          {s.participants.filter((p) => p.role === 'hunter' || p.role === 'zentrale').map((p) => (
            <li key={p.id}><span className="dot" style={{ background: '#f85149' }} /><span className="spacer">{p.name}</span><span className="badge red">Kopfgeld {p.bounty}</span></li>
          ))}
        </ul>
      </div>
      <h2>Wiederholung</h2>
      {err && <div className="notice error">{err}</div>}
      {replay && (
        <>
          <MapView zones={zones} markers={markers} lines={lines} fitKey="replay" height="50dvh" />
          <div className="row">
            <button className="small" onClick={() => { if (t >= end) setT(start); setPlaying(!playing); }}>{playing ? 'Pause' : 'Abspielen'}</button>
            <input type="range" min={start} max={end} value={t} onChange={(e) => setT(+e.target.value)} style={{ flex: 1 }} aria-label="Zeit" />
            <span className="small">{clock(new Date(t * 1000).toISOString(), s.game.timezone)}</span>
          </div>
          <details className="card">
            <summary>Ereignisse ({replay.events.length})</summary>
            <ul className="list small">
              {replay.events.map((e, i) => <li key={i}>{clock(e.at, s.game.timezone)} · {e.type.replace(/_/g, ' ')}</li>)}
            </ul>
          </details>
        </>
      )}
    </div>
  );
}
