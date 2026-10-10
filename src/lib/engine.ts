import type { GameConfig } from '../shared/config';
import type { Role } from './games';
import { db } from './supabase';

// Spielstand aus game_state() (supabase/migrations/0006_spielstand.sql).
export interface Effect { id: string; type: string; ends_at: string | null; payload: Record<string, unknown> }
export interface Item { id: string; kind: 'joker' | 'bonus'; type: string; minutes: number | null; source: string | null }
export interface Participant {
  id: string; name: string; username: string; role: Role; color: string | null; state: string;
  battery: number | null; last_seen_at: string | null; bounty: number; budget: number | null;
  device_check: Record<string, unknown> | null; next_ping_at: string | null; protected: boolean | null;
  catch_free: boolean | null; briefing_done: boolean;
}
export interface Position { participant_id: string; lat: number; lng: number; accuracy_m: number | null; speed_mps: number | null; heading: number | null; at: string; live: boolean }
export interface Ping {
  id: string; participant_id: string; at: string; lat: number | null; lng: number | null; accuracy_m: number | null;
  source: string; n: number | null; speedhunt_id: string | null; zone_kind: string | null; label: string | null;
  stale_seconds: number | null; is_fake: boolean | null; truth: { lat: number; lng: number } | null;
}
export interface Speedhunt {
  id: string; status: string; is_penalty: boolean; target_id: string | null; queries_total: number; queries_used: number;
  started_at: string | null; deadline_at: string | null; last_query_at: string | null; ended_at: string | null; end_reason: string | null;
}
export interface Catch { id: string; runner_id: string; hunter_id: string | null; at: string; method: string; status: string; expires_at: string | null; distance_m: number | null; reason: string | null }
export interface Violation {
  id: string; participant_id: string; type: string; at: string; evidence: Record<string, unknown>; proposed_penalty: string;
  decided_penalty: string | null; status: string; auto_apply_at: string | null; explanation: string | null; detected_by: string;
}
export interface Challenge {
  id: string; title: string; description: string; template: string; lat: number | null; lng: number | null; radius_m: number | null;
  starts_at: string; ends_at: string; announce_at: string | null; proof_type: string; secret_code: string | null;
  reward_type: string; reward_value: number | null; status: string; max_participants: number | null;
  entries: { id: string; participant_id: string; result: string; proof_path: string | null; proof_text: string | null }[];
}
export interface Notification { id: number; kind: string; title: string; body: string; payload: Record<string, unknown>; priority: 'normal' | 'hoch' | 'kritisch'; at: string }

export interface GameState {
  now: string;
  server_now: string;
  game: {
    id: string; name: string; code: string; status: string; is_test: boolean; host: boolean; start_at: string | null;
    hunt_start_at: string | null; ends_at: string | null; deadline_at: string | null; next_day_at: string | null;
    current_day: number; paused: boolean; pause_reason: string | null; timezone: string; speedhunts_left: number;
    exit_revealed: boolean; exit_reveal_at: string | null; map_version: number;
    result: { reason: string; winners: string[]; mode: string; scores: Record<string, number>; hours: number; catches: number; pings: number; speedhunts: number } | null;
    meeting_point: string | null; config: GameConfig; group_id: string | null; quiet: boolean;
  };
  me: {
    id: string; role: Role; state: string; budget: number; bounty: number; next_ping_at: string | null;
    location_requested: boolean; hideout_prompt: boolean; transport_prompt: boolean; out_accum_s: number; out_pending: boolean;
    in_restricted: boolean; briefing_done: boolean; live: boolean; effects: Effect[]; inventory: Item[];
    hideout: { id: string; inside: boolean; accum_s: number; entered_at: string; max_s: number; lat: number; lng: number } | null;
    transit: { id: string; mode: string; line: string | null; started_at: string } | null;
    device_check: Record<string, unknown>;
  };
  participants: Participant[];
  positions: Position[];
  pings: Ping[];
  speedhunts: Speedhunt[];
  catches: Catch[];
  violations: Violation[];
  challenges: Challenge[];
  emergencies: { id: string; participant_id: string; at: string; lat: number | null; lng: number | null; status: string }[];
  transits: { participant_id: string; mode: string; line: string | null; from: string | null; to: string | null; started_at: string }[];
  hideouts: { participant_id: string; inside: boolean; accum_s: number; lat: number; lng: number }[];
  purchases: { participant_id: string; amount: number; category: string; note: string | null; at: string }[];
  notifications: Notification[];
  next_silent_ping_at: string | null;
  free_players: number;
}

export interface MapFeature {
  type: 'Feature';
  id?: string;
  geometry: GeoJSON.Geometry;
  properties: ZoneProps;
}
export interface ZoneProps {
  id?: string;
  kind: ZoneKind;
  name?: string;
  color?: string | null;
  radius_m?: number | null;
  day_index?: number | null;
  grows?: boolean;
  ping_interval_override?: number | null;
  crossing_allowed?: boolean;
  restricted_type?: string | null;
  owner_participant_id?: string | null;
  released?: boolean;
  visible_from?: string | null;
}

export const ZONE_KINDS = ['spielfeld', 'sektion', 'startzone', 'center', 'kern', 'aussen', 'sperrzone', 'sicher', 'exit', 'hq', 'treffpunkt'] as const;
export type ZoneKind = (typeof ZONE_KINDS)[number];

export const ZONE_INFO: Record<ZoneKind, { label: string; color: string; point: boolean; help: string }> = {
  spielfeld: { label: 'Spielfeld', color: '#3fb950', point: false, help: 'Wo gespielt wird. Optional pro Spieltag.' },
  sektion: { label: 'Sektion', color: '#58a6ff', point: false, help: 'Eigenes Gebiet pro Spieler (Wien-Modus).' },
  startzone: { label: 'Startzone', color: '#a371f7', point: false, help: 'Gemeinsamer Bereich in Sektions-Spielen.' },
  center: { label: 'Center', color: '#d29922', point: false, help: 'Eigene Ping-Regeln, z. B. kein Fahrzeug (Bangkok).' },
  kern: { label: 'Kernzone', color: '#db6d28', point: false, help: 'Häufigere Pings.' },
  aussen: { label: 'Aussenzone', color: '#8b949e', point: false, help: 'Eigenes Ping-Intervall.' },
  sperrzone: { label: 'Sperrzone', color: '#f85149', point: false, help: 'Betreten verboten (z. B. Bahnhof, Schule).' },
  sicher: { label: 'Sichere Zone', color: '#2ea043', point: false, help: 'Hier darf nicht gefangen werden.' },
  exit: { label: 'Exit-Kandidat', color: '#f0f6fc', point: true, help: 'Einer davon wird zufällig der Exitpoint.' },
  hq: { label: 'HQ', color: '#f85149', point: true, help: 'Startort der Hunter.' },
  treffpunkt: { label: 'Treffpunkt', color: '#58a6ff', point: true, help: 'Treffpunkt vor dem Start.' },
};

async function rpc<T = unknown>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await db().rpc(fn, args);
  if (error) throw error;
  return data as T;
}

export const api = {
  state: (g: string) => rpc<GameState>('game_state', { p_game_id: g }),
  map: (g: string) => rpc<MapFeature[]>('game_map', { p_game_id: g }),
  saveMap: (g: string, features: MapFeature[]) => rpc<number>('save_map', { p_game_id: g, p_features: features }),
  start: (g: string, test: boolean) => rpc('start_game', { p_game_id: g, p_test: test }),
  advance: (g: string, minutes: number) => rpc<string>('advance_time', { p_game_id: g, p_minutes: minutes }),
  tick: (g: string) => rpc('game_tick', { p_game_id: g }),
  report: (g: string, samples: unknown[]) => rpc<{ ok?: boolean; stop?: boolean; request_now?: boolean; interval_s?: number }>('report_location', { p_game_id: g, p_samples: samples }),
  deviceCheck: (g: string, checks: Record<string, unknown>) => rpc('set_device_check', { p_game_id: g, p_checks: checks }),
  speedhuntStart: (g: string, target: string) => rpc<string>('speedhunt_start', { p_game_id: g, p_target: target }),
  speedhuntQuery: (sh: string) => rpc('speedhunt_query', { p_speedhunt_id: sh }),
  speedhuntApprove: (sh: string, ok: boolean) => rpc('speedhunt_approve', { p_speedhunt_id: sh, p_approve: ok }),
  catchCode: (g: string) => rpc<{ code: string; valid_s: number; qr: string }>('my_catch_code', { p_game_id: g }),
  catchByCode: (g: string, code: string, lat?: number, lng?: number) =>
    rpc<{ catch_id: string; status: string; runner: string }>('catch_by_code', { p_game_id: g, p_code: code, p_lat: lat ?? null, p_lng: lng ?? null }),
  catchClaim: (g: string, runner: string, lat?: number, lng?: number) =>
    rpc<{ catch_id: string; status: string; runner: string }>('catch_claim', { p_game_id: g, p_runner: runner, p_lat: lat ?? null, p_lng: lng ?? null }),
  catchRespond: (c: string, accept: boolean) => rpc('catch_respond', { p_catch_id: c, p_accept: accept }),
  catchMedia: (c: string, path: string) => rpc('catch_attach_media', { p_catch_id: c, p_path: path }),
  catchDecide: (c: string, valid: boolean) => rpc('gm_catch_decide', { p_catch_id: c, p_valid: valid }),
  confirmExit: (g: string, participant?: string) => rpc('confirm_exit', { p_game_id: g, p_participant: participant ?? null }),
  giveUp: (g: string) => rpc('give_up', { p_game_id: g }),
  hideout: (g: string, inside: boolean) => rpc('hideout_report', { p_game_id: g, p_inside: inside }),
  transitIn: (g: string, mode: string, line: string, from: string, to: string) =>
    rpc('transit_checkin', { p_game_id: g, p_mode: mode, p_line: line, p_from: from, p_to: to }),
  transitOut: (g: string, stops: number | null) => rpc<{ live_after_minutes: number }>('transit_checkout', { p_game_id: g, p_stops: stops }),
  purchase: (g: string, amount: number, category: string, note: string, receipt: string | null) =>
    rpc<{ balance: number }>('make_purchase', { p_game_id: g, p_amount: amount, p_category: category, p_note: note, p_receipt: receipt }),
  useItem: (item: string, payload: Record<string, unknown> = {}) => rpc('use_item', { p_item_id: item, p_payload: payload }),
  grantItem: (g: string, p: string, kind: string, type: string, minutes: number | null) =>
    rpc('gm_grant_item', { p_game_id: g, p_participant: p, p_kind: kind, p_type: type, p_minutes: minutes }),
  challengeCreate: (g: string, data: Record<string, unknown>) => rpc('challenge_create', { p_game_id: g, p_data: data }),
  challengeCancel: (c: string) => rpc('challenge_cancel', { p_challenge_id: c }),
  challengeJoin: (c: string) => rpc('challenge_join', { p_challenge_id: c }),
  challengeSubmit: (c: string, code: string | null, path: string | null) => rpc<string>('challenge_submit', { p_challenge_id: c, p_code: code, p_proof_path: path }),
  challengeDecide: (e: string, ok: boolean) => rpc('challenge_decide', { p_entry_id: e, p_success: ok }),
  pause: (g: string, reason: string) => rpc('pause_game', { p_game_id: g, p_reason: reason }),
  resume: (g: string) => rpc('resume_game', { p_game_id: g }),
  emergency: (g: string, lat?: number, lng?: number) => rpc('emergency_start', { p_game_id: g, p_lat: lat ?? null, p_lng: lng ?? null }),
  emergencyResolve: (e: string) => rpc('emergency_resolve', { p_emergency_id: e }),
  emergencyContact: (g: string, p: string) => rpc<{ name: string; phone: string } | null>('emergency_contact', { p_game_id: g, p_participant: p }),
  explain: (v: string, text: string) => rpc('violation_explain', { p_violation_id: v, p_text: text }),
  decide: (v: string, penalty: string | null) => rpc('violation_decide', { p_violation_id: v, p_penalty: penalty }),
  report_violation: (g: string, p: string, type: string, note: string) => rpc('violation_report', { p_game_id: g, p_participant: p, p_type: type, p_note: note }),
  gmPing: (g: string, p: string) => rpc('gm_ping', { p_game_id: g, p_participant: p }),
  gmZone: (g: string, feature: MapFeature) => rpc('gm_add_zone', { p_game_id: g, p_feature: feature }),
  gmState: (p: string, state: string) => rpc('gm_set_state', { p_participant: p, p_state: state }),
  endGame: (g: string) => rpc('gm_end_game', { p_game_id: g }),
  gmConfig: (g: string, config: GameConfig, changes: unknown[]) => rpc('gm_update_config', { p_game_id: g, p_config: config, p_changes: changes }),
  briefing: (g: string) => rpc('briefing_confirm', { p_game_id: g }),
  send: (g: string, channel: string, body: string) => rpc('send_message', { p_game_id: g, p_channel: channel, p_body: body }),
  replay: (g: string) => rpc<Replay>('game_replay', { p_game_id: g }),
};

export interface Replay {
  start: string;
  end: string;
  tracks: Record<string, [number, number, number][]>;
  pings: { participant_id: string; at: string; lat: number; lng: number; source: string; is_fake: boolean }[];
  catches: { runner_id: string; hunter_id: string; at: string; lat: number | null; lng: number | null }[];
  events: { at: string; type: string; payload: Record<string, unknown> }[];
}

// Beweisfoto hochladen: Pfad <game>/<user>/<datei> (Storage-Policy in 0003).
export async function uploadProof(gameId: string, file: Blob, name: string) {
  const { data: u } = await db().auth.getUser();
  const path = `${gameId}/${u.user?.id}/${Date.now()}-${name.replace(/[^a-z0-9._-]/gi, '_')}`;
  const { error } = await db().storage.from('beweise').upload(path, file, { upsert: false });
  if (error) throw error;
  return path;
}

export const STATE_LABELS: Record<string, string> = {
  aktiv: 'Aktiv', ausserhalb: 'Ausserhalb', gefangen: 'Gefangen', disqualifiziert: 'Disqualifiziert', aufgegeben: 'Aufgegeben',
  im_ziel: 'Am Exit', verloren: 'Verloren', notfall: 'Notfall', pausiert: 'Pausiert',
};

export const SOURCE_LABELS: Record<string, string> = {
  silent: 'Silent-Ping', speedhunt: 'Speedhunt', purchase: 'Kauf', transit: 'ÖV', proximity: 'Teambildung', fake: 'Fake',
  hotel_end: 'Hotel', out_of_bounds: 'Ausserhalb', penalty: 'Strafe', gm: 'Spielleitung', kein_signal: 'Kein Signal',
  challenge: 'Challenge', device_switch: 'Gerätewechsel',
};

export const PENALTY_LABELS: Record<string, string> = {
  verwarnung: 'Verwarnung', straf_speedhunt: 'Straf-Speedhunt', disqualifikation: 'Disqualifikation', catch: 'Als gefangen werten',
  live_standort: '15 min live', sofort_ping: 'Sofort-Ping',
};

export const ITEM_LABELS: Record<string, string> = {
  regeneration: 'Regeneration', hunter_erfragen: 'Hunter erfragen', catch_free: 'Catch-Free', fake_ping: 'Fake-Ping',
  hotel: 'Hotel', budget: 'Budget', wahl: 'Joker nach Wahl',
};

export const TRANSPORT_LABELS: Record<string, string> = {
  zu_fuss: 'Zu Fuss', oev_bus: 'Bus', oev_bahn: 'Bahn', oev_tram: 'Tram', faehre: 'Fähre', taxi: 'Taxi', fahrrad: 'Fahrrad',
  scooter: 'Scooter', eigenes_fahrzeug: 'Eigenes Fahrzeug',
};

export function clock(iso: string | null | undefined, tz?: string) {
  if (!iso) return '–';
  return new Date(iso).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit', timeZone: tz });
}

export function countdown(targetIso: string | null | undefined, nowMs: number) {
  if (!targetIso) return '–';
  let s = Math.max(0, Math.round((new Date(targetIso).getTime() - nowMs) / 1000));
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function distanceM(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
