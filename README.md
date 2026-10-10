# Hunt Mode

Web-App (PWA) für ein urbanes Verfolgungsspiel nach dem Vorbild der Serie Manhunt:
Spieler fliehen durch die Stadt, eine Taskforce jagt sie. Grundlage ist die
Spezifikation „Manhunt App“ (v1.1). Arbeitstitel „Hunt Mode“, weil der Name
„Manhunt“ der Serie gehört (Spezifikation Kapitel 16).

## Stand: Schritt 1 (Fundament)

- Registrierung mit E-Mail-Bestätigung, Anmeldung, Passwort vergessen
- Profil mit Benutzername, Altersbestätigung, Notfallkontakt, Einwilligungen
- Vollständiges Regelwerk (alle Parameter aus Kapitel 8) mit den 6 Presets aus Kapitel 9
- Regel-Prüfung aus Kapitel 25 (Fehler blockieren den Start, Warnungen nicht)
- Spiel erstellen, mit 6-stelligem Code oder Link `/beitreten/<code>` beitreten
- Lobby mit Live-Teilnehmerliste, Rollen (Host vergibt, Zufall oder Wunschrolle), Bereit-Meldung
- Regel-Editor mit Suche; jede Änderung wird protokolliert

Den Bauplan aller Schritte findest du in [DECISIONS.md](DECISIONS.md).

## Einrichten (einmalig)

### 1. Datenbank (Supabase)

1. Im Supabase-Dashboard dein Projekt öffnen, links **SQL Editor** > **New query**.
2. Den ganzen Inhalt von [`supabase/migrations/0001_fundament.sql`](supabase/migrations/0001_fundament.sql) einfügen und **Run** drücken.
3. **Authentication** > **Sign In / Providers** > **Email**: „Confirm email“ an lassen, Mindestlänge Passwort auf **10** setzen.
4. **Authentication** > **URL Configuration**: Bei **Site URL** die Adresse der App eintragen
   (z. B. `https://hunt-mode.vercel.app`) und unter **Redirect URLs** dieselbe Adresse mit `/**` am Ende.

Hinweis: Der eingebaute E-Mail-Versand von Supabase schickt nur wenige Mails pro Stunde.
Für mehr Leute später einen eigenen SMTP-Dienst (z. B. Resend) unter
**Authentication** > **Emails** > **SMTP Settings** eintragen.

### 2. Zugangsdaten

Im Dashboard unter **Project Settings** > **API Keys** (bzw. **Data API**) findest du:

- **Project URL** → `VITE_SUPABASE_URL`
- **Publishable key** (oder „anon public“) → `VITE_SUPABASE_ANON_KEY`

Niemals den `service_role`- bzw. Secret-Key in die App eintragen.

### 3. Hosting (Vercel, kostenlos)

1. Auf vercel.com mit GitHub anmelden, **Add New** > **Project**, Repository `manhunt-app` importieren.
2. Framework „Vite“ wird erkannt. Unter **Environment Variables** die zwei Werte aus Schritt 2 eintragen.
3. **Deploy**. Die Adresse, die Vercel anzeigt, in Supabase als Site URL eintragen (Schritt 1.4).

Auf dem Handy die Seite öffnen und „Zum Home-Bildschirm hinzufügen“: dann läuft sie wie eine App.

## Entwickeln

```bash
npm install
cp .env.example .env.local   # Werte eintragen
npm run dev                  # http://localhost:5173
npm test                     # Regel-Tests
npm run build                # Typprüfung und Produktions-Build
```

Lokal mit eigener Datenbank: `npx supabase start` (braucht Docker) wendet die Migrationen an;
Bestätigungs-Mails landen dann in Mailpit unter http://127.0.0.1:54324.

## Aufbau

| Ordner | Inhalt |
| --- | --- |
| `src/shared/` | Regelwerk ohne UI: Konfigurationsschema, Presets, Prüfungen, Rollenverteilung (mit Tests) |
| `src/lib/` | Supabase-Anbindung, Anmeldung, Spiel-Aktionen |
| `src/pages/`, `src/components/` | Bildschirme |
| `supabase/migrations/` | Datenbank: Tabellen, Rechte (RLS), Funktionen |
