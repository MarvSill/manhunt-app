import { useState } from 'react';
import { api, clock, countdown, ITEM_LABELS, PENALTY_LABELS, STATE_LABELS } from '../lib/engine';
import { Confirm, nameOf, Section, type PanelProps } from './common';
import HunterPanel from './HunterPanel';

const TEMPLATES = [
  { title: 'Fotobeweis', description: 'Macht ein Foto mit einem roten Gegenstand vor einem Wahrzeichen.', proof_type: 'foto' },
  { title: 'Ort erreichen', description: 'Erreicht den markierten Ort.', proof_type: 'geofence' },
  { title: 'Code finden', description: 'Am Ort ist ein Code versteckt. Findet und gebt ihn ein.', proof_type: 'code' },
];

export default function GmPanel(props: PanelProps & { pickZone: () => void; pickChallenge: (cb: (lat: number, lng: number) => void) => void }) {
  const { s, now, act, pickZone, pickChallenge } = props;
  const g = s.game;
  const cfg = g.config;
  const [contact, setContact] = useState<Record<string, string>>({});
  const [ch, setCh] = useState({ title: TEMPLATES[1].title, description: TEMPLATES[1].description, proof_type: 'geofence', starts_in_minutes: 30, duration_minutes: 30, reward_type: 'bonus_fake_ping', secret_code: '', lat: null as number | null, lng: null as number | null, radius_m: 50 });
  const [grant, setGrant] = useState({ participant: '', type: 'catch_free', minutes: 60 });
  const live = ['vorsprung', 'laeuft', 'finale'].includes(g.status);
  const openV = s.violations.filter((v) => v.status === 'offen');
  const pendingC = s.catches.filter((c) => ['wartet_auf_bestaetigung', 'wartet_auf_beweis'].includes(c.status) || (c.status === 'wartet_auf_bestaetigung' && !c.expires_at));
  const approvals = s.speedhunts.filter((x) => x.status === 'wartet_auf_freigabe');
  const review = s.challenges.flatMap((c) => c.entries.filter((e) => e.result === 'eingereicht').map((e) => ({ c, e })));
  const people = s.participants.filter((p) => p.role !== 'gm');

  return (
    <div className="stack">
      {s.emergencies.map((e) => (
        <div key={e.id} className="notice error stack">
          <strong>NOTFALL: {nameOf(s, e.participant_id)} seit {clock(e.at)}</strong>
          {e.lat != null && <span className="small">Standort: {e.lat.toFixed(5)}, {e.lng?.toFixed(5)} (auf der Karte)</span>}
          {contact[e.participant_id] && <span>Notfallkontakt: {contact[e.participant_id]}</span>}
          <div className="row">
            <button className="small" onClick={() => act(async () => {
              const c = await api.emergencyContact(g.id, e.participant_id);
              setContact({ ...contact, [e.participant_id]: c ? `${c.name}, ${c.phone}` : 'keiner' });
            })}>Notfallkontakt zeigen</button>
            <button className="small primary" onClick={() => act(() => api.emergencyResolve(e.id), 'Notfall erledigt.')}>Erledigt</button>
          </div>
        </div>
      ))}

      <Section title="Spielsteuerung" badge={g.is_test ? <span className="badge">Probelauf</span> : undefined}>
        <div className="row">
          {g.paused ? (
            <button className="primary" onClick={() => act(() => api.resume(g.id), 'Weiter.')}>Fortsetzen</button>
          ) : (
            <button disabled={!live} onClick={() => act(() => api.pause(g.id, 'Pause durch Spielleitung'), 'Pausiert.')}>Pause</button>
          )}
          <button disabled={!live} onClick={pickZone}>Sperrzone setzen</button>
          <Confirm className="ghost" label="Spiel beenden" confirm="Spiel jetzt beenden?" onYes={() => act(() => api.endGame(g.id))} />
        </div>
        {g.is_test && live && (
          <div className="stack">
            <div className="muted small">Probelauf: Spielzeit vorspulen (Timer laufen sofort ab).</div>
            <div className="row">
              {[1, 5, 15, 60].map((m) => <button key={m} className="small" onClick={() => act(() => api.advance(g.id, m))}>+{m} min</button>)}
            </div>
          </div>
        )}
        <div className="small muted">
          Tag {g.current_day}/{cfg.game.days}{g.next_day_at && ` · nächster Tag ${clock(g.next_day_at)}`} · Ende {clock(g.ends_at)} ({countdown(g.ends_at, now)})
          {g.exit_reveal_at && !g.exit_revealed && ` · Exit-Bekanntgabe ${clock(g.exit_reveal_at)}`}
        </div>
      </Section>

      {approvals.map((x) => (
        <div key={x.id} className="notice stack">
          <strong>Speedhunt auf {nameOf(s, x.target_id)} freigeben?</strong>
          <div className="row">
            <button className="primary small" onClick={() => act(() => api.speedhuntApprove(x.id, true))}>Freigeben</button>
            <button className="small" onClick={() => act(() => api.speedhuntApprove(x.id, false))}>Ablehnen</button>
          </div>
        </div>
      ))}

      {pendingC.map((c) => (
        <div key={c.id} className="notice stack">
          <strong>Fang: {nameOf(s, c.hunter_id)} → {nameOf(s, c.runner_id)}</strong>
          <span className="small">{c.status === 'wartet_auf_beweis' ? 'Wartet auf Beweis' : 'Wartet auf Bestätigung'}{c.distance_m != null && ` · Abstand ${Math.round(c.distance_m)} m`}</span>
          <div className="row">
            <button className="primary small" onClick={() => act(() => api.catchDecide(c.id, true))}>Gültig</button>
            <button className="small" onClick={() => act(() => api.catchDecide(c.id, false))}>Ungültig</button>
          </div>
        </div>
      ))}

      {openV.length > 0 && (
        <Section title={`Verstösse (${openV.length})`}>
          {openV.map((v) => (
            <div key={v.id} className="stack sub">
              <div><strong>{nameOf(s, v.participant_id)}</strong>: {v.type.replace(/_/g, ' ')} · {clock(v.at)}</div>
              {v.explanation && <div className="small">Erklärung: „{v.explanation}"</div>}
              {v.auto_apply_at && <div className="muted small">Automatisch um {clock(v.auto_apply_at)}: {PENALTY_LABELS[v.proposed_penalty]}</div>}
              <div className="row">
                <select aria-label="Strafe" defaultValue={v.proposed_penalty} id={`pen-${v.id}`}>
                  {Object.entries(PENALTY_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
                <button className="small primary" onClick={() => act(() => api.decide(v.id, (document.getElementById(`pen-${v.id}`) as HTMLSelectElement).value))}>Verhängen</button>
                <button className="small" onClick={() => act(() => api.decide(v.id, null))}>Verwerfen</button>
              </div>
            </div>
          ))}
        </Section>
      )}

      {review.map(({ c, e }) => (
        <div key={e.id} className="notice stack">
          <strong>Challenge „{c.title}“: {nameOf(s, e.participant_id)}</strong>
          {e.proof_text && <span>{e.proof_text}</span>}
          {e.proof_path && <span className="small muted">Foto: {e.proof_path.split('/').pop()}</span>}
          <div className="row">
            <button className="small primary" onClick={() => act(() => api.challengeDecide(e.id, true))}>Geschafft</button>
            <button className="small" onClick={() => act(() => api.challengeDecide(e.id, false))}>Nicht geschafft</button>
          </div>
        </div>
      ))}

      <Section title="Teilnehmende">
        <ul className="list">
          {people.map((p) => (
            <li key={p.id}>
              <div className="spacer">
                <div>{p.name} <span className="muted small">{p.role}</span></div>
                <div className="muted small">
                  {STATE_LABELS[p.state] ?? p.state}
                  {p.battery != null && ` · ${p.battery} %`}
                  {p.last_seen_at && ` · zuletzt ${clock(p.last_seen_at)}`}
                  {p.budget != null && p.role === 'spieler' && ` · ${Number(p.budget).toFixed(2)} ${cfg.budget.currency}`}
                </div>
              </div>
              {p.role === 'spieler' && live && (
                <select aria-label={`Aktion für ${p.name}`} value="" onChange={(e) => {
                  const v = e.target.value;
                  if (v === 'ping') void act(() => api.gmPing(g.id, p.id), 'Sonder-Ping gesendet.');
                  else if (v === 'kontakt') void act(async () => {
                    const c = await api.emergencyContact(g.id, p.id);
                    setContact({ ...contact, [p.id]: c ? `${c.name}, ${c.phone}` : 'keiner' });
                  });
                  else if (v === 'exit') void act(() => api.confirmExit(g.id, p.id));
                  else if (v) void act(() => api.gmState(p.id, v));
                }}>
                  <option value="">Aktion …</option>
                  <option value="ping">Sonder-Ping</option>
                  <option value="kontakt">Notfallkontakt</option>
                  <option value="aktiv">Aktiv setzen</option>
                  <option value="gefangen">Als gefangen werten</option>
                  <option value="disqualifiziert">Disqualifizieren</option>
                  {g.exit_revealed && <option value="exit">Am Exit bestätigen</option>}
                </select>
              )}
            </li>
          ))}
        </ul>
        {Object.entries(contact).filter(([pid]) => !s.emergencies.some((e) => e.participant_id === pid)).map(([pid, c]) => (
          <div key={pid} className="small">Notfallkontakt {nameOf(s, pid)}: {c}</div>
        ))}
      </Section>

      {cfg.challenge.enabled && live && (
        <Section title="Challenge erstellen">
          <div className="chips">
            {TEMPLATES.map((t) => <button key={t.title} className="chip" onClick={() => setCh({ ...ch, title: t.title, description: t.description, proof_type: t.proof_type })}>{t.title}</button>)}
          </div>
          <input aria-label="Titel" value={ch.title} onChange={(e) => setCh({ ...ch, title: e.target.value })} />
          <textarea aria-label="Beschreibung" value={ch.description} onChange={(e) => setCh({ ...ch, description: e.target.value })} rows={2} />
          <div className="row">
            <label className="field" style={{ flex: 1 }}>Start in (min)<input type="number" min={0} value={ch.starts_in_minutes} onChange={(e) => setCh({ ...ch, starts_in_minutes: +e.target.value })} /></label>
            <label className="field" style={{ flex: 1 }}>Dauer (min)<input type="number" min={5} value={ch.duration_minutes} onChange={(e) => setCh({ ...ch, duration_minutes: +e.target.value })} /></label>
          </div>
          <div className="row">
            <select aria-label="Beweis" value={ch.proof_type} onChange={(e) => setCh({ ...ch, proof_type: e.target.value })}>
              <option value="geofence">Ort (GPS)</option><option value="code">Code</option><option value="foto">Foto</option><option value="spielleitung">Spielleitung</option>
            </select>
            <select aria-label="Belohnung" value={ch.reward_type} onChange={(e) => setCh({ ...ch, reward_type: e.target.value })}>
              <option value="bonus_fake_ping">Fake-Ping</option><option value="bonus_hotel">Hotel</option><option value="budget">Budget</option><option value="joker">Catch-Free</option>
            </select>
          </div>
          {ch.proof_type === 'code' && <input placeholder="Geheimer Code" value={ch.secret_code} onChange={(e) => setCh({ ...ch, secret_code: e.target.value })} />}
          <button className="small" onClick={() => pickChallenge((lat, lng) => setCh((c) => ({ ...c, lat, lng })))}>
            {ch.lat != null ? `Ort: ${ch.lat.toFixed(4)}, ${ch.lng?.toFixed(4)}` : 'Ort auf der Karte wählen'}
          </button>
          <button className="primary" disabled={ch.proof_type === 'geofence' && ch.lat == null}
            onClick={() => act(() => api.challengeCreate(g.id, ch), 'Challenge geplant.')}>Challenge planen</button>
          {s.challenges.filter((c) => c.status !== 'beendet' && c.status !== 'abgesagt').map((c) => (
            <div key={c.id} className="row small">
              <span className="spacer">{c.title} · {clock(c.starts_at)} · {c.status}{c.secret_code && ` · Code ${c.secret_code}`}</span>
              <button className="small ghost" onClick={() => act(() => api.challengeCancel(c.id))}>Absagen</button>
            </div>
          ))}
        </Section>
      )}

      {live && (
        <Section title="Joker oder Bonus vergeben">
          <div className="row">
            <select aria-label="Spieler" value={grant.participant} onChange={(e) => setGrant({ ...grant, participant: e.target.value })} style={{ flex: 1 }}>
              <option value="">Spieler …</option>
              {s.participants.filter((p) => p.role === 'spieler').map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <select aria-label="Art" value={grant.type} onChange={(e) => setGrant({ ...grant, type: e.target.value })}>
              {['regeneration', 'catch_free', 'hunter_erfragen', 'fake_ping', 'hotel'].map((t) => <option key={t} value={t}>{ITEM_LABELS[t]}</option>)}
            </select>
          </div>
          <button className="small" disabled={!grant.participant} onClick={() => act(() => api.grantItem(g.id, grant.participant,
            ['fake_ping', 'hotel'].includes(grant.type) ? 'bonus' : 'joker', grant.type, ['regeneration', 'catch_free'].includes(grant.type) ? grant.minutes : null), 'Vergeben.')}>Vergeben</button>
        </Section>
      )}

      <details className="card">
        <summary>Taskforce-Werkzeuge (Speedhunt, Fang)</summary>
        <div style={{ marginTop: 12 }}><HunterPanel {...props} /></div>
      </details>
    </div>
  );
}
