import { describe, expect, it } from 'vitest';
import type { MapFeature } from './engine';
import { areaKm2, bandFromLine, checkMap, clipTo, fieldOfPhase, outsideShare, shrinkArea, type Area } from './geo';

const square = (x: number, y: number, d: number): Area => ({
  type: 'Feature', properties: {},
  geometry: { type: 'Polygon', coordinates: [[[x, y], [x + d, y], [x + d, y + d], [x, y + d], [x, y]]] },
});
const zone = (kind: MapFeature['properties']['kind'], a: Area, extra: Partial<MapFeature['properties']> = {}): MapFeature =>
  ({ type: 'Feature', geometry: a.geometry, properties: { kind, ...extra } }) as MapFeature;
const point = (kind: MapFeature['properties']['kind'], x: number, y: number): MapFeature =>
  ({ type: 'Feature', geometry: { type: 'Point', coordinates: [x, y] }, properties: { kind } }) as MapFeature;

describe('geo', () => {
  const field = square(8.5, 47.3, 0.02);

  it('schneidet Zonen aufs Spielfeld zu', () => {
    const half = square(8.51, 47.31, 0.02);
    expect(outsideShare(half, field)).toBeGreaterThan(0.7);
    const c = clipTo(half, field)!;
    expect(outsideShare(c, field)).toBeLessThan(0.001);
    expect(clipTo(square(9, 48, 0.01), field)).toBeNull();
  });

  it('verkleinert wie die Engine (Fläche je Schritt)', () => {
    const a = areaKm2(field);
    const s = shrinkArea(field, [8.51, 47.31], 40, 1);
    expect(areaKm2(s) / a).toBeCloseTo(0.6, 2);
    expect(areaKm2(shrinkArea(field, [8.51, 47.31], 40, 2)) / a).toBeCloseTo(0.36, 2);
  });

  it('macht aus einer Linie ein Band', () => {
    const b = bandFromLine([[8.5, 47.3], [8.51, 47.3]], 30);
    expect(areaKm2(b)).toBeGreaterThan(0.02);
    expect(areaKm2(b)).toBeLessThan(0.03);
  });

  it('wählt das Spielfeld der Phase', () => {
    const f = [zone('spielfeld', field), zone('spielfeld', square(8.505, 47.305, 0.01), { day_index: 2 })];
    expect(areaKm2(fieldOfPhase(f, 1))).toBeCloseTo(areaKm2(field), 3);
    expect(areaKm2(fieldOfPhase(f, 3))).toBeLessThan(areaKm2(field) / 2);
  });

  it('prüft die Karte', () => {
    const base = { exitEnabled: true, phases: 1, autoShrink: false, manualShrink: false, hqMinDistanceM: 0, players: 5, durationMinutes: 180 };
    expect(checkMap({ ...base, features: [] }).some((i) => i.text.includes('Spielfeld'))).toBe(true);
    const ok = [zone('spielfeld', field), point('treffpunkt', 8.51, 47.31), point('hq', 8.505, 47.305), point('exit', 8.515, 47.315)];
    expect(checkMap({ ...base, features: ok }).filter((i) => i.level === 'error')).toEqual([]);
    const bad = [...ok, zone('sperrzone', square(8.509, 47.309, 0.002))];
    expect(checkMap({ ...base, features: bad }).some((i) => i.text.includes('Sperrzone'))).toBe(true);
    const out = [zone('spielfeld', field), point('treffpunkt', 9, 48), point('exit', 8.51, 47.31)];
    expect(checkMap({ ...base, features: out }).some((i) => i.text.includes('Treffpunkt liegt ausserhalb'))).toBe(true);
  });
});
