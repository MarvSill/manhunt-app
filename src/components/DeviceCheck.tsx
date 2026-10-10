import { useState } from 'react';
import { api } from '../lib/engine';
import { errorText } from '../lib/supabase';

interface Result { gps: boolean; accuracy: number | null; battery: number | null; notifications: string; wakeLock: boolean; camera: boolean; clock_ms: number | null }

// Gerätecheck vor dem Start (6.2): GPS-Fix, Akku, Benachrichtigungen, Bildschirm-wach, Kamera.
export default function DeviceCheck({ gameId, minBattery }: { gameId: string; minBattery: number }) {
  const [res, setRes] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setErr(null);
    const r: Result = { gps: false, accuracy: null, battery: null, notifications: 'nicht unterstützt', wakeLock: false, camera: false, clock_ms: null };
    try {
      const p = await new Promise<GeolocationPosition>((ok, fail) =>
        navigator.geolocation.getCurrentPosition(ok, fail, { enableHighAccuracy: true, timeout: 20000 }));
      r.gps = true;
      r.accuracy = Math.round(p.coords.accuracy);
      // Erster Standort gleich an den Server (Lobby-Position)
      await api.report(gameId, [{ lat: p.coords.latitude, lng: p.coords.longitude, acc: r.accuracy, age_s: 0 }]).catch(() => undefined);
    } catch {
      r.gps = false;
    }
    try {
      const b = await (navigator as Navigator & { getBattery?: () => Promise<{ level: number }> }).getBattery?.();
      if (b) r.battery = Math.round(b.level * 100);
    } catch {
      // kein Akku-Wert
    }
    if (typeof Notification !== 'undefined') {
      r.notifications = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
    }
    r.wakeLock = 'wakeLock' in navigator;
    r.camera = !!navigator.mediaDevices?.getUserMedia;
    try {
      const t0 = Date.now();
      const s = await api.state(gameId);
      r.clock_ms = Math.round(new Date(s.server_now).getTime() - (t0 + Date.now()) / 2);
    } catch {
      // ohne Uhrvergleich
    }
    setRes(r);
    try {
      await api.deviceCheck(gameId, { ...r, ok: r.gps && (r.battery == null || r.battery >= minBattery) });
    } catch (e) {
      setErr(errorText(e));
    }
    setBusy(false);
  }

  const ok = (b: boolean) => (b ? '✓' : '✗');
  return (
    <div className="card stack">
      <h2 style={{ margin: 0 }}>Gerätecheck</h2>
      {res && (
        <ul className="list small">
          <li>{ok(res.gps)} Standort {res.gps ? `(±${res.accuracy} m)` : 'nicht erlaubt: bitte im Browser freigeben'}</li>
          <li>{ok(res.battery == null || res.battery >= minBattery)} Akku {res.battery != null ? `${res.battery} %` : 'unbekannt'}{res.battery != null && res.battery < minBattery && ` (mind. ${minBattery} % nötig)`}</li>
          <li>{ok(res.notifications === 'granted')} Benachrichtigungen: {res.notifications === 'granted' ? 'erlaubt' : res.notifications === 'denied' ? 'blockiert' : res.notifications}</li>
          <li>{ok(res.wakeLock)} Bildschirm bleibt an</li>
          <li>{ok(res.camera)} Kamera für QR-Fang</li>
          {res.clock_ms != null && <li>{ok(Math.abs(res.clock_ms) < 30000)} Uhr {Math.abs(res.clock_ms) < 30000 ? 'stimmt' : `weicht ${Math.round(res.clock_ms / 1000)} s ab`}</li>}
        </ul>
      )}
      {err && <div className="notice error">{err}</div>}
      <button onClick={run} disabled={busy}>{busy ? 'Prüfe …' : res ? 'Nochmals prüfen' : 'Gerät prüfen'}</button>
      <div className="muted small">Tipp: Während des Spiels die App offen lassen. Der Browser sendet den Standort nur, solange die App sichtbar ist.</div>
    </div>
  );
}
