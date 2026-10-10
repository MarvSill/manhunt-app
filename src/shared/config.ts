/**
 * Spielkonfiguration (Spezifikation Kapitel 8).
 *
 * Jeder Zahlenwert der Regeln ist hier ein Parameter. Standardwerte = Preset
 * "Original New York". Die Beschriftung jedes Feldes steckt in `.describe()`,
 * damit der Regel-Editor direkt aus dem Schema gebaut werden kann.
 */
import { z } from 'zod';

const int = (def: number, min: number, max: number, label: string) =>
  z.number().int().min(min).max(max).default(def).describe(label);

const bool = (def: boolean, label: string) => z.boolean().default(def).describe(label);

const choice = <T extends [string, ...string[]]>(values: T, def: T[number], label: string) =>
  z.enum(values).default(def as never).describe(label);

const text = (def: string, max: number, label: string) =>
  z.string().max(max).default(def).describe(label);

export const TRANSPORT_MODES = [
  'zu_fuss',
  'oev_bus',
  'oev_bahn',
  'oev_tram',
  'faehre',
  'taxi',
  'fahrrad',
  'scooter',
  'eigenes_fahrzeug',
] as const;

export const JOKER_TYPES = ['regeneration', 'hunter_erfragen', 'catch_free'] as const;

export const CATCH_METHODS = ['qr', 'touch_confirm', 'nfc', 'bluetooth', 'handcuffs'] as const;

export const PENALTY_STEPS = ['verwarnung', 'straf_speedhunt', 'disqualifikation'] as const;

const jokerTypeSchema = z.object({
  type: z.enum(JOKER_TYPES),
  minutes: z.number().int().min(0).max(1440).optional(),
});

const quietHourSchema = z.object({
  from: z.string().regex(/^\d{2}:\d{2}$/),
  to: z.string().regex(/^\d{2}:\d{2}$/),
});

export const gameConfigSchema = z.object({
  game: z
    .object({
      timezone: text('Europe/Zurich', 64, 'Zeitzone'),
      duration_minutes: int(5760, 15, 20160, 'Jagddauer (min)'),
      days: int(4, 1, 14, 'Anzahl Spieltage'),
      day_length_minutes: int(1440, 10, 1440, 'Länge Spieltag (min)'),
      day_reset_time: z
        .string()
        .regex(/^\d{2}:\d{2}$/)
        .default('06:00')
        .describe('Uhrzeit Tagesreset (bei 24-h-Tagen)'),
      quiet_hours: z.array(quietHourSchema).default([]).describe('Jagdfreie Zeiten'),
      pause_extends_game: bool(true, 'Pause verlängert Spiel'),
      host_can_play: bool(false, 'Host spielt mit'),
    })
    .default({})
    .describe('Spiel und Zeit'),
  roles: z
    .object({
      players_max: int(9, 1, 100, 'Max. Spieler'),
      hunters_max: int(7, 1, 50, 'Max. Hunter'),
      assignment: choice(['host', 'zufall', 'selbst'], 'host', 'Rollenvergabe'),
      balanced_random: bool(true, 'Ausgeglichene Zufallsverteilung'),
      gm_mode: choice(['auto', 'mensch', 'beides'], 'auto', 'Spielleitung'),
    })
    .default({})
    .describe('Rollen'),
  start: z
    .object({
      head_start_minutes: int(60, 0, 600, 'Vorsprung (min)'),
      hq_min_distance_m: int(300, 0, 10000, 'Mindestabstand HQ zu Treffpunkt (m)'),
      hq_radius_m: int(100, 20, 1000, 'HQ-Kreis (m)'),
      hunters_must_stay_in_hq: bool(true, 'Hunter bleiben im HQ während Vorsprung'),
    })
    .default({})
    .describe('Start'),
  lobby: z
    .object({
      open_minutes_before: int(60, 5, 1440, 'Lobby öffnet vor Start (min)'),
      min_battery_percent: int(60, 0, 100, 'Akku für Startfreigabe (%)'),
    })
    .default({})
    .describe('Lobby'),
  time: z
    .object({
      align_to_full_hour: bool(true, 'Auf volle Stunden ausrichten'),
      scale_auto: bool(false, 'Dauern proportional skalieren'),
    })
    .default({})
    .describe('Zeitraster'),
  zone: z
    .object({
      edge_tolerance_m: int(25, 0, 200, 'GPS-Toleranz am Rand (m)'),
      shrink_mode: choice(['manuell', 'auto', 'aus'], 'manuell', 'Spielfeld-Verkleinerung'),
      auto_shrink_percent: int(20, 1, 80, 'Verkleinerung pro Spieltag (%)'),
      shrink_announce_minutes: int(180, 0, 1440, 'Vorankündigung Verkleinerung (min)'),
      shrink_grace_minutes: int(0, 0, 120, 'Übergangsfrist (min)'),
      release_on_catch: bool(false, 'Sektion wird bei Fang frei'),
      sections_per_player: bool(false, 'Eigene Sektion pro Spieler'),
      restricted_counts_as_outside: bool(false, 'Sperrzone zählt als ausserhalb'),
      restricted_crossing_max_seconds: int(60, 0, 600, 'Sperrzone überqueren erlaubt (s)'),
    })
    .default({})
    .describe('Spielfeld und Zonen'),
  ping: z
    .object({
      interval_minutes: int(120, 1, 720, 'Silent-Ping-Intervall (min)'),
      zone_overrides: z
        .record(z.string(), z.number().int().min(1).max(720))
        .default({ kern: 60 })
        .describe('Intervall je Zonentyp (min)'),
      offset_minutes: int(0, 0, 719, 'Versatz (min)'),
      jitter_minutes: int(0, 0, 30, 'Zufallsversatz (min)'),
      notify_player: bool(false, 'Spieler merkt den Ping'),
      during_speedhunt: choice(['weiterlaufen', 'aussetzen'], 'weiterlaufen', 'Silent-Pings im Speedhunt'),
      first_ping_delay_minutes: int(0, 0, 600, 'Erster Ping nach Vorsprung (min)'),
      precision_blur_m: int(0, 0, 1000, 'Unschärfe (m)'),
      gm_can_change_live: bool(true, 'Spielleitung darf live ändern'),
      max_age_seconds: int(60, 10, 600, 'Frische-Regel (s)'),
      fresh_fix_wait_seconds: int(30, 5, 120, 'Wartezeit auf frischen Standort (s)'),
      show_suppressed_to_taskforce: bool(false, '"Kein Signal" anzeigen'),
      fade_after_minutes: int(60, 5, 600, 'Marker verblassen nach (min)'),
      history_per_player: int(5, 1, 50, 'Sichtbare Pings pro Spieler'),
      reveal_schedule_to_taskforce: bool(true, 'Nächster Ping-Zeitpunkt sichtbar'),
    })
    .default({})
    .describe('Silent-Pings'),
  speedhunt: z
    .object({
      enabled: bool(true, 'Speedhunt aktiv'),
      quota_per_day: z
        .array(z.number().int().min(0).max(20))
        .default([3])
        .describe('Kontingent je Tag (Tag 1, Tag 2, ...)'),
      quota_default: int(2, 0, 20, 'Kontingent Folgetage'),
      carry_over: bool(false, 'Ungenutzte übertragen'),
      trigger_mode: choice(['taskforce', 'random', 'gm'], 'taskforce', 'Auslöser'),
      gm_approval: bool(false, 'Freigabe durch Spielleitung'),
      queries: int(4, 1, 20, 'Abfragen pro Speedhunt'),
      query_min_gap_minutes: int(0, 0, 60, 'Mindestabstand Abfragen (min)'),
      max_duration_minutes: int(90, 5, 480, 'Maximale Dauer (min)'),
      min_minutes_after_silent_ping: int(0, 0, 120, 'Abstand zum Silent-Ping (min)'),
      early_start_policy: choice(
        ['verbieten', 'silent_zaehlt_als_abfrage'],
        'silent_zaehlt_als_abfrage',
        'Zu früher Start',
      ),
      max_per_player_per_day: int(0, 0, 10, 'Max. pro Spieler und Tag (0 = unbegrenzt)'),
      no_consecutive_same_target: bool(true, 'Nicht zweimal hintereinander gleiches Ziel'),
      consecutive_allowed_when_players_left_le: int(2, 1, 10, 'Ausnahme ab so wenigen freien Spielern'),
      max_parallel: int(2, 1, 10, 'Gleichzeitig laufend'),
      vehicle_live_seconds: int(60, 0, 600, 'Live bei Fahrzeug (s)'),
      catch_removes_one: bool(true, 'Fang streicht einen Speedhunt'),
      reveal_target_to_target: bool(false, 'Ziel erfährt, dass es gejagt wird'),
      notify_each_query_to_players: bool(true, 'Spieler hören jede Abfrage'),
      announce_text: text('Speedhunt gestartet!', 200, 'Meldungstext'),
    })
    .default({})
    .describe('Speedhunt'),
  leo: z
    .object({
      enabled: bool(false, 'LEO-Schutzfenster'),
      mode: choice(['bis_ende_naechste_volle_stunde', 'feste_dauer'], 'bis_ende_naechste_volle_stunde', 'Art'),
      duration_minutes: int(60, 0, 240, 'Dauer bei fester Dauer (min)'),
    })
    .default({})
    .describe('LEO (Schutz nach Speedhunt)'),
  catch: z
    .object({
      method: z.array(z.enum(CATCH_METHODS)).min(1).default(['qr']).describe('Fangmethode'),
      max_distance_m: int(30, 5, 200, 'GPS-Plausibilität (m)'),
      confirm_seconds: int(60, 10, 300, 'Bestätigungsfrist (s)'),
      require_media: bool(false, 'Foto/Video-Beweis'),
      announce_to_players: bool(true, 'Fang öffentlich'),
      caught_player_becomes: choice(['zuschauer', 'hunter_helfer', 'nichts'], 'zuschauer', 'Gefangene werden'),
      track_after_catch: bool(false, 'Ortung nach Fang weiter'),
    })
    .default({})
    .describe('Fang'),
  out_of_bounds: z
    .object({
      live_visible: bool(true, 'Live für Taskforce'),
      max_minutes: int(120, 1, 600, 'Limit (min)'),
      count_mode: choice(['pro_ausflug', 'pro_tag'], 'pro_ausflug', 'Zählweise'),
      on_timeout: choice(['catch', 'disqualify', 'penalty'], 'disqualify', 'Folge bei Ablauf'),
      grace_seconds: int(60, 0, 600, 'Toleranz (s)'),
    })
    .default({})
    .describe('Ausserhalb des Spielfelds'),
  hideout: z
    .object({
      enabled: bool(true, 'Verschanzen-Regel aktiv'),
      max_minutes: int(120, 5, 720, 'Limit (min)'),
      min_leave_distance_m: int(200, 0, 2000, 'Mindestabstand beim Verlassen (m)'),
      lockout_after_first_entry_minutes: int(480, 0, 2880, 'Ort gesperrt nach (min, 0 = aus)'),
      detection: choice(['selbstmeldung', 'automatisch', 'beides'], 'beides', 'Erkennung'),
      stationary_radius_m: int(40, 10, 200, 'Erkennung Radius (m)'),
      stationary_minutes: int(20, 5, 120, 'Erkennung Dauer (min)'),
      on_timeout: choice(['catch', 'penalty'], 'catch', 'Folge bei Ablauf'),
    })
    .default({})
    .describe('Verschanzen'),
  transport: z
    .object({
      allowed_modes: z
        .array(z.enum(TRANSPORT_MODES))
        .default(TRANSPORT_MODES.filter((m) => m !== 'eigenes_fahrzeug'))
        .describe('Erlaubte Fortbewegung'),
      checkin_required: bool(true, 'Anmeldepflicht'),
      live_during: bool(true, 'Live während Fahrt'),
      live_after_base_minutes: int(10, 0, 120, 'Nachlauf (min)'),
      live_after_increment_minutes: int(5, 0, 60, 'Zuwachs je Fahrt (min)'),
      ferry_max_stops_per_day: int(10, 0, 100, 'Fähren-Limit pro Tag'),
      forbidden_in_zone_types: z.array(z.string()).default([]).describe('Verboten in Zonentypen'),
      violation_repeat_minutes: int(10, 1, 60, 'Wiederholungsverstoss (min)'),
      speed_threshold_kmh: int(8, 5, 25, 'Erkennung ab (km/h)'),
      detect_seconds: int(90, 30, 600, 'Erkennungsdauer (s)'),
    })
    .default({})
    .describe('Fortbewegung und ÖV'),
  budget: z
    .object({
      enabled: bool(true, 'Budget aktiv'),
      currency: z.string().regex(/^[A-Z]{3}$/).default('USD').describe('Währung (ISO)'),
      daily_amount: int(30, 0, 1000, 'Tagesbudget'),
      start_amount: int(30, 0, 1000, 'Startbudget'),
      allow_saving: bool(false, 'Ansparen erlaubt'),
      reveal_amount: bool(false, 'Betrag an Taskforce'),
      ping_delay_minutes: int(0, 0, 60, 'Verzögerung Kauf-Ping (min)'),
      receipt_photo_required: bool(false, 'Belegfoto Pflicht'),
    })
    .default({})
    .describe('Budget'),
  joker: z
    .object({
      enabled: bool(false, 'Joker aktiv'),
      per_day: int(1, 0, 5, 'Joker pro Tag'),
      selection: choice(['spieler_waehlt', 'zufall', 'fest_pro_tag'], 'zufall', 'Vergabe'),
      carry_over: choice(['nie', 'einen_tag', 'unbegrenzt'], 'einen_tag', 'Aufheben'),
      max_inventory: int(2, 1, 10, 'Max. im Besitz'),
      types: z
        .array(jokerTypeSchema)
        .default([
          { type: 'regeneration', minutes: 240 },
          { type: 'hunter_erfragen' },
          { type: 'catch_free', minutes: 180 },
        ])
        .describe('Aktive Joker'),
    })
    .default({})
    .describe('Joker'),
  bonus: z
    .object({
      enabled: bool(true, 'Boni aktiv'),
      expire_at_day_reset: bool(true, 'Verfallen beim Tagesreset'),
      fake_ping_max_distance_m: int(3000, 100, 20000, 'Fake-Ping-Radius (m)'),
      fake_ping_chooser: choice(['spieler', 'spielleitung'], 'spieler', 'Fake-Ping wählt'),
      hotel_minutes: int(360, 10, 720, 'Hotel-Dauer (min)'),
      hotel_radius_m: int(50, 10, 200, 'Hotel-Radius (m)'),
      hotel_pings: choice(['weiter', 'pausiert'], 'weiter', 'Pings im Hotel'),
    })
    .default({})
    .describe('Boni'),
  challenge: z
    .object({
      enabled: bool(true, 'Challenges aktiv'),
      per_day: int(1, 0, 10, 'Challenges pro Tag'),
      announce_before_minutes: int(60, 0, 720, 'Ankündigung vorher (min)'),
      suspend_proximity_before_minutes: int(60, 0, 240, 'Teambildungsregel aus, vorher (min)'),
      suspend_proximity_after_minutes: int(60, 0, 240, 'Teambildungsregel aus, nachher (min)'),
    })
    .default({})
    .describe('Challenges'),
  proximity: z
    .object({
      enabled: bool(true, 'Teambildungs-Alarm aktiv'),
      distance_m: int(250, 10, 2000, 'Abstand (m)'),
      active_after_minutes: int(60, 0, 600, 'Aktiv ab Start (min)'),
      hysteresis_m: int(50, 0, 500, 'Hysterese (m)'),
      repeat_minutes: int(0, 0, 120, 'Wiederholung (min)'),
    })
    .default({})
    .describe('Teambildung / Nähe'),
  taskforce: z
    .object({
      hq_required: bool(true, 'Zentrale muss besetzt sein'),
      daily_briefing: bool(false, 'Tägliche Einsatzbesprechung'),
      bounty_per_catch: int(1000, 0, 100000, 'Kopfgeld pro Fang'),
      share_positions_internally: bool(true, 'Hunter sehen sich gegenseitig'),
    })
    .default({})
    .describe('Taskforce'),
  exit: z
    .object({
      enabled: bool(true, 'Exitpoint aktiv'),
      radius_m: int(30, 5, 500, 'Radius (m)'),
      reveal_minutes_before_end: int(120, 0, 1440, 'Bekanntgabe vor Ende (min)'),
      reveal_to_taskforce: choice(['gleichzeitig', 'verzoegert', 'nie'], 'gleichzeitig', 'Taskforce erfährt Exit'),
      arrival_deadline_offset_minutes: int(15, 0, 120, 'Ankunftsfrist nach Ende (min)'),
      confirm: choice(['geofence', 'qr', 'spielleitung'], 'geofence', 'Bestätigung'),
      missed_policy: choice(['verloren', 'gewonnen_ohne_exit'], 'verloren', 'Nicht angekommen'),
      random_from_candidates: bool(true, 'Exit zufällig aus Kandidaten'),
    })
    .default({})
    .describe('Exitpoint'),
  win: z
    .object({
      mode: choice(['alle_ueberlebenden', 'letzter_ueberlebender', 'punkte'], 'alle_ueberlebenden', 'Siegmodus'),
      prize: text('5000 EUR', 100, 'Preis (Anzeige)'),
    })
    .default({})
    .describe('Sieg'),
  penalty: z
    .object({
      auto_apply_delay_seconds: int(60, 0, 600, 'Auto-Strafe nach (s)'),
      escalation: z
        .array(z.enum(PENALTY_STEPS))
        .default(['verwarnung', 'straf_speedhunt', 'disqualifikation'])
        .describe('Eskalation'),
      after_game_end: bool(false, 'Nachträgliche Strafen'),
    })
    .default({})
    .describe('Strafen'),
  safety: z
    .object({
      emergency_pauses: choice(['person', 'alle'], 'person', 'Notfall pausiert'),
      min_age: int(16, 0, 99, 'Mindestalter'),
      battery_warn_percent: int(25, 5, 50, 'Akkuwarnung (%)'),
    })
    .default({})
    .describe('Sicherheit'),
  tracking: z
    .object({
      sample_interval_seconds: int(15, 5, 120, 'GPS-Intervall (s)'),
      signal_loss_max_minutes: int(15, 1, 120, 'Signalverlust-Meldung nach (min)'),
    })
    .default({})
    .describe('Ortung'),
  communication: z
    .object({
      player_to_player: bool(false, 'Chat zwischen Spielern'),
    })
    .default({})
    .describe('Kommunikation'),
  spectator: z
    .object({
      enabled: bool(false, 'Zuschauer erlaubt'),
      delay_minutes: int(30, 0, 240, 'Verzögerung (min)'),
    })
    .default({})
    .describe('Zuschauer'),
  documentation: z
    .object({
      required_minutes_per_day: int(0, 0, 1440, 'Filmpflicht pro Tag (min)'),
    })
    .default({})
    .describe('Dokumentation'),
  equipment: z
    .object({
      personal_items_max: int(2, 0, 10, 'Persönliche Gegenstände max.'),
    })
    .default({})
    .describe('Ausrüstung'),
  privacy: z
    .object({
      retention_days: int(30, 1, 365, 'Standortdaten löschen nach (Tage)'),
    })
    .default({})
    .describe('Datenschutz'),
  account: z
    .object({
      require_verified_email: bool(true, 'Bestätigte E-Mail Pflicht'),
    })
    .default({})
    .describe('Konten'),
});

export type GameConfig = z.infer<typeof gameConfigSchema>;
export type ConfigSection = keyof GameConfig;

/** Aktuelle Schema-Version, wird mit jeder Konfiguration gespeichert. */
export const CONFIG_VERSION = 1;

/** Vollständige Standardkonfiguration (= Original New York). */
export function defaultConfig(): GameConfig {
  return gameConfigSchema.parse({});
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends unknown[] ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K];
};

/** Legt `patch` über `base`. Arrays und Maps werden ersetzt, nicht gemischt. */
export function mergeConfig(base: GameConfig, patch: DeepPartial<GameConfig>): GameConfig {
  const out = structuredClone(base) as Record<string, Record<string, unknown>>;
  for (const [section, values] of Object.entries(patch)) {
    if (!values) continue;
    out[section] = { ...out[section], ...structuredClone(values) };
  }
  return gameConfigSchema.parse(out);
}

/** Liest eine gespeicherte Konfiguration; fehlende Felder bekommen Standardwerte. */
export function parseConfig(raw: unknown): GameConfig {
  return gameConfigSchema.parse(raw ?? {});
}
