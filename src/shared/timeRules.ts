/**
 * Zeitlogik: keine Zeitangabe darf einer anderen widersprechen.
 * Alles, was während der Jagd passiert (Verkleinerung, Pings, Speedhunts,
 * Meldungen …), muss in die Spieldauer bzw. in einen Spieltag passen.
 *
 * `timeLimits` liefert die erlaubten Höchstwerte (für Eingabefelder),
 * `fitTimes` passt eine Konfiguration daran an und sagt, was geändert wurde.
 */
import type { GameConfig } from './config';

export interface TimeFix {
  path: string;
  from: number;
  to: number;
  message: string;
}

export interface TimeLimit {
  max: number;
  min?: number;
  reason: string;
}

/** Spieldauer als Text, z. B. "90 min" oder "3 h" oder "2 Tage". */
export function durationText(min: number): string {
  if (min < 120) return `${min} min`;
  if (min < 2880) return min % 60 === 0 ? `${min / 60} h` : `${Math.floor(min / 60)} h ${min % 60} min`;
  return min % 1440 === 0 ? `${min / 1440} Tage` : `${Math.round(min / 60)} h`;
}

/** Länge eines Spieltags, wie sie tatsächlich gilt. */
export function effectiveDayLength(c: GameConfig): number {
  const d = c.game.duration_minutes;
  if (c.game.days <= 1) return Math.min(1440, d);
  return Math.min(c.game.day_length_minutes, Math.floor(d / c.game.days));
}

/** Dauer einer Verkleinerungs-Phase (0 = es wird nie kleiner). */
export function phaseLength(c: GameConfig): number {
  if (c.zone.shrink_mode === 'aus') return 0;
  if (c.zone.shrink_every_minutes > 0) return c.zone.shrink_every_minutes;
  return c.game.days > 1 ? effectiveDayLength(c) : 0;
}

const LABELS: Record<string, string> = {
  'game.days': 'Spieltage',
  'game.day_length_minutes': 'Länge eines Spieltags',
  'zone.shrink_every_minutes': 'Verkleinerung alle',
  'zone.shrink_announce_minutes': 'Ankündigung der Verkleinerung',
  'zone.shrink_grace_minutes': 'Zeit zum Rauslaufen',
  'ping.interval_minutes': 'Ping-Intervall',
  'ping.first_ping_delay_minutes': 'Erster Ping nach',
  'ping.offset_minutes': 'Ping-Versatz',
  'ping.jitter_minutes': 'Ping-Zufallsversatz',
  'speedhunt.max_duration_minutes': 'Speedhunt-Dauer',
  'speedhunt.query_min_gap_minutes': 'Abstand der Speedhunt-Abfragen',
  'speedhunt.min_minutes_after_silent_ping': 'Speedhunt-Abstand zum Ping',
  'leo.duration_minutes': 'LEO-Dauer',
  'out_of_bounds.max_minutes': 'Limit ausserhalb',
  'hideout.max_minutes': 'Verschanzen-Limit',
  'hideout.stationary_minutes': 'Verschanzen-Erkennung',
  'hideout.lockout_after_first_entry_minutes': 'Ort gesperrt nach',
  'transport.live_after_base_minutes': 'Live-Nachlauf nach Fahrt',
  'budget.ping_delay_minutes': 'Verzögerung Kauf-Ping',
  'bonus.hotel_minutes': 'Hotel-Dauer',
  'challenge.announce_before_minutes': 'Challenge-Ankündigung',
  'challenge.suspend_proximity_before_minutes': 'Teambildungsregel aus (vorher)',
  'challenge.suspend_proximity_after_minutes': 'Teambildungsregel aus (nachher)',
  'proximity.active_after_minutes': 'Teambildungs-Alarm aktiv ab',
  'exit.reveal_minutes_before_end': 'Exit-Bekanntgabe vor Ende',
  'spectator.delay_minutes': 'Zuschauer-Verzögerung',
  'joker.available_after_minutes': 'Joker verfügbar ab',
  'documentation.required_minutes_per_day': 'Filmpflicht pro Tag',
};

function get(c: GameConfig, path: string): number {
  const [s, k] = path.split('.');
  return (c as unknown as Record<string, Record<string, number>>)[s][k];
}

function set(c: GameConfig, path: string, v: number) {
  const [s, k] = path.split('.');
  (c as unknown as Record<string, Record<string, number>>)[s][k] = v;
}

/** Höchstwerte, die sich aus den anderen Zeiten ergeben. */
export function timeLimits(c: GameConfig): Record<string, TimeLimit> {
  const d = c.game.duration_minutes;
  const day = effectiveDayLength(c);
  const game = `das Spiel nur ${durationText(d)} dauert`;
  const dayR = c.game.days > 1 ? `ein Spieltag nur ${durationText(day)} dauert` : game;
  const out: Record<string, TimeLimit> = {
    'game.days': { max: Math.max(1, Math.floor(d / 10)), reason: `ein Spieltag mindestens 10 min braucht und ${game}` },
    'game.day_length_minutes': {
      max: c.game.days > 1 ? Math.max(10, Math.floor(d / c.game.days)) : Math.min(1440, d),
      reason: c.game.days > 1 ? `${c.game.days} Spieltage in ${durationText(d)} passen müssen` : game,
    },
    'ping.interval_minutes': { max: Math.max(1, d - 1 - Math.min(c.ping.first_ping_delay_minutes, d - 2)), reason: `sonst kein Ping kommt und ${game}` },
    'ping.first_ping_delay_minutes': { max: Math.max(0, d - 2), reason: game },
    'ping.offset_minutes': { max: Math.max(0, c.ping.interval_minutes - 1), reason: `der Ping alle ${c.ping.interval_minutes} min kommt` },
    'ping.jitter_minutes': { max: Math.floor(c.ping.interval_minutes / 2), reason: `der Ping alle ${c.ping.interval_minutes} min kommt` },
    'leo.duration_minutes': { max: d, reason: game },
    'out_of_bounds.max_minutes': { max: d, reason: game },
    'hideout.max_minutes': { max: Math.max(5, d), reason: game },
    'hideout.stationary_minutes': { max: Math.max(5, c.hideout.max_minutes), reason: `das Verschanzen-Limit nur ${c.hideout.max_minutes} min ist` },
    'hideout.lockout_after_first_entry_minutes': { max: d, reason: game },
    'transport.live_after_base_minutes': { max: d, reason: game },
    'budget.ping_delay_minutes': { max: d, reason: game },
    'bonus.hotel_minutes': { max: Math.max(10, day), reason: dayR },
    'challenge.announce_before_minutes': { max: day, reason: dayR },
    'challenge.suspend_proximity_before_minutes': { max: day, reason: dayR },
    'challenge.suspend_proximity_after_minutes': { max: day, reason: dayR },
    'proximity.active_after_minutes': { max: Math.max(0, d - 5), reason: `der Alarm sonst nie aktiv wäre` },
    'exit.reveal_minutes_before_end': { max: d, reason: game },
    'spectator.delay_minutes': { max: Math.max(0, d - 5), reason: `Zuschauer sonst nichts sähen` },
    'joker.available_after_minutes': { max: Math.max(0, d - 5), reason: `es sonst nie Joker gäbe` },
    'documentation.required_minutes_per_day': { max: day, reason: dayR },
  };
  // Nur Regeln prüfen, die im Spiel auch aktiv sind.
  const off: [boolean, string][] = [
    [c.leo.enabled, 'leo.'], [c.hideout.enabled, 'hideout.'], [c.budget.enabled, 'budget.'], [c.bonus.enabled, 'bonus.'],
    [c.challenge.enabled, 'challenge.'], [c.proximity.enabled, 'proximity.'], [c.exit.enabled, 'exit.'],
    [c.spectator.enabled, 'spectator.'], [c.joker.enabled, 'joker.'],
  ];
  for (const [on, prefix] of off) if (!on) for (const k of Object.keys(out)) if (k.startsWith(prefix)) delete out[k];
  if (c.speedhunt.enabled) {
    const sd = Math.max(5, Math.min(d, day));
    out['speedhunt.max_duration_minutes'] = { max: sd, reason: dayR };
    const gaps = Math.max(1, c.speedhunt.queries - 1);
    out['speedhunt.query_min_gap_minutes'] = {
      max: Math.floor(Math.min(c.speedhunt.max_duration_minutes, sd) / gaps),
      reason: `${c.speedhunt.queries} Abfragen in ${Math.min(c.speedhunt.max_duration_minutes, sd)} min passen müssen`,
    };
    out['speedhunt.min_minutes_after_silent_ping'] = { max: Math.max(0, c.ping.interval_minutes - 1), reason: `der Ping alle ${c.ping.interval_minutes} min kommt` };
  }
  if (c.zone.shrink_mode !== 'aus') {
    if (c.zone.shrink_every_minutes > 0) {
      out['zone.shrink_every_minutes'] = { min: 5, max: Math.max(5, Math.floor(d / 2)), reason: `das Spielfeld in ${durationText(d)} mindestens einmal kleiner werden soll` };
    }
    const ph = phaseLength(c) || d;
    out['zone.shrink_announce_minutes'] = { max: ph, reason: `eine Phase nur ${durationText(ph)} dauert` };
    out['zone.shrink_grace_minutes'] = { max: Math.min(120, ph), reason: `eine Phase nur ${durationText(ph)} dauert` };
  }
  return out;
}

/** Passt alle Zeiten an, damit nichts ausserhalb der Spieldauer liegt. */
export function fitTimes(input: GameConfig): { config: GameConfig; fixes: TimeFix[] } {
  const c = structuredClone(input);
  const fixes: TimeFix[] = [];
  const d = c.game.duration_minutes;

  // Bei nur einem Spieltag gibt es keinen "nächsten Tag": dann alle X Minuten verkleinern.
  if (c.zone.shrink_mode !== 'aus' && c.zone.shrink_every_minutes === 0 && c.game.days <= 1) {
    const every = Math.max(5, Math.round(d / 4 / 5) * 5);
    c.zone.shrink_every_minutes = every;
    fixes.push({
      path: 'zone.shrink_every_minutes', from: 0, to: every,
      message: `Bei nur einem Spieltag wird das Spielfeld alle ${every} min kleiner (statt pro Spieltag), damit es in ${durationText(d)} passt.`,
    });
  }

  // Zuerst Spieltage, dann alles, was davon abhängt. Zwei Runden, weil Grenzen voneinander abhängen.
  for (let round = 0; round < 3; round++) {
    const limits = timeLimits(c);
    let changed = false;
    for (const [path, lim] of Object.entries(limits)) {
      const v = get(c, path);
      let to = v;
      if (v > lim.max) to = lim.max;
      if (lim.min !== undefined && v < lim.min && v !== 0) to = lim.min;
      if (to === v) continue;
      set(c, path, to);
      changed = true;
      const prev = fixes.find((f) => f.path === path);
      const message = `${LABELS[path] ?? path}: ${to} statt ${prev?.from ?? v}${path === 'game.days' ? '' : ' min'}, weil ${lim.reason}.`;
      if (prev) Object.assign(prev, { to, message });
      else fixes.push({ path, from: v, to, message });
    }
    if (!changed) break;
  }

  // Ping-Intervalle je Zone und Joker-/Effektdauern
  for (const [zone, min] of Object.entries(c.ping.zone_overrides)) {
    if (min > d) {
      c.ping.zone_overrides[zone] = d;
      fixes.push({ path: 'ping.zone_overrides', from: min, to: d, message: `Ping-Intervall im Gebiet "${zone}": ${d} statt ${min} min, weil das Spiel nur ${durationText(d)} dauert.` });
    }
  }
  for (const j of c.joker.enabled ? c.joker.types : []) {
    if (j.minutes !== undefined && j.minutes > d) {
      fixes.push({ path: 'joker.types', from: j.minutes, to: d, message: `Joker "${j.type}": ${d} statt ${j.minutes} min, weil das Spiel nur ${durationText(d)} dauert.` });
      j.minutes = d;
    }
  }
  return { config: c, fixes };
}
