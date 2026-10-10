/**
 * Presets (Spezifikation Kapitel 9). Jedes Preset setzt alle Parameter auf
 * einmal; danach kann der Host jeden Wert ändern. Basis ist immer die
 * Standardkonfiguration (Original New York), das Preset überschreibt nur,
 * was abweicht.
 */
import { defaultConfig, mergeConfig, type DeepPartial, type GameConfig } from './config';

export interface Preset {
  id: string;
  name: string;
  description: string;
  /** Vorgeschlagene Anzahl Spieler / Hunter. */
  suggested: { players: number; hunters: number };
  patch: DeepPartial<GameConfig>;
}

export const PRESETS: Preset[] = [
  {
    id: 'original_new_york',
    name: 'Original New York',
    description: '96 h, 4 Spieltage, Kern- und Aussenzone, Budget 30 USD, Exitpoint.',
    suggested: { players: 9, hunters: 7 },
    patch: {
      roles: { players_max: 9, hunters_max: 7 },
    },
  },
  {
    id: 'original_wien',
    name: 'Original Wien',
    description: '72 h, Sektion pro Spieler, 45-Minuten-Regel und LEO, ohne Budget.',
    suggested: { players: 5, hunters: 5 },
    patch: {
      game: { duration_minutes: 4320, days: 3, day_length_minutes: 1440 },
      roles: { players_max: 5, hunters_max: 5 },
      start: { head_start_minutes: 120 },
      zone: { sections_per_player: true, release_on_catch: true, shrink_mode: 'manuell' },
      ping: { interval_minutes: 120, zone_overrides: {}, during_speedhunt: 'aussetzen' },
      speedhunt: {
        quota_per_day: [1],
        quota_default: 1,
        queries: 5,
        max_duration_minutes: 90,
        min_minutes_after_silent_ping: 45,
        early_start_policy: 'silent_zaehlt_als_abfrage',
        max_per_player_per_day: 1,
        no_consecutive_same_target: false,
        max_parallel: 1,
        vehicle_live_seconds: 0,
        catch_removes_one: false,
      },
      leo: { enabled: true, mode: 'bis_ende_naechste_volle_stunde' },
      out_of_bounds: { live_visible: true, max_minutes: 120, on_timeout: 'catch' },
      hideout: { max_minutes: 120, min_leave_distance_m: 100, lockout_after_first_entry_minutes: 0 },
      transport: { checkin_required: false, live_during: false },
      budget: { enabled: false },
      joker: { enabled: false },
      bonus: { enabled: false },
      challenge: { enabled: false },
      proximity: { enabled: false },
      taskforce: { daily_briefing: true, bounty_per_catch: 0 },
      exit: { enabled: false },
    },
  },
  {
    id: 'original_bangkok',
    name: 'Original Bangkok',
    description: '96 h, Sektionen und Center Zone, Joker und Boni, ÖV-Verbot im Center.',
    suggested: { players: 8, hunters: 7 },
    patch: {
      roles: { players_max: 8, hunters_max: 7 },
      zone: { release_on_catch: true, shrink_mode: 'manuell' },
      ping: { interval_minutes: 120, zone_overrides: { center: 60 } },
      speedhunt: {
        quota_per_day: [2],
        quota_default: 2,
        queries: 4,
        no_consecutive_same_target: false,
        max_parallel: 1,
        vehicle_live_seconds: 0,
        catch_removes_one: false,
      },
      out_of_bounds: { max_minutes: 120, on_timeout: 'catch' },
      hideout: { max_minutes: 120, min_leave_distance_m: 100, lockout_after_first_entry_minutes: 0 },
      transport: { checkin_required: true, forbidden_in_zone_types: ['center'] },
      budget: { enabled: false },
      joker: {
        enabled: true,
        per_day: 1,
        types: [
          { type: 'regeneration', minutes: 240 },
          { type: 'catch_free', minutes: 180 },
        ],
      },
      bonus: { enabled: true, hotel_minutes: 360 },
      challenge: { enabled: true, per_day: 1 },
      proximity: { enabled: false },
      taskforce: { daily_briefing: true, bounty_per_catch: 1000 },
      exit: { enabled: false },
    },
  },
  {
    id: 'wochenende_24h',
    name: 'Wochenende 24 h',
    description: '24 h mit 4 Spieltagen à 6 h, Budget 10 CHF, Joker und Boni.',
    suggested: { players: 6, hunters: 3 },
    patch: {
      game: { duration_minutes: 1440, days: 4, day_length_minutes: 360 },
      roles: { players_max: 6, hunters_max: 3 },
      start: { head_start_minutes: 30 },
      time: { align_to_full_hour: false },
      zone: { shrink_mode: 'auto', auto_shrink_percent: 20, shrink_announce_minutes: 60 },
      ping: { interval_minutes: 45, zone_overrides: { kern: 30 } },
      speedhunt: {
        quota_per_day: [2],
        quota_default: 1,
        queries: 4,
        max_duration_minutes: 45,
        no_consecutive_same_target: true,
        max_parallel: 2,
        vehicle_live_seconds: 60,
        catch_removes_one: true,
      },
      out_of_bounds: { max_minutes: 30, on_timeout: 'catch' },
      hideout: {
        max_minutes: 30,
        min_leave_distance_m: 150,
        lockout_after_first_entry_minutes: 120,
        stationary_minutes: 10,
      },
      transport: { live_after_base_minutes: 5, live_after_increment_minutes: 2 },
      budget: { enabled: true, currency: 'CHF', daily_amount: 10, start_amount: 10 },
      joker: {
        enabled: true,
        per_day: 1,
        types: [
          { type: 'regeneration', minutes: 60 },
          { type: 'catch_free', minutes: 45 },
        ],
      },
      bonus: { enabled: true, hotel_minutes: 60 },
      challenge: { enabled: true, per_day: 1, announce_before_minutes: 30 },
      proximity: { enabled: true, distance_m: 200, active_after_minutes: 30 },
      taskforce: { bounty_per_catch: 0 },
      exit: { enabled: true, reveal_minutes_before_end: 60 },
      win: { prize: 'Punkte' },
    },
  },
  {
    id: 'stadtabend_3h',
    name: 'Stadtabend 3 h',
    description: '3 h mit 4 Spieltagen à 45 min, ein Spielfeld, Pings alle 15 min.',
    suggested: { players: 4, hunters: 2 },
    patch: {
      game: { duration_minutes: 180, days: 4, day_length_minutes: 45 },
      roles: { players_max: 4, hunters_max: 2 },
      start: { head_start_minutes: 10 },
      time: { align_to_full_hour: false },
      zone: { shrink_mode: 'auto', auto_shrink_percent: 15, shrink_announce_minutes: 15 },
      ping: { interval_minutes: 15, zone_overrides: {} },
      speedhunt: {
        quota_per_day: [1],
        quota_default: 1,
        queries: 3,
        max_duration_minutes: 15,
        no_consecutive_same_target: true,
        max_parallel: 2,
        vehicle_live_seconds: 60,
        catch_removes_one: false,
      },
      out_of_bounds: { max_minutes: 5, on_timeout: 'catch' },
      hideout: {
        max_minutes: 8,
        min_leave_distance_m: 100,
        lockout_after_first_entry_minutes: 30,
        stationary_minutes: 5,
      },
      transport: { live_after_base_minutes: 2, live_after_increment_minutes: 1 },
      budget: { enabled: false },
      joker: {
        enabled: true,
        per_day: 1,
        types: [
          { type: 'regeneration', minutes: 15 },
          { type: 'catch_free', minutes: 10 },
        ],
      },
      bonus: { enabled: true, hotel_minutes: 15 },
      challenge: {
        enabled: true,
        per_day: 1,
        announce_before_minutes: 10,
        suspend_proximity_before_minutes: 5,
        suspend_proximity_after_minutes: 5,
      },
      proximity: { enabled: true, distance_m: 150, active_after_minutes: 10 },
      taskforce: { bounty_per_catch: 0 },
      exit: { enabled: true, reveal_minutes_before_end: 20 },
      win: { prize: 'Punkte' },
    },
  },
  {
    id: 'schnell_90min',
    name: 'Schnell 90 min',
    description: '90 min mit 3 Spieltagen à 30 min, nur zu Fuss, Pings alle 10 min.',
    suggested: { players: 3, hunters: 1 },
    patch: {
      game: { duration_minutes: 90, days: 3, day_length_minutes: 30 },
      roles: { players_max: 3, hunters_max: 1 },
      start: { head_start_minutes: 5 },
      time: { align_to_full_hour: false },
      zone: { shrink_mode: 'aus' },
      ping: { interval_minutes: 10, zone_overrides: {} },
      speedhunt: {
        quota_per_day: [1],
        quota_default: 1,
        queries: 3,
        max_duration_minutes: 8,
        no_consecutive_same_target: false,
        max_parallel: 1,
        vehicle_live_seconds: 0,
        catch_removes_one: false,
      },
      out_of_bounds: { max_minutes: 3, on_timeout: 'catch' },
      hideout: {
        max_minutes: 5,
        min_leave_distance_m: 75,
        lockout_after_first_entry_minutes: 0,
        stationary_minutes: 5,
      },
      transport: { allowed_modes: ['zu_fuss'], checkin_required: false, live_during: false },
      budget: { enabled: false },
      joker: {
        enabled: true,
        per_day: 1,
        carry_over: 'unbegrenzt',
        max_inventory: 1,
        types: [{ type: 'regeneration', minutes: 8 }],
      },
      bonus: { enabled: false },
      challenge: { enabled: false },
      proximity: { enabled: true, distance_m: 100, active_after_minutes: 5 },
      taskforce: { hq_required: false, bounty_per_catch: 0 },
      exit: { enabled: false },
      win: { prize: 'Punkte' },
    },
  },
];

export function getPreset(id: string): Preset | undefined {
  return PRESETS.find((p) => p.id === id);
}

export function configFromPreset(id: string): GameConfig {
  const preset = getPreset(id);
  if (!preset) throw new Error(`Unbekanntes Preset: ${id}`);
  return mergeConfig(defaultConfig(), preset.patch);
}
