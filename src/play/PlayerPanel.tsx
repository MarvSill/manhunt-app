import { useState } from 'react';
import { api, clock, countdown, ITEM_LABELS, PENALTY_LABELS, TRANSPORT_LABELS, uploadProof } from '../lib/engine';
import { formatMinutes } from '../shared/format';
import CatchCode from './CatchCode';
import { Confirm, nameOf, Section, type PanelProps } from './common';

const PROOF_LABELS: Record<string, string> = { geofence: 'am Ort sein', code: 'Code eingeben', foto: 'Foto', spielleitung: 'Spielleitung entscheidet' };
const REWARD_LABELS: Record<string, string> = { bonus_fake_ping: 'Fake-Ping', bonus_hotel: 'Hotel', budget: 'Budget', joker: 'Catch-Free-Joker' };

export default function PlayerPanel({ s, now, act, pickFake }: PanelProps & { pickFake: (itemId: string) => void }) {
  const cfg = s.game.config;
  const me = s.me;
  const g = s.game;
  const [showCode, setShowCode] = useState(false);
  const [mode, setMode] = useState(cfg.transport.allowed_modes.find((m) => m !== 'zu_fuss') ?? 'oev_bus');
  const [line, setLine] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [stops, setStops] = useState('');
  const [amount, setAmount] = useState('');
  const [cat, setCat] = useState('essen');
  const [note, setNote] = useState('');
  const [receipt, setReceipt] = useState<File | null>(null);
  const [explain, setExplain] = useState<Record<string, string>>({});
  const [codes, setCodes] = useState<Record<string, string>>({});
  const active = ['aktiv', 'ausserhalb'].includes(me.state);
  const running = ['laeuft', 'finale'].includes(g.status) && !g.paused;
  const pendingCatch = s.catches.find((c) => c.runner_id === me.id && c.status === 'wartet_auf_bestaetigung');
  const openViolations = s.violations.filter((v) => v.participant_id === me.id && v.status === 'offen');
  const challenges = s.challenges.filter((c) => ['angekuendigt', 'laeuft'].includes(c.status));
  const shOnMe = s.speedhunts.some((x) => x.status === 'laeuft' && x.target_id === me.id);
  const shRunning = s.speedhunts.filter((x) => x.status === 'laeuft');

  if (!active) {
    return (
      <Section title={me.state === 'im_ziel' ? 'Geschafft!' : me.state === 'notfall' ? 'Notfall gemeldet' : 'Du bist raus'}>
        <p className="muted">
          {me.state === 'gefangen' && 'Du wurdest gefangen. Du kannst weiter zuschauen.'}
          {me.state === 'im_ziel' && 'Du hast den Exitpoint erreicht. Warte auf das Spielende.'}
          {me.state === 'notfall' && 'Die Spielleitung ist informiert. Die Jagd auf dich ist ausgesetzt.'}
          {['disqualifiziert', 'aufgegeben', 'verloren'].includes(me.state) && 'Du nimmst nicht mehr am Spiel teil.'}
        </p>
      </Section>
    );
  }

  return (
    <div className="stack">
      {showCode && <CatchCode gameId={g.id} onClose={() => setShowCode(false)} />}

      {pendingCatch && (
        <div className="notice error stack">
          <strong>{nameOf(s, pendingCatch.hunter_id)} meldet, dass du gefangen wurdest.</strong>
          <span className="small">Antwort bis {clock(pendingCatch.expires_at)}. Ohne Antwort entscheidet der GPS-Abstand.</span>
          <div className="row">
            <button className="primary" onClick={() => act(() => api.catchRespond(pendingCatch.id, true))}>Ja, gefangen</button>
            <button onClick={() => act(() => api.catchRespond(pendingCatch.id, false))}>Nein, stimmt nicht</button>
          </div>
        </div>
      )}

      {me.hideout_prompt && (
        <div className="notice stack">
          <strong>Bist du verschanzt?</strong>
          <span className="small">Du bist schon länger am selben Ort. In Wohnungen, Häusern oder anderen nicht öffentlichen Orten zählt die Zeit (max. {formatMinutes(cfg.hideout.max_minutes)}).</span>
          <div className="row">
            <button className="primary" onClick={() => act(() => api.hideout(g.id, true))}>Ja, ich bin drinnen</button>
            <button onClick={() => act(() => api.hideout(g.id, false))}>Nein, draussen</button>
          </div>
        </div>
      )}

      {me.transport_prompt && !me.transit && (
        <div className="notice error"><strong>Fährst du gerade?</strong> Melde den Transport unten an, sonst gibt es eine Strafe.</div>
      )}

      {me.state === 'ausserhalb' && (
        <div className="notice error">
          <strong>Du bist ausserhalb des Spielfelds!</strong> Die Taskforce sieht dich live. Zeit draussen: {formatMinutes(Math.floor(me.out_accum_s / 60))} von {formatMinutes(cfg.out_of_bounds.max_minutes)}.
        </div>
      )}
      {me.in_restricted && <div className="notice error"><strong>Sperrzone!</strong> Sofort verlassen.</div>}

      {shRunning.length > 0 && (
        <div className="notice error pulse">
          <strong>SPEEDHUNT läuft{shOnMe ? ' auf DICH' : ''}!</strong>{' '}
          {shRunning.map((x) => `Abfrage ${x.queries_used}/${x.queries_total}`).join(' · ')}
        </div>
      )}

      <button className="primary block big" onClick={() => setShowCode(true)}>Fang-Code zeigen</button>

      <Section title="Status">
        <div className="grid2">
          <div><div className="muted small">Nächster Ping</div><div className="big-num">{me.next_ping_at ? countdown(me.next_ping_at, now) : '–'}</div></div>
          {cfg.budget.enabled && <div><div className="muted small">Budget</div><div className="big-num">{Number(me.budget).toFixed(2)} {cfg.budget.currency}</div></div>}
          {me.hideout && (
            <div><div className="muted small">Verschanzt {me.hideout.inside ? '(drinnen)' : '(draussen)'}</div>
              <div className="big-num">{formatMinutes(Math.floor((me.hideout.max_s - me.hideout.accum_s) / 60))} übrig</div></div>
          )}
          {me.live && <div><div className="muted small">Sichtbarkeit</div><div className="big-num red">LIVE</div></div>}
        </div>
        {me.effects.filter((e) => e.type !== 'fake_ping' && e.type !== 'hunter_snapshot').map((e) => (
          <div key={e.id} className="badge green">{ITEM_LABELS[e.type] ?? (e.type === 'leo' ? 'LEO-Schutz' : e.type)} bis {clock(e.ends_at)}</div>
        ))}
        {me.effects.filter((e) => e.type === 'fake_ping').map((e) => <div key={e.id} className="badge">Fake-Ping scharf</div>)}
        {cfg.hideout.enabled && cfg.hideout.detection !== 'automatisch' && !me.hideout?.inside && running && (
          <button className="small" onClick={() => act(() => api.hideout(g.id, true), 'Verschanzen gemeldet.')}>Ich bin verschanzt (Haus/Wohnung)</button>
        )}
        {me.hideout?.inside && <button className="small" onClick={() => act(() => api.hideout(g.id, false))}>Ich bin wieder draussen</button>}
      </Section>

      {(me.inventory.length > 0) && (
        <Section title="Joker und Boni">
          {me.inventory.map((i) => (
            <div key={i.id} className="row">
              <span className="spacer">{ITEM_LABELS[i.type] ?? i.type}{i.minutes ? ` (${formatMinutes(i.minutes)})` : ''} <span className="muted small">{i.kind === 'joker' ? 'Joker' : 'Bonus'}</span></span>
              {i.type === 'fake_ping' ? (
                <button className="small" disabled={!running} onClick={() => pickFake(i.id)}>Ort wählen</button>
              ) : i.type === 'wahl' ? (
                <select aria-label="Joker wählen" disabled={!running} defaultValue="" onChange={(e) => e.target.value && act(() => api.useItem(i.id, { type: e.target.value }), 'Joker aktiv.')}>
                  <option value="">Einsetzen …</option>
                  {cfg.joker.types.map((t) => <option key={t.type} value={t.type}>{ITEM_LABELS[t.type]}</option>)}
                </select>
              ) : (
                <Confirm className="small" disabled={!running} label="Einsetzen" confirm="Wirklich?" onYes={() => act(() => api.useItem(i.id), 'Eingesetzt.')} />
              )}
            </div>
          ))}
        </Section>
      )}

      {cfg.transport.allowed_modes.length > 1 && (
        <Section title="Transport" badge={me.transit ? <span className="badge red">unterwegs</span> : undefined}>
          {me.transit ? (
            <>
              <div>{TRANSPORT_LABELS[me.transit.mode]} {me.transit.line} seit {clock(me.transit.started_at)}. Die Taskforce sieht dich live.</div>
              {me.transit.mode === 'faehre' && (
                <input type="number" min={0} placeholder="Anzahl Stationen" value={stops} onChange={(e) => setStops(e.target.value)} />
              )}
              <button className="primary" onClick={() => act(() => api.transitOut(g.id, stops ? +stops : null), 'Ausgestiegen.')}>Ausgestiegen</button>
            </>
          ) : (
            <>
              <select aria-label="Verkehrsmittel" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
                {cfg.transport.allowed_modes.filter((m) => m !== 'zu_fuss').map((m) => <option key={m} value={m}>{TRANSPORT_LABELS[m]}</option>)}
              </select>
              <div className="row">
                <input placeholder="Linie" value={line} onChange={(e) => setLine(e.target.value)} style={{ flex: 1 }} />
                <input placeholder="Von" value={from} onChange={(e) => setFrom(e.target.value)} style={{ flex: 1 }} />
                <input placeholder="Nach" value={to} onChange={(e) => setTo(e.target.value)} style={{ flex: 1 }} />
              </div>
              <button onClick={() => act(() => api.transitIn(g.id, mode, line, from, to), 'Fahrt angemeldet.')}>Einsteigen (anmelden)</button>
              <div className="muted small">Live während der Fahrt{cfg.transport.live_after_base_minutes > 0 ? ` und ${cfg.transport.live_after_base_minutes} min danach` : ''}.</div>
            </>
          )}
        </Section>
      )}

      {cfg.budget.enabled && (
        <Section title="Kauf melden">
          <div className="row">
            <input type="number" min={0} step="0.05" placeholder={`Betrag (${cfg.budget.currency})`} value={amount} onChange={(e) => setAmount(e.target.value)} style={{ flex: 1 }} />
            <select aria-label="Kategorie" value={cat} onChange={(e) => setCat(e.target.value)}>
              <option value="essen">Essen</option><option value="transport">Transport</option><option value="unterkunft">Unterkunft</option>
              <option value="kleidung">Kleidung</option><option value="sonstiges">Sonstiges</option>
            </select>
          </div>
          <input placeholder="Notiz" value={note} onChange={(e) => setNote(e.target.value)} />
          <label className="small">Beleg-Foto{cfg.budget.receipt_photo_required ? ' (Pflicht)' : ''}: <input type="file" accept="image/*" capture="environment" onChange={(e) => setReceipt(e.target.files?.[0] ?? null)} /></label>
          <button disabled={!amount} onClick={async () => {
            const ok = await act(async () => {
              const path = receipt ? await uploadProof(g.id, receipt, receipt.name) : null;
              return api.purchase(g.id, +amount, cat, note, path);
            }, 'Kauf gemeldet. Die Taskforce bekommt deinen Standort.');
            if (ok) { setAmount(''); setNote(''); setReceipt(null); }
          }}>Kauf melden</button>
        </Section>
      )}

      {challenges.length > 0 && (
        <Section title="Challenges">
          {challenges.map((c) => {
            const mine = c.entries.find((e) => e.participant_id === me.id);
            return (
              <div key={c.id} className="stack sub">
                <strong>{c.title}</strong>
                <span className="small">{c.description}</span>
                <span className="muted small">{clock(c.starts_at)}–{clock(c.ends_at)} · Beweis: {PROOF_LABELS[c.proof_type] ?? c.proof_type} · Belohnung: {REWARD_LABELS[c.reward_type] ?? c.reward_type}</span>
                {mine?.result === 'erfolgreich' ? <span className="badge green">Geschafft</span> : mine?.result === 'eingereicht' ? <span className="badge">Eingereicht, wird geprüft</span> : (
                  <div className="row">
                    {!mine && <button className="small" onClick={() => act(() => api.challengeJoin(c.id), 'Angemeldet.')}>Teilnehmen</button>}
                    {c.status === 'laeuft' && c.proof_type === 'code' && (
                      <input placeholder="Code" value={codes[c.id] ?? ''} onChange={(e) => setCodes({ ...codes, [c.id]: e.target.value })} style={{ width: 120 }} />
                    )}
                    {c.status === 'laeuft' && c.proof_type === 'foto' && (
                      <label className="button small">Foto senden<input type="file" accept="image/*,video/*" capture="environment" hidden onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) void act(async () => api.challengeSubmit(c.id, null, await uploadProof(g.id, f, f.name)), 'Eingereicht.');
                      }} /></label>
                    )}
                    {c.status === 'laeuft' && c.proof_type !== 'foto' && (
                      <button className="small primary" onClick={() => act(() => api.challengeSubmit(c.id, codes[c.id] ?? null, null), 'Eingereicht.')}>
                        {c.proof_type === 'geofence' ? 'Ich bin da' : 'Abschliessen'}
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </Section>
      )}

      {openViolations.map((v) => (
        <Section key={v.id} title="Regelverstoss">
          <div>{v.type.replace(/_/g, ' ')} · Vorschlag: {PENALTY_LABELS[v.proposed_penalty] ?? v.proposed_penalty}</div>
          {v.auto_apply_at && <div className="muted small">Wird um {clock(v.auto_apply_at)} verhängt.</div>}
          {v.explanation ? <div className="muted small">Deine Erklärung: {v.explanation}</div> : (
            <div className="row">
              <input placeholder="Erklärung" value={explain[v.id] ?? ''} onChange={(e) => setExplain({ ...explain, [v.id]: e.target.value })} style={{ flex: 1 }} />
              <button className="small" onClick={() => act(() => api.explain(v.id, explain[v.id] ?? ''), 'Gesendet.')}>Senden</button>
            </div>
          )}
        </Section>
      ))}

      {g.exit_revealed && cfg.exit.confirm !== 'geofence' && (
        <button className="block" onClick={() => act(() => api.confirmExit(g.id), 'Am Exitpoint!')}>Ich bin am Exitpoint</button>
      )}

      <Confirm className="ghost block" label="Aufgeben" confirm="Wirklich aufgeben?" onYes={() => act(() => api.giveUp(g.id))} />
    </div>
  );
}
