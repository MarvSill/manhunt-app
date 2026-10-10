import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/** null, solange die Supabase-Zugangsdaten fehlen (siehe README). */
export const supabase: SupabaseClient | null =
  url && key ? createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true } }) : null;

export function db(): SupabaseClient {
  if (!supabase) throw new Error('Supabase ist nicht konfiguriert.');
  return supabase;
}

/** Fehlermeldungen von Supabase in verständliches Deutsch. */
export function errorText(error: unknown): string {
  const e = error as { message?: string; code?: string } | null;
  const msg = e?.message ?? String(error);
  if (e?.code === '23505' && msg.includes('username')) return 'Dieser Benutzername ist schon vergeben.';
  if (msg.includes('Invalid login credentials')) return 'E-Mail oder Passwort ist falsch.';
  if (msg.includes('Email not confirmed')) return 'Bitte bestätige zuerst deine E-Mail-Adresse (Link im Postfach).';
  if (msg.includes('User already registered')) return 'Mit dieser E-Mail gibt es schon ein Konto.';
  if (msg.includes('rate limit')) return 'Zu viele Versuche. Bitte warte kurz und versuche es nochmals.';
  if (msg.includes('Password should be')) return 'Das Passwort ist zu schwach.';
  return msg;
}
