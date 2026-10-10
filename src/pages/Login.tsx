import { useState, type FormEvent } from 'react';
import { db, errorText } from '../lib/supabase';

type Mode = 'login' | 'register' | 'forgot';

export const MIN_PASSWORD = 10;

export default function LoginPage() {
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setInfo(null);
    if (mode === 'register' && password.length < MIN_PASSWORD) {
      setError(`Das Passwort braucht mindestens ${MIN_PASSWORD} Zeichen.`);
      return;
    }
    setBusy(true);
    try {
      const auth = db().auth;
      // Nach der Bestätigung zurück auf dieselbe Seite (z. B. Einladungslink).
      const redirectTo = window.location.href;
      if (mode === 'login') {
        const { error } = await auth.signInWithPassword({ email, password });
        if (error) throw error;
      } else if (mode === 'register') {
        const { data, error } = await auth.signUp({ email, password, options: { emailRedirectTo: redirectTo } });
        if (error) throw error;
        if (!data.session) {
          setInfo('Fast geschafft: Wir haben dir einen Bestätigungslink geschickt. Öffne ihn, dann bist du angemeldet.');
        }
      } else {
        const { error } = await auth.resetPasswordForEmail(email, { redirectTo: window.location.origin });
        if (error) throw error;
        setInfo('Falls es ein Konto mit dieser E-Mail gibt, ist ein Link zum Zurücksetzen unterwegs.');
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app center-screen">
      <div>
        <div className="brand">Hunt Mode</div>
        <p className="muted">Flucht durch die Stadt. Die Taskforce ist dir auf den Fersen.</p>
      </div>

      {mode !== 'forgot' && (
        <div className="tabs" role="tablist">
          <button className={mode === 'login' ? 'active' : ''} onClick={() => setMode('login')}>
            Anmelden
          </button>
          <button className={mode === 'register' ? 'active' : ''} onClick={() => setMode('register')}>
            Registrieren
          </button>
        </div>
      )}

      <form className="stack" onSubmit={submit}>
        {mode === 'forgot' && <h2>Passwort vergessen</h2>}
        <label className="field">
          E-Mail
          <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        {mode !== 'forgot' && (
          <label className="field">
            Passwort {mode === 'register' && <span>(mindestens {MIN_PASSWORD} Zeichen)</span>}
            <input
              type="password"
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              required
              minLength={mode === 'register' ? MIN_PASSWORD : undefined}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
        )}
        {error && <div className="notice error">{error}</div>}
        {info && <div className="notice ok">{info}</div>}
        <button className="primary block" disabled={busy}>
          {mode === 'login' ? 'Anmelden' : mode === 'register' ? 'Konto erstellen' : 'Link senden'}
        </button>
        {mode === 'login' && (
          <button type="button" className="ghost" onClick={() => setMode('forgot')}>
            Passwort vergessen?
          </button>
        )}
        {mode === 'forgot' && (
          <button type="button" className="ghost" onClick={() => setMode('login')}>
            Zurück zur Anmeldung
          </button>
        )}
      </form>
    </div>
  );
}
