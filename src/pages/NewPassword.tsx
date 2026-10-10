import { useState, type FormEvent } from 'react';
import { useAuth } from '../lib/auth';
import { db, errorText } from '../lib/supabase';
import { MIN_PASSWORD } from './Login';

export default function NewPasswordPage() {
  const { clearRecovering } = useAuth();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password.length < MIN_PASSWORD) {
      setError(`Das Passwort braucht mindestens ${MIN_PASSWORD} Zeichen.`);
      return;
    }
    setBusy(true);
    const { error } = await db().auth.updateUser({ password });
    setBusy(false);
    if (error) setError(errorText(error));
    else {
      // Alle anderen Sitzungen abmelden (Kapitel 20.2).
      await db().auth.signOut({ scope: 'others' });
      clearRecovering();
    }
  }

  return (
    <div className="app center-screen">
      <h1>Neues Passwort</h1>
      <form className="stack" onSubmit={submit}>
        <label className="field">
          Neues Passwort (mindestens {MIN_PASSWORD} Zeichen)
          <input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <div className="notice error">{error}</div>}
        <button className="primary block" disabled={busy}>Speichern</button>
      </form>
    </div>
  );
}
