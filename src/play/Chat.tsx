import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/engine';
import { db, errorText } from '../lib/supabase';
import type { GameState } from '../lib/engine';

interface Msg { id: number; channel: string; sender_id: string | null; sender_name: string | null; body: string; at: string }

export function channelsFor(s: GameState): { id: string; label: string; write: boolean }[] {
  const r = s.me.role;
  const cfg = s.game.config;
  const list: { id: string; label: string; write: boolean }[] = [{ id: 'ankuendigung', label: 'Ankündigungen', write: r === 'gm' || s.game.host }];
  if (r === 'hunter' || r === 'zentrale' || r === 'gm') list.push({ id: 'taskforce', label: 'Taskforce', write: true });
  if (r === 'spieler' && cfg.communication.player_to_player) list.push({ id: 'spieler', label: 'Spieler', write: true });
  if (r === 'gm') {
    for (const p of s.participants.filter((x) => x.role !== 'gm')) list.push({ id: `gm:${p.id}`, label: `An ${p.name}`, write: true });
  } else {
    list.push({ id: `gm:${s.me.id}`, label: 'Spielleitung', write: true });
  }
  return list;
}

// Chat über die Tabelle messages (RLS filtert die Kanäle), neue Nachrichten per Realtime.
export function MessageList({ filter, value, channel, onSend, height = '50dvh' }: {
  filter: { column: 'game_id' | 'group_id'; value: string };
  value?: string;
  channel: string | null;
  onSend: ((body: string) => Promise<unknown>) | null;
  height?: string;
}) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [me, setMe] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void db().auth.getUser().then(({ data }) => setMe(data.user?.id ?? null));
  }, []);

  useEffect(() => {
    let q = db().from('messages').select('id,channel,sender_id,sender_name,body,at').eq(filter.column, filter.value).order('id', { ascending: false }).limit(100);
    if (channel) q = q.eq('channel', channel);
    void q.then(({ data }) => setMsgs(((data ?? []) as Msg[]).reverse()));
    const sub = db()
      .channel(`msg:${filter.value}:${channel ?? 'all'}:${value ?? ''}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `${filter.column}=eq.${filter.value}` }, (p) => {
        const m = p.new as Msg;
        if (!channel || m.channel === channel) setMsgs((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
      })
      .subscribe();
    return () => {
      void db().removeChannel(sub);
    };
  }, [filter.column, filter.value, channel, value]);

  useEffect(() => {
    box.current?.scrollTo({ top: box.current.scrollHeight });
  }, [msgs]);

  async function send() {
    if (!text.trim() || !onSend) return;
    setErr(null);
    try {
      await onSend(text.trim());
      setText('');
    } catch (e) {
      setErr(errorText(e));
    }
  }

  return (
    <div className="stack">
      <div ref={box} className="chat" style={{ maxHeight: height }}>
        {msgs.length === 0 && <div className="muted small">Noch keine Nachrichten.</div>}
        {msgs.map((m) => (
          <div key={m.id} className={`bubble${m.sender_id === me ? ' mine' : ''}`}>
            <div className="small muted">{m.sender_name ?? '?'} · {new Date(m.at).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' })}</div>
            <div>{m.body}</div>
          </div>
        ))}
      </div>
      {err && <div className="notice error">{err}</div>}
      {onSend && (
        <form className="row" onSubmit={(e) => { e.preventDefault(); void send(); }}>
          <input aria-label="Nachricht" value={text} maxLength={2000} onChange={(e) => setText(e.target.value)} placeholder="Nachricht" style={{ flex: 1 }} />
          <button type="submit" className="primary" disabled={!text.trim()}>Senden</button>
        </form>
      )}
    </div>
  );
}

export default function Chat({ s }: { s: GameState }) {
  const chans = channelsFor(s);
  const [ch, setCh] = useState((chans.find((c) => c.write && c.id !== 'ankuendigung') ?? chans[0]).id);
  const cur = chans.find((c) => c.id === ch) ?? chans[0];
  return (
    <div className="stack">
      <select aria-label="Kanal" value={cur.id} onChange={(e) => setCh(e.target.value)}>
        {chans.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
      </select>
      <MessageList filter={{ column: 'game_id', value: s.game.id }} channel={cur.id} onSend={cur.write ? (b) => api.send(s.game.id, cur.id, b) : null} />
    </div>
  );
}
