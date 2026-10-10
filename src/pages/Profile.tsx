import { useEffect, useState, type FormEvent } from 'react';
import { useAuth } from '../lib/auth';
import { db, errorText } from '../lib/supabase';

export default function ProfilePage() {
  const { session, profile, refresh } = useAuth();
  const [displayName, setDisplayName] = useState(profile?.display_name ?? '');
  const [contactName, setContactName] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  useEffect(() => {
    db()
      .from('profile_private')
      .select('*')
      .maybeSingle()
      .then(({ data }) => {
        if (data) {
          setContactName(data.emergency_contact_name);
          setContactPhone(data.emergency_contact_phone);
        }
      });
  }, []);

  async function save(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    const userId = session!.user.id;
    const a = await db().from('profiles').update({ display_name: displayName.trim() }).eq('user_id', userId);
    const b = await db()
      .from('profile_private')
      .upsert({ user_id: userId, emergency_contact_name: contactName.trim(), emergency_contact_phone: contactPhone.trim() });
    const err = a.error ?? b.error;
    setMsg(err ? { kind: 'error', text: errorText(err) } : { kind: 'ok', text: 'Gespeichert.' });
    await refresh();
  }

  return (
    <div className="app">
      <div className="topbar">
        <h1>Profil</h1>
      </div>
      <div className="card">
        <div className="row">
          <div className="avatar">{profile?.display_name.charAt(0).toUpperCase()}</div>
          <div>
            <div>{profile?.display_name}</div>
            <div className="muted small">@{profile?.username} · {session?.user.email}</div>
          </div>
        </div>
      </div>
      <form className="stack" onSubmit={save}>
        <label className="field">
          Anzeigename
          <input required maxLength={40} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </label>
        <h2>Notfallkontakt</h2>
        <label className="field">
          Name
          <input required value={contactName} onChange={(e) => setContactName(e.target.value)} />
        </label>
        <label className="field">
          Telefonnummer
          <input required type="tel" value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} />
        </label>
        {msg && <div className={`notice ${msg.kind}`}>{msg.text}</div>}
        <button className="primary block">Speichern</button>
      </form>
      <h2>Konto</h2>
      <button className="block" onClick={() => db().auth.signOut()}>
        Abmelden
      </button>
      <p className="muted small">Konto löschen und Datenexport folgen in einem späteren Schritt.</p>
    </div>
  );
}
