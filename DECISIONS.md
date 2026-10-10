# Entscheidungen und Annahmen

Abweichungen von der Spezifikation und Annahmen, wo sie nichts festlegt.

## Bauplan

1. Fundament: Konten, Profil, Regelwerk, Presets, Prüfung, Spiel erstellen/beitreten, Lobby (**erledigt**)
2. Karte: Spielfeld, Zonen, Sperrzonen, Exitpoint, Startprüfungen, Standort-/Gerätecheck
3. Spiel-Engine: Start, Vorsprung, Spieltage, Silent-Pings, Live-Fenster, Ausserhalb, Pause, Notfall
4. Speedhunt, Fang (QR), Exitpoint, Spielende
5. Verschanzen, ÖV, Budget, Teambildungs-Alarm
6. Joker, Boni, Challenges
7. Strafen, Verstoss-Fälle, Spielleitungs-Cockpit, Live-Regeländerung
8. Gruppen, Einladungslinks, Chat, Push, Zuschauer, Replay, Statistik
9. Feinschliff, i18n, Konto löschen/Datenexport, optional native App

## Technik

- **PWA statt Expo/React Native** (Kapitel 12 empfiehlt Expo). Grund: Freunde sollen ohne App Store
  mitspielen. Folge: Im Browser läuft die Ortung nur, solange die App offen ist. Falls nötig wird
  derselbe Code in Schritt 9 mit Capacitor als native App mit Hintergrund-Ortung verpackt.
- **Ein Paket statt Monorepo.** Die Regel-Logik liegt UI-frei in `src/shared/` und kann später in
  eine Engine (Supabase Edge Functions/pg_cron oder eigener Dienst, Entscheidung in Schritt 3) wandern.
- Schreibzugriffe auf Spiele und Teilnehmende nur über Datenbank-Funktionen (RPC), Lesen über RLS.
- Notfallkontakt liegt in eigener Tabelle `profile_private`, nur für die Person selbst lesbar.

## Annahmen zum Regelwerk

- `ping.align_to_full_hour` (Hinweis in Kapitel 9) ist nicht im Parameterkatalog; es gilt `time.align_to_full_hour`.
- Presets mit „Kontingent danach: GM“ (Wien, Bangkok, NY): `speedhunt.quota_default` ist mit dem Wert von Tag 1
  bzw. dem Katalog-Standard vorbelegt; die Spielleitung ändert ihn live (ab Schritt 7).
- „Schnell 90 min: Joker 1 gesamt“ hat keinen eigenen Parameter. Umgesetzt als 1 Joker pro Tag, max. 1 im Besitz.
- Kurze Presets: Werte, die länger als ein Spieltag wären (Challenge-Ankündigung, Zonen-Ankündigung,
  Verschanzen-Erkennung), wurden auf passende Werte verkürzt.
- „Nicht 2x gleiches Ziel / parallel 2: aus“ = `no_consecutive_same_target` aus und `max_parallel` 1.
- Konsistenzregel „mehr als 1 Speedhunt pro Spieler und Spieltag“: geprüft als Tageskontingent > Anzahl Spieler.
- Ein Rollenwechsel durch den Host setzt „bereit“ zurück, damit jede Person ihre Rolle bestätigt.
- Beitreten verlangt bestätigte E-Mail, vollständiges Profil und Notfallkontakt (Kapitel 20.1, für alle Rollen).

## Noch offen in Schritt 1

- Balance-Einschätzung (Kapitel 25, SOLL) braucht die Spielfeldfläche, kommt mit der Karte.
- „Ausgeglichene“ Zufallsverteilung nach bisherigen Rollen braucht Spielhistorie (ab Schritt 8).
- Benutzername ändern (alle 30 Tage), Konto löschen, Datenexport, Apple/Google-Login, Captcha: spätere Schritte.
- Serverseitige Prüfung der Konfiguration beim Start kommt mit der Engine (Schritt 3).
