import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import MapView, { type Marker } from '../components/MapView';
import { api, clock, countdown, SOURCE_LABELS, type MapFeature, type Notification } from '../lib/engine';
import { STATUS_LABELS } from '../lib/games';
import { errorText } from '../lib/supabase';
import { useTracker } from '../lib/tracker';
import { useGameState, useNow } from '../lib/useGame';
import Chat from './Chat';
import { colorFor, Confirm, nameOf } from './common';
import GmPanel from './GmPanel';
import HunterPanel from './HunterPanel';
import PlayerPanel from './PlayerPanel';
import Result from './Result';

type Tab = 'karte' | 'aktionen' | 'meldungen' | 'chat';
type Pick = { kind: 'fake'; itemId: string } | { kind: 'zone' } | { kind: 'challenge'; cb: (lat: number, lng: number) => void } | null;

function beep(critical: boolean) {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = critical ? 880 : 660;
    g.gain.value = 0.15;
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + (critical ? 0.6 : 0.2));
  } catch {
    // ohne Ton
  }
}

export default function PlayPage() {
  const { id } = useParams<{ id: string }>();
  const [toasts, setToasts] = useState<Notification[]>([]);
  const [tab, setTab] = useState<Tab>('karte');
  const [zones, setZones] = useState<MapFeature[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pick, setPick] = useState<Pick>(null);
  const [notifPerm, setNotifPerm] = useState(typeof Notification !== 'undefined' ? Notification.permission : 'denied');
  const mapVersion = useRef<number | null>(null);

  const onNew = useCallback((list: Notification[]) => {
    setToasts((t) => [...[...list].reverse(), ...t].slice(0, 2));
    const crit = list.some((n) => n.priority === 'kritisch');
    const high = list.some((n) => n.priority !== 'normal');
    if (high) {
      navigator.vibrate?.(crit ? [300, 100, 300, 100, 300] : [200]);
      beep(crit);
    }
    // Hintergrund: Systembenachrichtigung über den Service Worker (solange die App offen ist).
    if (document.visibilityState !== 'visible' && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      void navigator.serviceWorker?.getRegistration().then((reg) => {
        for (const n of list) {
          const opts = { body: n.body, tag: `hm-${n.id}`, icon: `${import.meta.env.BASE_URL}icon.svg`, requireInteraction: n.priority === 'kritisch' };
          if (reg) void reg.showNotification(n.title, opts);
          else new Notification(n.title, opts);
        }
      });
    }
    for (const n of list) setTimeout(() => setToasts((t) => t.filter((x) => x.id !== n.id)), n.priority === 'kritisch' ? 15000 : 7000);
  }, []);

  const { state: s, error, reload, offsetMs } = useGameState(id, onNew);
  const now = useNow(offsetMs);
  const role = s?.me.role;
  const tracking = !!s && role !== 'zuschauer' && !['beendet', 'archiviert'].includes(s.game.status)
    && !(role === 'spieler' && ['gefangen', 'disqualifiziert', 'aufgegeben', 'verloren'].includes(s.me.state) && !s.game.config.catch.track_after_catch);
  const [kick, setKick] = useState(0);
  const tracker = useTracker(id, tracking, kick);
  const pos = tracker.last ? { lat: tracker.last.lat, lng: tracker.last.lng } : null;

  // Karte neu laden, wenn sich Zonen ändern (Ankündigung, Exit, neue Sperrzone).
  useEffect(() => {
    if (!s || !id) return;
    if (mapVersion.current === s.game.map_version) return;
    mapVersion.current = s.game.map_version;
    void api.map(id).then(setZones, () => undefined);
  }, [s, id]);

  useEffect(() => {
    if (s?.me.location_requested) setKick((k) => k + 1);
  }, [s?.me.location_requested]);

  const act = useCallback(async (fn: () => Promise<unknown>, okText?: string) => {
    setMsg(null);
    try {
      await fn();
      if (okText) setMsg({ ok: true, text: okText });
      await reload();
      return true;
    } catch (err) {
      setMsg({ ok: false, text: errorText(err) });
      return false;
    }
  }, [reload]);

  const markers = useMemo<Marker[]>(() => {
    if (!s) return [];
    const list: Marker[] = [];
    const tf = role === 'hunter' || role === 'zentrale' || role === 'gm';
    const fade = s.game.config.ping.fade_after_minutes * 60000;
    for (const p of s.pings) {
      if (p.lat == null || p.lng == null) continue;
      if (role === 'spieler' && p.participant_id === s.me.id && p.source === 'proximity') continue;
      const age = now - new Date(p.at).getTime();
      const label = `${nameOf(s, p.participant_id)} · ${SOURCE_LABELS[p.source] ?? p.source}${p.n ? ` ${p.n}` : ''} · ${clock(p.at)}${p.stale_seconds ? ` (${Math.round(p.stale_seconds / 60)} min alt)` : ''}${p.is_fake ? ' · FAKE' : ''}`;
      list.push({ id: p.id, lat: p.lat, lng: p.lng, color: colorFor(s, p.participant_id), label, kind: 'ping', opacity: Math.max(0.3, 1 - age / Math.max(fade, 1)), accuracy: p.accuracy_m });
      if (p.truth && role === 'gm') list.push({ id: `${p.id}t`, lat: p.truth.lat, lng: p.truth.lng, color: '#8b949e', label: `Echt: ${nameOf(s, p.participant_id)}`, kind: 'fake' });
    }
    for (const x of s.positions) {
      const isMe = x.participant_id === s.me.id;
      const pp = s.participants.find((q) => q.id === x.participant_id);
      list.push({
        id: `pos${x.participant_id}`, lat: x.lat, lng: x.lng, accuracy: x.accuracy_m,
        color: isMe ? '#58a6ff' : colorFor(s, x.participant_id), kind: isMe ? 'me' : pp?.role === 'spieler' ? 'player' : 'hunter',
        label: `${isMe ? 'Du' : pp?.name ?? '?'}${x.live && !isMe ? ' (LIVE)' : ''} · ${clock(x.at)}`, pulse: x.live && tf && !isMe,
      });
    }
    // Eigene Live-Position (schneller als der Server-Stand)
    if (pos && !s.positions.some((x) => x.participant_id === s.me.id)) {
      list.push({ id: 'me', lat: pos.lat, lng: pos.lng, color: '#58a6ff', kind: 'me', label: 'Du', accuracy: tracker.last?.acc });
    }
    for (const e of s.me.effects) {
      if (e.type === 'hunter_snapshot') {
        for (const h of (e.payload.hunters as { name: string; lat: number; lng: number }[]) ?? []) {
          list.push({ id: `hs${h.name}`, lat: h.lat, lng: h.lng, color: '#f85149', kind: 'hunter', label: `Hunter ${h.name}` });
        }
      }
      if (e.type === 'hotel') list.push({ id: 'hotel', lat: e.payload.lat as number, lng: e.payload.lng as number, color: '#a371f7', kind: 'hotel', label: 'Hotel', accuracy: e.payload.radius_m as number });
      if (e.type === 'fake_ping') list.push({ id: 'fake', lat: e.payload.lat as number, lng: e.payload.lng as number, color: '#8b949e', kind: 'fake', label: 'Dein Fake-Ping' });
    }
    for (const n of s.notifications.slice(0, 10)) {
      if (n.kind === 'proximity_self' && n.payload.lat != null && now - new Date(n.at).getTime() < 15 * 60000) {
        list.push({ id: `px${n.id}`, lat: n.payload.lat as number, lng: n.payload.lng as number, color: '#d29922', kind: 'player', label: `${n.payload.name} (Teambildung)` });
      }
    }
    for (const c of s.challenges) {
      if (c.lat != null && c.lng != null && c.status !== 'beendet' && c.status !== 'abgesagt') {
        list.push({ id: `c${c.id}`, lat: c.lat, lng: c.lng, color: '#e3b341', kind: 'challenge', label: `Challenge: ${c.title}`, accuracy: c.radius_m });
      }
    }
    for (const e of s.emergencies) {
      if (e.lat != null && e.lng != null) list.push({ id: `e${e.id}`, lat: e.lat, lng: e.lng, color: '#ff0000', kind: 'emergency', label: `NOTFALL ${nameOf(s, e.participant_id)}`, pulse: true });
    }
    return list;
  }, [s, now, pos, role, tracker.last?.acc]);

  async function mapClick(lat: number, lng: number) {
    if (!pick || !id) return;
    const p = pick;
    setPick(null);
    setTab('aktionen');
    if (p.kind === 'fake') {
      await act(() => api.useItem(p.itemId, { lat, lng, applies: 'beide' }), 'Fake-Ping scharf: der nächste Ping zeigt diesen Ort.');
    } else if (p.kind === 'zone') {
      const r = 60;
      await act(() => api.gmZone(id, { type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] }, properties: { kind: 'sperrzone', name: 'Sperrzone', radius_m: r } }).then(() => undefined), 'Sperrzone gesetzt.');
    } else {
      p.cb(lat, lng);
    }
  }

  if (!s) {
    return (
      <div className="app">
        {error ? <div className="notice error">{error}</div> : <div className="muted">Lade Spiel …</div>}
        <Link to={`/spiel/${id}`}>Zurück</Link>
      </div>
    );
  }

  const g = s.game;
  const ended = ['beendet', 'archiviert'].includes(g.status);
  const players = s.participants.filter((p) => p.role === 'spieler');
  const headline = g.paused ? 'PAUSE' : g.status === 'vorsprung' ? `Jagd in ${countdown(g.hunt_start_at, now)}`
    : g.status === 'finale' ? `Exit bis ${clock(g.deadline_at, g.timezone)} · ${countdown(g.deadline_at, now)}`
    : ended ? 'Spiel beendet' : `Ende in ${countdown(g.ends_at, now)}`;

  return (
    <div className="app wide play">
      <div className="topbar">
        <Link to="/" className="button ghost small">←</Link>
        <div className="spacer">
          <div className="small muted">{g.name} · {STATUS_LABELS[g.status]}{g.is_test ? ' · Probelauf' : ''}{g.current_day > 0 && ` · Tag ${g.current_day}/${g.config.game.days}`}</div>
          <div className="headline">{headline}</div>
        </div>
        <span className={`badge ${role === 'spieler' ? 'green' : role === 'gm' ? '' : 'red'}`}>{role === 'spieler' ? 'Spieler' : role === 'gm' ? 'Spielleitung' : role === 'zuschauer' ? 'Zuschauer' : 'Taskforce'}</span>
      </div>

      <div className="toasts">
        {toasts.map((n) => (
          <div key={n.id} className={`toast ${n.priority}`} onClick={() => setToasts((t) => t.filter((x) => x.id !== n.id))}>
            <strong>{n.title}</strong>{n.body && <div className="small">{n.body}</div>}
          </div>
        ))}
      </div>

      {g.paused && <div className="notice error" style={{ marginBottom: 8 }}><strong>Spiel pausiert.</strong> {g.pause_reason}</div>}
      {g.quiet && <div className="notice" style={{ marginBottom: 8 }}>Jagdfreie Zeit: keine Pings, keine Speedhunts, keine Fänge.</div>}
      {tracking && tracker.status !== 'ok' && (
        <div className="notice error" style={{ marginBottom: 8 }}>
          {tracker.status === 'verweigert' ? 'Standort ist blockiert. Erlaube den Standort in den Browser-Einstellungen, sonst kannst du nicht mitspielen.'
            : tracker.status === 'warte' ? 'Warte auf GPS …' : `GPS-Problem: ${tracker.error ?? ''}`}
        </div>
      )}
      {tracker.queued > 3 && <div className="notice" style={{ marginBottom: 8 }}>Offline: {tracker.queued} Standorte warten auf Verbindung.</div>}
      {!ended && notifPerm === 'default' && typeof Notification !== 'undefined' && (
        <button className="small block" style={{ marginBottom: 8 }} onClick={() => void Notification.requestPermission().then(setNotifPerm)}>Benachrichtigungen erlauben</button>
      )}
      {msg && <div className={`notice ${msg.ok ? 'success' : 'error'}`} style={{ marginBottom: 8 }} onClick={() => setMsg(null)}>{msg.text}</div>}

      {ended ? <Result s={s} zones={zones} /> : (
        <>
          <div className="tabs">
            {(['karte', 'aktionen', 'meldungen', 'chat'] as Tab[]).map((t) => (
              <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
                {t === 'karte' ? 'Karte' : t === 'aktionen' ? 'Aktionen' : t === 'meldungen' ? 'Meldungen' : 'Chat'}
              </button>
            ))}
          </div>

          <div style={{ display: tab === 'karte' ? 'block' : 'none' }}>
            {pick && (
              <div className="notice" style={{ marginBottom: 8 }}>
                {pick.kind === 'fake' ? 'Tippe auf die Karte: dort erscheint dein nächster Ping.' : pick.kind === 'zone' ? 'Tippe auf die Karte: dort entsteht eine Sperrzone (60 m).' : 'Tippe auf den Ort der Challenge.'}
                {' '}<button className="small ghost" onClick={() => setPick(null)}>Abbrechen</button>
              </div>
            )}
            <MapView zones={zones} markers={markers} onClick={pick ? mapClick : undefined} fitKey={g.id} height="62dvh" showDay={g.current_day} />
            <div className="row small" style={{ marginTop: 8 }}>
              {role === 'spieler' && s.me.next_ping_at && <span className="badge">Nächster Ping {clock(s.me.next_ping_at)}</span>}
              {s.next_silent_ping_at && role !== 'spieler' && <span className="badge">Nächster Silent-Ping {clock(s.next_silent_ping_at)}</span>}
              <span className="badge">{s.free_players}/{players.length} Spieler frei</span>
              {s.speedhunts.some((x) => x.status === 'laeuft') && <span className="badge red pulse">Speedhunt</span>}
              {tracker.last && <span className="badge">GPS ±{tracker.last.acc} m</span>}
            </div>
          </div>

          <div style={{ display: tab === 'aktionen' ? 'block' : 'none' }}>
            {(g.config.extras?.rules?.length ?? 0) > 0 && (
              <details className="section">
                <summary>Zusatzregeln ({g.config.extras.rules.length})</summary>
                <div><ol className="extra-rules">{g.config.extras.rules.map((r, i) => <li key={i}>{r}</li>)}</ol></div>
              </details>
            )}
            {role === 'spieler' && <PlayerPanel s={s} now={now} act={act} pos={pos} pickFake={(itemId) => { setPick({ kind: 'fake', itemId }); setTab('karte'); }} />}
            {(role === 'hunter' || role === 'zentrale') && <HunterPanel s={s} now={now} act={act} pos={pos} />}
            {role === 'gm' && (
              <GmPanel s={s} now={now} act={act} pos={pos}
                pickZone={() => { setPick({ kind: 'zone' }); setTab('karte'); }}
                pickChallenge={(cb) => { setPick({ kind: 'challenge', cb }); setTab('karte'); }} />
            )}
            {role === 'zuschauer' && <div className="card muted">Du schaust zu. Positionen siehst du mit {g.config.spectator.delay_minutes} min Verzögerung.</div>}
          </div>

          <div style={{ display: tab === 'meldungen' ? 'block' : 'none' }}>
            <div className="card">
              <ul className="list">
                {s.notifications.map((n) => (
                  <li key={n.id} className={`note ${n.priority}`}>
                    <div className="spacer">
                      <div><strong>{n.title}</strong></div>
                      {n.body && <div className="small">{n.body}</div>}
                    </div>
                    <span className="muted small">{clock(n.at, g.timezone)}</span>
                  </li>
                ))}
                {s.notifications.length === 0 && <li className="muted">Noch keine Meldungen.</li>}
              </ul>
            </div>
          </div>

          {tab === 'chat' && <Chat s={s} />}

          {role !== 'zuschauer' && s.me.state !== 'notfall' && (
            <div style={{ marginTop: 16 }}>
              <Confirm className="danger block" label="NOTFALL" confirm="Notfall melden? Die Spielleitung wird alarmiert."
                onYes={() => act(() => api.emergency(g.id, pos?.lat, pos?.lng), 'Notfall gemeldet. Bei Gefahr: 112 anrufen.')} />
            </div>
          )}
          {s.me.state === 'notfall' && <a className="button danger block" href="tel:112" style={{ marginTop: 16 }}>112 anrufen</a>}
        </>
      )}
    </div>
  );
}
