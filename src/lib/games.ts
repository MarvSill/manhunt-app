import type { GameConfig } from '../shared/config';
import { db } from './supabase';

export type Role = 'offen' | 'spieler' | 'hunter' | 'zentrale' | 'gm' | 'zuschauer';

export const ROLE_LABELS: Record<Role, string> = {
  offen: 'Noch offen',
  spieler: 'Spieler',
  hunter: 'Hunter',
  zentrale: 'Einsatzzentrale',
  gm: 'Spielleitung',
  zuschauer: 'Zuschauer',
};

export const STATUS_LABELS: Record<string, string> = {
  entwurf: 'Entwurf',
  geplant: 'Geplant',
  lobby: 'Lobby',
  vorsprung: 'Vorsprung',
  laeuft: 'Läuft',
  pausiert: 'Pausiert',
  finale: 'Finale',
  beendet: 'Beendet',
  archiviert: 'Archiviert',
};

export interface Game {
  id: string;
  code: string;
  host_id: string;
  name: string;
  preset_id: string | null;
  status: string;
  config_json: unknown;
  start_at: string | null;
  meeting_point: string | null;
  timezone: string;
  created_at: string;
}

export interface RosterEntry {
  participant_id: string;
  user_id: string;
  username: string;
  display_name: string;
  role: Role;
  wished_role: Role | null;
  ready: boolean;
  is_adult: boolean;
  joined_at: string;
}

export interface ConfigChange {
  path: string;
  old: unknown;
  new: unknown;
}

export async function createGame(name: string, presetId: string, config: GameConfig, startAt: string | null) {
  const { data, error } = await db().rpc('create_game', {
    p_name: name,
    p_preset_id: presetId,
    p_config: config,
    p_start_at: startAt,
  });
  if (error) throw error;
  return data as Game;
}

export async function joinGame(code: string) {
  const { data, error } = await db().rpc('join_game', { p_code: code });
  if (error) throw error;
  return data as Game;
}

export async function myGames() {
  const { data, error } = await db().from('games').select('*').order('created_at', { ascending: false });
  if (error) throw error;
  return data as Game[];
}

export async function getGame(id: string) {
  const { data, error } = await db().from('games').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data as Game | null;
}

export async function getRoster(gameId: string) {
  const { data, error } = await db().rpc('game_roster', { p_game_id: gameId });
  if (error) throw error;
  return data as RosterEntry[];
}

export async function setRole(participantId: string, role: Role) {
  const { error } = await db().rpc('set_participant_role', { p_participant_id: participantId, p_role: role });
  if (error) throw error;
}

export async function removeParticipant(participantId: string) {
  const { error } = await db().rpc('remove_participant', { p_participant_id: participantId });
  if (error) throw error;
}

export async function setReady(gameId: string, ready: boolean, wishedRole: Role | null) {
  const { error } = await db().rpc('set_ready', { p_game_id: gameId, p_ready: ready, p_wished_role: wishedRole });
  if (error) throw error;
}

export async function updateConfig(gameId: string, config: GameConfig, changes: ConfigChange[]) {
  const { error } = await db().rpc('update_game_config', { p_game_id: gameId, p_config: config, p_changes: changes });
  if (error) throw error;
}

/** Liste der geänderten Parameter (für das Änderungsprotokoll). */
export function diffConfig(before: GameConfig, after: GameConfig): ConfigChange[] {
  const changes: ConfigChange[] = [];
  for (const section of Object.keys(after) as (keyof GameConfig)[]) {
    const a = before[section] as Record<string, unknown>;
    const b = after[section] as Record<string, unknown>;
    for (const key of Object.keys(b)) {
      if (JSON.stringify(a?.[key]) !== JSON.stringify(b[key])) {
        changes.push({ path: `${section}.${key}`, old: a?.[key] ?? null, new: b[key] });
      }
    }
  }
  return changes;
}
