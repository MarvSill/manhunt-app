/**
 * Geometrie-Helfer für Karten-Editor und Karte (Turf).
 * Koordinaten wie GeoJSON: [lng, lat].
 */
import { area, booleanPointInPolygon, buffer, centroid, featureCollection, intersect, transformScale, union } from '@turf/turf';
import type { Feature, MultiPolygon, Polygon, Position } from 'geojson';
import type { MapFeature, ZoneKind } from './engine';

export type Area = Feature<Polygon | MultiPolygon>;

/** Arten von Sperrzonen mit Symbol (Spezifikation 22.3). */
export const RESTRICTED_TYPES: Record<string, { label: string; icon: string }> = {
  strasse: { label: 'Strasse / Autobahn', icon: '🚗' },
  gleise: { label: 'Bahngleise', icon: '🚆' },
  gewaesser: { label: 'Gewässer', icon: '🌊' },
  baustelle: { label: 'Baustelle', icon: '🚧' },
  privat: { label: 'Privatgelände', icon: '🏠' },
  schule: { label: 'Schule / Kita', icon: '🏫' },
  spital: { label: 'Spital', icon: '🏥' },
  bahnhof: { label: 'Bahnhof innen', icon: '🚉' },
  einkauf: { label: 'Einkaufszentrum innen', icon: '🛒' },
  militaer: { label: 'Polizei / Militär', icon: '👮' },
  andere: { label: 'Andere Gefahr', icon: '⚠️' },
};

export function restrictedInfo(type?: string | null) {
  return RESTRICTED_TYPES[type ?? ''] ?? RESTRICTED_TYPES.andere;
}

function isArea(f: MapFeature): boolean {
  return f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon';
}

function asArea(f: MapFeature): Area {
  return { type: 'Feature', geometry: f.geometry as Polygon | MultiPolygon, properties: {} };
}

/** Vereinigung mehrerer Flächen (null, wenn keine). */
export function unionAll(list: Area[]): Area | null {
  if (list.length === 0) return null;
  if (list.length === 1) return list[0];
  return (union(featureCollection(list)) as Area | null) ?? null;
}

/** Spielfeld einer Phase: höchste gezeichnete Phase <= p, sonst das Feld ohne Phase. */
export function fieldOfPhase(features: MapFeature[], phase: number): Area | null {
  const fields = features.filter((f) => f.properties.kind === 'spielfeld' && isArea(f));
  const phased = fields.filter((f) => f.properties.day_index != null && (f.properties.day_index ?? 0) <= Math.max(phase, 1));
  const best = phased.reduce((m, f) => Math.max(m, f.properties.day_index ?? 0), 0);
  const chosen = best > 0 ? phased.filter((f) => f.properties.day_index === best) : fields.filter((f) => f.properties.day_index == null);
  return unionAll(chosen.map(asArea));
}

/** Höchste gezeichnete Phase. */
export function maxPhase(features: MapFeature[]): number {
  return features.reduce((m, f) => (f.properties.kind === 'spielfeld' ? Math.max(m, f.properties.day_index ?? 1) : m), 0);
}

/** Fläche auf einen Container zuschneiden; null, wenn nichts übrig bleibt. */
export function clipTo(shape: Area, container: Area): Area | null {
  const r = intersect(featureCollection([shape, container])) as Area | null;
  if (!r || area(r) < 1) return null;
  return r;
}

/** Wie viel Prozent der Fläche ausserhalb des Containers liegen. */
export function outsideShare(shape: Area, container: Area): number {
  const a = area(shape);
  if (a <= 0) return 0;
  const inside = intersect(featureCollection([shape, container]));
  return 1 - (inside ? area(inside) : 0) / a;
}

export function pointInside(pt: Position, container: Area): boolean {
  return booleanPointInPolygon(pt, container);
}

export function areaKm2(geom: Area | null): number {
  return geom ? area(geom) / 1e6 : 0;
}

/** Linie als Band mit Breite (z. B. Gleise 15 m, Autobahn 30 m). */
export function bandFromLine(coords: Position[], widthM: number): Area {
  return buffer({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} }, widthM / 2, { units: 'meters' }) as Area;
}

/** Fläche um Mittelpunkt skalieren wie die Engine (Faktor pro Achse = sqrt der Flächenquote). */
export function shrinkArea(field: Area, center: Position, percent: number, step: number): Area {
  const factor = Math.sqrt(Math.pow(1 - percent / 100, step));
  return transformScale(field, factor, { origin: center }) as Area;
}

export function centerOf(field: Area, exit?: Position | null): Position {
  if (exit && pointInside(exit, field)) return exit;
  return centroid(field).geometry.coordinates;
}

/** Welche Zonen nur innerhalb des Spielfelds liegen dürfen. */
export const INSIDE_FIELD: ZoneKind[] = ['sektion', 'startzone', 'center', 'kern', 'aussen', 'sicher', 'sperrzone'];

export interface MapIssue { level: 'error' | 'warning'; text: string }

export interface MapCheckInput {
  features: MapFeature[];
  exitEnabled: boolean;
  phases: number;
  autoShrink: boolean;
  manualShrink: boolean;
  hqMinDistanceM: number;
  players: number;
  durationMinutes: number;
}

function distM(a: Position, b: Position): number {
  const R = 6371000;
  const dLat = ((b[1] - a[1]) * Math.PI) / 180;
  const dLng = ((b[0] - a[0]) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos((a[1] * Math.PI) / 180) * Math.cos((b[1] * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** Prüfungen vor dem Start (Spezifikation 22.4), so weit sie im Browser gehen. */
export function checkMap(i: MapCheckInput): MapIssue[] {
  const out: MapIssue[] = [];
  const f = i.features;
  const pts = (k: ZoneKind) => f.filter((x) => x.properties.kind === k && x.geometry.type === 'Point').map((x) => (x.geometry as GeoJSON.Point).coordinates);
  const field1 = fieldOfPhase(f, 1);
  const last = fieldOfPhase(f, i.phases);
  const restricted = unionAll(f.filter((x) => x.properties.kind === 'sperrzone' && isArea(x)).map(asArea));

  if (!field1) out.push({ level: 'error', text: 'Es fehlt das Spielfeld.' });
  const meet = pts('treffpunkt');
  const hq = pts('hq');
  const exits = pts('exit');
  if (meet.length === 0) out.push({ level: 'warning', text: 'Kein Treffpunkt gesetzt (empfohlen).' });
  if (hq.length === 0) out.push({ level: 'warning', text: 'Kein HQ für die Hunter gesetzt (empfohlen).' });
  if (i.exitEnabled && exits.length === 0) out.push({ level: 'error', text: 'Setze mindestens einen Exitpoint-Kandidaten oder schalte den Exitpoint in den Regeln aus.' });
  if (field1) {
    if (meet.some((p) => !pointInside(p, field1))) out.push({ level: 'error', text: 'Der Treffpunkt liegt ausserhalb des Spielfelds.' });
    const lastField = i.autoShrink ? field1 : last ?? field1;
    if (exits.some((p) => !pointInside(p, lastField))) {
      out.push({ level: 'error', text: i.manualShrink ? 'Ein Exitpoint liegt ausserhalb des Spielfelds der letzten Phase.' : 'Ein Exitpoint liegt ausserhalb des Spielfelds.' });
    }
    const km2 = areaKm2(field1);
    if (km2 > 500) out.push({ level: 'warning', text: 'Das Spielfeld ist grösser als 500 km².' });
    if (km2 > 0 && km2 < 0.02) out.push({ level: 'warning', text: 'Das Spielfeld ist sehr klein (unter 0,02 km²).' });
    if (restricted && areaKm2(restricted) > 0.4 * km2) out.push({ level: 'warning', text: 'Sperrzonen bedecken mehr als 40 % des Spielfelds.' });
    const rec = recommendedKm2PerPlayer(i.durationMinutes);
    const per = km2 / Math.max(1, i.players);
    if (per < rec[0] / 2 || per > rec[1] * 2) {
      out.push({ level: 'warning', text: `Fläche pro Spieler ${per.toFixed(2)} km², empfohlen ${rec[0]}–${rec[1]} km² bei dieser Spieldauer.` });
    }
  }
  if (restricted) {
    if ([...meet, ...hq, ...exits].some((p) => pointInside(p, restricted))) out.push({ level: 'error', text: 'Treffpunkt, HQ oder ein Exitpoint liegt in einer Sperrzone.' });
  }
  if (meet.length && hq.length && distM(meet[0], hq[0]) < i.hqMinDistanceM) {
    out.push({ level: 'warning', text: `Das HQ ist nur ${Math.round(distM(meet[0], hq[0]))} m vom Treffpunkt entfernt (Regel: mindestens ${i.hqMinDistanceM} m).` });
  }
  if (i.manualShrink && i.phases > 1) {
    for (let p = 2; p <= i.phases; p++) {
      const has = f.some((x) => x.properties.kind === 'spielfeld' && x.properties.day_index === p);
      if (!has) out.push({ level: 'warning', text: `Für Phase ${p} ist kein eigenes Spielfeld gezeichnet (es gilt das vorherige).` });
    }
    for (const x of f.filter((z) => z.properties.kind === 'spielfeld' && (z.properties.day_index ?? 1) > 1 && !z.properties.grows)) {
      const prev = fieldOfPhase(f, (x.properties.day_index ?? 2) - 1);
      if (prev && outsideShare(asArea(x), prev) > 0.01) out.push({ level: 'error', text: `Das Spielfeld von Phase ${x.properties.day_index} ist grösser als das vorherige (oder als „vergrössert“ markieren).` });
    }
  }
  return out;
}

/** Empfohlene Fläche pro Spieler in km² (Spezifikation 22.5). */
export function recommendedKm2PerPlayer(minutes: number): [number, number] {
  if (minutes <= 90) return [0.05, 0.15];
  if (minutes <= 240) return [0.15, 0.5];
  if (minutes <= 1440) return [1, 3];
  return [3, 8];
}
