import type { Session } from '@supabase/supabase-js';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { supabase } from './supabase';

export interface Profile {
  user_id: string;
  username: string;
  display_name: string;
  age_confirmed: boolean;
  is_adult: boolean;
}

interface AuthState {
  loading: boolean;
  session: Session | null;
  profile: Profile | null;
  hasEmergencyContact: boolean;
  recovering: boolean;
  refresh: () => Promise<void>;
  clearRecovering: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [hasEmergencyContact, setHasEmergencyContact] = useState(false);
  const [recovering, setRecovering] = useState(false);

  const loadProfile = useCallback(async (s: Session | null) => {
    if (!supabase || !s) {
      setProfile(null);
      setHasEmergencyContact(false);
      return;
    }
    const [p, e] = await Promise.all([
      supabase.from('profiles').select('*').eq('user_id', s.user.id).maybeSingle(),
      supabase.from('profile_private').select('user_id').eq('user_id', s.user.id).maybeSingle(),
    ]);
    setProfile((p.data as Profile | null) ?? null);
    setHasEmergencyContact(!!e.data);
  }, []);

  useEffect(() => {
    if (!supabase) {
      setLoading(false);
      return;
    }
    supabase.auth.getSession().then(async ({ data }) => {
      setSession(data.session);
      await loadProfile(data.session);
      setLoading(false);
    });
    const { data } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s);
      if (event === 'PASSWORD_RECOVERY') setRecovering(true);
      // Nicht direkt im Callback auf Supabase warten (Deadlock-Gefahr).
      setTimeout(() => void loadProfile(s), 0);
    });
    return () => data.subscription.unsubscribe();
  }, [loadProfile]);

  const refresh = useCallback(() => loadProfile(session), [loadProfile, session]);

  return (
    <AuthContext.Provider
      value={{ loading, session, profile, hasEmergencyContact, recovering, refresh, clearRecovering: () => setRecovering(false) }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth ausserhalb von AuthProvider');
  return ctx;
}
