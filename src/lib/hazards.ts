/**
 * "Gefahrenstellen vorschlagen" (Spezifikation 22.3): fragt OpenStreetMap (Overpass) im Spielfeld ab
 * und macht aus Autobahnen, Gleisen, Gewässern, Schulen und Militärgelände Sperrzonen-Vorschläge.
 */
import { bbox, featureCollection, union } from '@turf/turf';
import type { Position } from 'geojson';
import { bandFromLine, clipTo, type Area } from './geo';

export interface HazardSuggestion {
  key: string;
  name: string;
  type: string;
  shape: Area;
}

interface OsmElement {
  type: 'way' | 'relation';
  id: number;
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
}

const ENDPOINT = 'https://overpass-api.de/api/interpreter';

function classify(tags: Record<string, string>): { type: string; width?: number; label: string } | null {
  const hw = tags.highway;
  if (hw === 'motorway' || hw === 'trunk' || hw === 'motorway_link' || hw === 'trunk_link') return { type: 'strasse', width: 60, label: tags.ref || tags.name || 'Autobahn' };
  if (tags.railway === 'rail' || tags.railway === 'light_rail') return { type: 'gleise', width: 30, label: tags.name || 'Bahngleise' };
  if (tags.natural === 'water' || tags.waterway === 'riverbank' || tags.water) return { type: 'gewaesser', label: tags.name || 'Gewässer' };
  if (tags.waterway === 'river' || tags.waterway === 'canal') return { type: 'gewaesser', width: 20, label: tags.name || 'Fluss' };
  if (tags.amenity === 'school' || tags.amenity === 'kindergarten') return { type: 'schule', label: tags.name || 'Schule' };
  if (tags.landuse === 'military' || tags.military) return { type: 'militaer', label: tags.name || 'Militärgelände' };
  if (tags.landuse === 'construction') return { type: 'baustelle', label: tags.name || 'Baustelle' };
  return null;
}

function closed(ring: Position[]): boolean {
  if (ring.length < 4) return false;
  const a = ring[0];
  const b = ring[ring.length - 1];
  return a[0] === b[0] && a[1] === b[1];
}

export async function suggestHazards(field: Area, fetcher: typeof fetch = fetch): Promise<HazardSuggestion[]> {
  const [w, s, e, n] = bbox(field);
  const b = `${s},${w},${n},${e}`;
  const q = `[out:json][timeout:25];(
    way["highway"~"^(motorway|trunk|motorway_link|trunk_link)$"](${b});
    way["railway"~"^(rail|light_rail)$"]["service"!~"."](${b});
    way["natural"="water"](${b});
    way["waterway"~"^(river|canal|riverbank)$"](${b});
    way["amenity"~"^(school|kindergarten)$"](${b});
    way["landuse"~"^(military|construction)$"](${b});
  );out geom 400;`;
  const res = await fetcher(ENDPOINT, { method: 'POST', body: new URLSearchParams({ data: q }) });
  if (!res.ok) throw new Error(`Overpass ${res.status}`);
  const json = (await res.json()) as { elements: OsmElement[] };
  const out: HazardSuggestion[] = [];
  // Gleiche Strecken (z. B. Gleis-Paare) zusammenfassen: pro Name und Typ ein Vorschlag.
  const byName = new Map<string, HazardSuggestion>();
  for (const el of json.elements) {
    if (!el.geometry || el.geometry.length < 2 || !el.tags) continue;
    const c = classify(el.tags);
    if (!c) continue;
    const coords: Position[] = el.geometry.map((g) => [g.lon, g.lat]);
    let shape: Area;
    if (c.width) shape = bandFromLine(coords, c.width);
    else if (closed(coords)) shape = { type: 'Feature', geometry: { type: 'Polygon', coordinates: [coords] }, properties: {} };
    else continue;
    const clipped = clipTo(shape, field);
    if (!clipped) continue;
    const k = `${c.type}:${c.label}`;
    const prev = byName.get(k);
    if (prev && c.width) {
      const u = union(featureCollection([prev.shape, clipped])) as Area | null;
      if (u) prev.shape = u;
      continue;
    }
    const sug: HazardSuggestion = { key: `${el.type}${el.id}`, name: c.label, type: c.type, shape: clipped };
    byName.set(k, sug);
    out.push(sug);
  }
  return out.slice(0, 60);
}
