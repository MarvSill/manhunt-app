import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { STATUS_LABELS } from '../lib/games';
import { appUrl, db, errorText } from '../lib/supabase';
import { MessageList } from '../play/Chat';

interface Group { id: string; name: string; description: string | null; invite_code: string; owner_id: string; members_can_create_games: boolean }
interface Member { user_id: string; username: string; display_name: string; role: string }
interface GGame { id: string; name: string; code: string; status: string; start_at: string | null }

export default function GroupPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { session } = useAuth();
  const [g, setG] = useState<Group | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [games, setGames] = useState<GGame[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function load() {
    if (!id) return;
    const [a, b, c] = await Promise.all([
      db().from('groups').select('*').eq('id', id).maybeSingle(),
      db().rpc('group_roster', { p_group_id: id }),
      db().rpc('group_games', { p_group_id: id }),
    ]);
    if (a.error || b.error || c.error) setErr(errorText(a.error ?? b.error ?? c.error));
    setG(a.data as Group | null);
    setMembers((b.data ?? []) as Member[]);
    setGames((c.data ?? []) as GGame[]);
  }

  useEffect(() => {
    void load();
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function run(fn: string, args: Record<string, unknown>, after?: () => void) {
    setErr(null);
    const { error } = await db().rpc(fn, args);
    if (error) return setErr(errorText(error));
    after?.();
    await load();
  }

  if (!g) return <div className="app">{err ? <div className="notice error">{err}</div> : <span className="muted">Lade …</span>}</div>;
  const myRole = members.find((m) => m.user_id === session?.user.id)?.role;
  const owner = g.owner_id === session?.user.id;
  const admin = myRole === 'besitzer' || myRole === 'admin';

  async function share() {
    const url = appUrl(`/gruppe/${g!.invite_code}`);
    const text = `Tritt der Gruppe "${g!.name}" bei: ${url}`;
    if (navigator.share) {
      try { await navigator.share({ title: 'Hunt Mode', text, url }); return; } catch { /* abgebrochen */ }
    }
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="app">
      <div className="topbar">
        <Link to="/gruppen" className="button ghost small">←</Link>
        <h1>{g.name}</h1>
      </div>
      {err && <div className="notice error" style={{ marginBottom: 12 }}>{err}</div>}
      <div className="card stack">
        <div className="muted small" style={{ textAlign: 'center' }}>Einladungs-Code</div>
        <div className="code-big">{g.invite_code}</div>
        <button onClick={share}>{copied ? 'Kopiert!' : 'Einladung teilen'}</button>
        {owner && (
          <label className="check">
            <input type="checkbox" checked={g.members_can_create_games}
              onChange={async (e) => { await db().from('groups').update({ members_can_create_games: e.target.checked }).eq('id', g.id); await load(); }} />
            <span>Alle Mitglieder dürfen Gruppenspiele erstellen</span>
          </label>
        )}
      </div>

      <h2>Spiele der Gruppe</h2>
      <div className="card">
        <ul className="list">
          {games.map((x) => (
            <li key={x.id}>
              <span className="spacer">{x.name} <span className="muted small">Code {x.code}</span></span>
              <span className="badge">{STATUS_LABELS[x.status] ?? x.status}</span>
              <Link to={`/beitreten/${x.code}`} className="button small">Öffnen</Link>
            </li>
          ))}
          {games.length === 0 && <li className="muted small">Noch keine. Erstelle ein Spiel und ordne es dieser Gruppe zu.</li>}
        </ul>
      </div>

      <h2>Mitglieder ({members.length})</h2>
      <div className="card">
        <ul className="list">
          {members.map((m) => (
            <li key={m.user_id}>
              <div className="avatar">{m.display_name.charAt(0).toUpperCase()}</div>
              <div className="spacer"><div>{m.display_name}</div><div className="muted small">@{m.username}</div></div>
              <span className="badge">{m.role}</span>
              {owner && m.user_id !== session?.user.id && (
                <select aria-label={`Rolle ${m.display_name}`} value="" onChange={(e) => {
                  const v = e.target.value;
                  if (v === 'entfernen') void run('remove_group_member', { p_group_id: g.id, p_user_id: m.user_id });
                  else if (v) void run('set_group_member_role', { p_group_id: g.id, p_user_id: m.user_id, p_role: v });
                }}>
                  <option value="">…</option>
                  <option value="admin">Admin</option>
                  <option value="mitglied">Mitglied</option>
                  <option value="besitzer">Besitz übertragen</option>
                  <option value="entfernen">Entfernen</option>
                </select>
              )}
              {!owner && admin && m.role === 'mitglied' && (
                <button className="small ghost" onClick={() => run('remove_group_member', { p_group_id: g.id, p_user_id: m.user_id })}>Entfernen</button>
              )}
            </li>
          ))}
        </ul>
      </div>

      <h2>Chat</h2>
      <div className="card">
        <MessageList filter={{ column: 'group_id', value: g.id }} channel={null} height="40dvh"
          onSend={async (body) => { const { error } = await db().rpc('send_group_message', { p_group_id: g.id, p_body: body }); if (error) throw error; }} />
      </div>

      <div className="row" style={{ marginTop: 12 }}>
        {!owner && <button className="ghost" onClick={() => run('leave_group', { p_group_id: g.id }, () => navigate('/gruppen'))}>Gruppe verlassen</button>}
        {owner && <button className="ghost" onClick={() => { if (confirm('Gruppe wirklich löschen?')) void run('delete_group', { p_group_id: g.id }, () => navigate('/gruppen')); }}>Gruppe löschen</button>}
      </div>
    </div>
  );
}
