import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { db, errorText } from '../lib/supabase';

interface Group { id: string; name: string; description: string | null; invite_code: string; owner_id: string }

export default function GroupsPage() {
  const { code: urlCode } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [name, setName] = useState('');
  const [code, setCode] = useState(urlCode ?? '');
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    const { data, error } = await db().from('groups').select('*').order('created_at', { ascending: false });
    if (error) setErr(errorText(error));
    else setGroups(data as Group[]);
  }

  useEffect(() => {
    void load();
  }, []);

  async function create() {
    setErr(null);
    const { data, error } = await db().rpc('create_group', { p_name: name, p_description: null });
    if (error) return setErr(errorText(error));
    navigate(`/gruppen/${(data as Group).id}`);
  }

  async function join(c = code) {
    setErr(null);
    const { data, error } = await db().rpc('join_group', { p_code: c.trim() });
    if (error) return setErr(errorText(error));
    navigate(`/gruppen/${(data as Group).id}`);
  }

  useEffect(() => {
    if (urlCode && /^\d{8}$/.test(urlCode)) void join(urlCode);
  }, [urlCode]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="app">
      <div className="topbar"><h1>Gruppen</h1></div>
      <p className="muted small">Eine Gruppe ist deine feste Crew: Chat, gemeinsame Spiele und schnelles Einladen.</p>
      {err && <div className="notice error" style={{ marginBottom: 12 }}>{err}</div>}
      {groups && groups.length > 0 && (
        <div className="card">
          <ul className="list">
            {groups.map((g) => (
              <li key={g.id}><Link to={`/gruppen/${g.id}`} className="spacer" style={{ color: 'inherit', textDecoration: 'none' }}>{g.name}</Link></li>
            ))}
          </ul>
        </div>
      )}
      {groups?.length === 0 && <p className="muted">Du bist noch in keiner Gruppe.</p>}
      <div className="card stack">
        <h2 style={{ margin: 0 }}>Neue Gruppe</h2>
        <input aria-label="Gruppenname" placeholder="Name (3 bis 40 Zeichen)" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
        <button className="primary" disabled={name.trim().length < 3} onClick={create}>Gruppe erstellen</button>
      </div>
      <div className="card stack">
        <h2 style={{ margin: 0 }}>Gruppe beitreten</h2>
        <input aria-label="Gruppen-Code" inputMode="numeric" placeholder="8-stelliger Code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} maxLength={8} />
        <button disabled={code.length !== 8} onClick={() => join()}>Beitreten</button>
      </div>
    </div>
  );
}
