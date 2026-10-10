import { useState, type FormEvent } from 'react';
import { useAuth } from '../lib/auth';
import { db, errorText } from '../lib/supabase';
import { defaultConfig } from '../shared/config';

export const CONSENT_VERSION = '2026-10';
const USERNAME_RE = /^[a-z0-9_.]{3,20}$/;

export default function OnboardingPage() {
  const { session, profile, refresh } = useAuth();
  const minAge = defaultConfig().safety.min_age;
  const [username, setUsername] = useState(profile?.username ?? '');
  const [displayName, setDisplayName] = useState(profile?.display_name ?? '');
  const [ageOk, setAgeOk] = useState(profile?.age_confirmed ?? false);
  const [adult, setAdult] = useState(profile?.is_adult ?? false);
  const [contactName, setContactName] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const uname = username.trim().toLowerCase();
    if (!USERNAME_RE.test(uname)) {
      setError('Benutzername: 3 bis 20 Zeichen, nur a-z, 0-9, Punkt und Unterstrich.');
      return;
    }
    if (!ageOk) {
      setError(`Mitspielen ist erst ab ${minAge} Jahren möglich.`);
      return;
    }
    if (!consent) {
      setError('Bitte bestätige die Regeln zu Nutzung, Datenschutz und Standort.');
      return;
    }
    setBusy(true);
    try {
      const userId = session!.user.id;
      const p = await db()
        .from('profiles')
        .upsert({ user_id: userId, username: uname, display_name: displayName.trim(), age_confirmed: true, is_adult: adult });
      if (p.error) throw p.error;
      const c = await db()
        .from('profile_private')
        .upsert({ user_id: userId, emergency_contact_name: contactName.trim(), emergency_contact_phone: contactPhone.trim() });
      if (c.error) throw c.error;
      const k = await db()
        .from('consents')
        .upsert(
          (['agb', 'datenschutz', 'standort'] as const).map((kind) => ({ user_id: userId, kind, version: CONSENT_VERSION })),
          { onConflict: 'user_id,kind,version', ignoreDuplicates: true },
        );
      if (k.error) throw k.error;
      await refresh();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app">
      <div className="topbar">
        <h1>Dein Profil</h1>
      </div>
      <p className="muted">Einmalig, bevor du mitspielen kannst.</p>
      <form className="stack" onSubmit={submit}>
        <label className="field">
          Benutzername (zum Finden und Einladen)
          <input
            required
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="z. B. marvin_92"
            autoCapitalize="none"
            autoCorrect="off"
          />
        </label>
        <label className="field">
          Anzeigename
          <input required maxLength={40} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </label>

        <h2>Alter</h2>
        <label className="check">
          <input type="checkbox" checked={ageOk} onChange={(e) => setAgeOk(e.target.checked)} />
          <span>Ich bin mindestens {minAge} Jahre alt.</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={adult} onChange={(e) => setAdult(e.target.checked)} />
          <span>Ich bin 18 oder älter. (Unter 18: bitte mit Einverständnis der Eltern spielen.)</span>
        </label>

        <h2>Notfallkontakt</h2>
        <p className="muted small">Nur die Spielleitung deines laufenden Spiels sieht ihn, und nur im Notfall.</p>
        <label className="field">
          Name
          <input required maxLength={80} value={contactName} onChange={(e) => setContactName(e.target.value)} />
        </label>
        <label className="field">
          Telefonnummer
          <input
            required
            type="tel"
            minLength={5}
            maxLength={30}
            value={contactPhone}
            onChange={(e) => setContactPhone(e.target.value)}
            placeholder="+41 79 123 45 67"
          />
        </label>

        <h2>Regeln</h2>
        <label className="check">
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
          <span>
            Ich akzeptiere die Nutzungsbedingungen und den Datenschutz. Mein Standort wird nur während laufender Spiele
            erfasst und nach Spielende automatisch gelöscht. Teilnahme auf eigenes Risiko; Gesetze und Verkehrsregeln
            gelten immer.
          </span>
        </label>

        {error && <div className="notice error">{error}</div>}
        <button className="primary block" disabled={busy}>Speichern und weiter</button>
        <button type="button" className="ghost" onClick={() => db().auth.signOut()}>
          Abmelden
        </button>
      </form>
    </div>
  );
}
