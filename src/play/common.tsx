import { useState } from 'react';
import type { GameState, Participant } from '../lib/engine';

export interface PanelProps {
  s: GameState;
  now: number;
  act: (fn: () => Promise<unknown>, okText?: string) => Promise<boolean>;
  pos: { lat: number; lng: number } | null;
}

export function byId(s: GameState) {
  const m = new Map<string, Participant>();
  for (const p of s.participants) m.set(p.id, p);
  return m;
}

export function nameOf(s: GameState, id: string | null | undefined) {
  if (!id) return 'Unbekannt';
  return s.participants.find((p) => p.id === id)?.name ?? 'Unbekannt';
}

export const PLAYER_COLORS = ['#3fb950', '#58a6ff', '#d29922', '#a371f7', '#db6d28', '#f778ba', '#56d4dd', '#e3b341', '#7ee787', '#79c0ff'];

export function colorFor(s: GameState, id: string) {
  const p = s.participants.find((x) => x.id === id);
  if (p?.color) return p.color;
  if (p && (p.role === 'hunter' || p.role === 'zentrale')) return '#f85149';
  const players = s.participants.filter((x) => x.role === 'spieler' || x.state === 'gefangen');
  const i = Math.max(0, players.findIndex((x) => x.id === id));
  return PLAYER_COLORS[i % PLAYER_COLORS.length];
}

export function Confirm({ label, confirm, onYes, className, disabled }: { label: string; confirm: string; onYes: () => void; className?: string; disabled?: boolean }) {
  const [ask, setAsk] = useState(false);
  if (!ask) return <button className={className} disabled={disabled} onClick={() => setAsk(true)}>{label}</button>;
  return (
    <div className="row">
      <span className="small">{confirm}</span>
      <button className="primary small" onClick={() => { setAsk(false); onYes(); }}>Ja</button>
      <button className="small ghost" onClick={() => setAsk(false)}>Nein</button>
    </div>
  );
}

export function Section({ title, children, badge }: { title: string; children: React.ReactNode; badge?: React.ReactNode }) {
  return (
    <div className="card stack">
      <div className="row"><h2 style={{ margin: 0 }} className="spacer">{title}</h2>{badge}</div>
      {children}
    </div>
  );
}
