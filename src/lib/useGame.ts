import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type GameState, type Notification } from './engine';
import { db, errorText } from './supabase';

// Lädt game_state() und hält ihn aktuell: Realtime auf game_ticks (Änderungszähler),
// dazu ein Client-Tick alle 15 s, falls pg_cron fehlt oder die Verbindung hängt.
export function useGameState(gameId: string | undefined, onNew?: (n: Notification[]) => void) {
  const [state, setState] = useState<GameState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [offsetMs, setOffsetMs] = useState(0);
  const lastNote = useRef<number | null>(null);
  const inflight = useRef(false);
  const again = useRef(false);
  const onNewRef = useRef(onNew);
  onNewRef.current = onNew;

  const load = useCallback(async () => {
    if (!gameId) return;
    if (inflight.current) {
      again.current = true;
      return;
    }
    inflight.current = true;
    try {
      const t0 = Date.now();
      const s = await api.state(gameId);
      const t1 = Date.now();
      // Spielzeit (inkl. Probelauf-Vorlauf) relativ zur Gerätezeit.
      setOffsetMs(new Date(s.now).getTime() - (t0 + t1) / 2);
      setState(s);
      setError(null);
      const maxId = s.notifications[0]?.id ?? 0;
      if (lastNote.current !== null && maxId > lastNote.current) {
        const fresh = s.notifications.filter((n) => n.id > (lastNote.current ?? 0)).reverse();
        onNewRef.current?.(fresh);
      }
      lastNote.current = Math.max(lastNote.current ?? 0, maxId);
    } catch (err) {
      setError(errorText(err));
    } finally {
      inflight.current = false;
      if (again.current) {
        again.current = false;
        setTimeout(() => void load(), 300);
      }
    }
  }, [gameId]);

  useEffect(() => {
    if (!gameId) return;
    void load();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const throttled = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        void load();
      }, 800);
    };
    const channel = db()
      .channel(`game:${gameId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_ticks', filter: `game_id=eq.${gameId}` }, throttled)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications', filter: `game_id=eq.${gameId}` }, throttled)
      .subscribe();
    const tick = setInterval(() => {
      if (document.visibilityState === 'visible') void api.tick(gameId).then(load, () => undefined);
    }, 15000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(tick);
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
      void db().removeChannel(channel);
    };
  }, [gameId, load]);

  return { state, error, reload: load, offsetMs };
}

// Laufende Uhr in Spielzeit.
export function useNow(offsetMs: number, everyMs = 1000) {
  const [now, setNow] = useState(() => Date.now() + offsetMs);
  useEffect(() => {
    setNow(Date.now() + offsetMs);
    const t = setInterval(() => setNow(Date.now() + offsetMs), everyMs);
    return () => clearInterval(t);
  }, [offsetMs, everyMs]);
  return now;
}
