# Hunt Mode

Web-App (PWA) für ein urbanes Verfolgungsspiel nach dem Vorbild der Serie Manhunt:
Spieler fliehen durch die Stadt, eine Taskforce jagt sie. Grundlage ist die
Spezifikation „Manhunt App“ (v1.1). Arbeitstitel „Hunt Mode“, weil der Name
„Manhunt“ der Serie gehört (Spezifikation Kapitel 16).

## Was die App kann

- Konten mit E-Mail-Bestätigung, Profil mit Notfallkontakt, Gruppen (Crews) mit Einladungslink und Chat
- Vollständiges Regelwerk (Kapitel 8) mit 6 Presets, Regel-Prüfung (Kapitel 25), Regel-Editor mit Protokoll
- Spiel erstellen, per Code/Link beitreten, Live-Lobby, Rollen, Gerätecheck
- **Karten-Editor**: Spielfeld (auch pro Spieltag), Sektionen, Center/Kern/Aussen mit eigenem Ping-Intervall,
  Sperrzonen, sichere Zonen, Exit-Kandidaten, HQ; Ortssuche, GeoJSON-Import/-Export, automatische Verkleinerung
- **Spiel-Engine auf dem Server** (läuft alle 15 s, auch wenn niemand die App offen hat):
  Vorsprung, Spieltage, Silent-Pings mit Frische-Regel, Speedhunts mit allen Einschränkungen, LEO,
  Fang per rotierendem QR-Code oder Bestätigung, Ausserhalb-Zeit, Sperrzonen, ÖV-Pflicht und Erkennung,
  Verschanzen, Teambildungs-Alarm, Budget mit Kauf-Ping, Joker und Boni (inkl. Fake-Ping, Hotel),
  Challenges, Verstösse mit Eskalation, Notfall, Pause, Exitpoint, Spielende und Sieger
- **Ansichten** für Spieler, Taskforce (Hunter/Zentrale), Spielleitung und Zuschauer: Live-Karte,
  Meldungen mit Ton/Vibration, Chat-Kanäle
- **Probelauf**: Spiel mit Vorspul-Knöpfen (+1/+5/+15/+60 min), um alles in wenigen Minuten auszuprobieren
- Ergebnis-Bildschirm mit Wiederholung (Zeitschieber über alle Spuren und Pings)

Grenzen und Entscheidungen stehen in [DECISIONS.md](DECISIONS.md).

## Einrichten (einmalig)

### 1. Datenbank (Supabase)

1. Im Supabase-Dashboard dein Projekt öffnen, links **SQL Editor** > **New query**.
2. Den ganzen Inhalt von [`supabase/alles_in_einem.sql`](supabase/alles_in_einem.sql) einfügen und **Run** drücken.
   (Das sind alle Dateien aus `supabase/migrations/` in der richtigen Reihenfolge. Wer schon
   `0001_fundament.sql` ausgeführt hat, führt stattdessen nur `0002` bis `0007` nacheinander aus.)
3. **Authentication** > **Sign In / Providers** > **Email**: „Confirm email“ an lassen, Mindestlänge Passwort auf **10** setzen.
4. **Authentication** > **URL Configuration**: Bei **Site URL** die Adresse der App eintragen
   (z. B. `https://hunt-mode.vercel.app`) und unter **Redirect URLs** dieselbe Adresse mit `/**` am Ende.

Das Skript schaltet selbst PostGIS (Karten), pg_cron (Zeitplan der Engine, alle 15 s) und den
Speicher-Ordner `beweise` (Fotos) ein. Falls es bei `pg_cron` meckert: **Database** > **Extensions** >
`pg_cron` aktivieren und das Skript nochmals laufen lassen.

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
npm run sql                  # supabase/alles_in_einem.sql neu erzeugen
```

Lokal mit eigener Datenbank: `npx supabase start` (braucht Docker) wendet die Migrationen an;
Bestätigungs-Mails landen dann in Mailpit unter http://127.0.0.1:54324.

## Aufbau

| Ordner | Inhalt |
| --- | --- |
| `src/shared/` | Regelwerk ohne UI: Konfigurationsschema, Presets, Prüfungen, Rollenverteilung (mit Tests) |
| `src/lib/` | Supabase-Anbindung, Anmeldung, Spiel-Aktionen |
| `src/pages/`, `src/components/` | Bildschirme (Start, Lobby, Regeln, Karten-Editor, Gruppen) |
| `src/play/` | Laufendes Spiel: Karte, Spieler-, Taskforce- und Spielleitungs-Ansicht, Chat, Ergebnis |
| `supabase/migrations/` | Datenbank: Tabellen, Rechte (RLS), Spiel-Engine (`0004`), Aktionen (`0005`), Spielstand je Rolle (`0006`), Zeitplan (`0007`) |
