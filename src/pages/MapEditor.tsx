import '../lib/leafletGlobal';
import '@geoman-io/leaflet-geoman-free';
import '@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { esc, zoneStyle } from '../components/MapView';
import { api, ZONE_INFO, ZONE_KINDS, type MapFeature, type ZoneKind } from '../lib/engine';
import { getGame, type Game } from '../lib/games';
import { errorText } from '../lib/supabase';
import { parseConfig } from '../shared/config';

interface Item { key: string; feature: MapFeature; layer: L.Layer }

let seq = 0;
const newKey = () => `z${Date.now()}_${seq++}`;

function circleToPolygon(lat: number, lng: number, r: number, n = 48): GeoJSON.Polygon {
  const coords: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * 2 * Math.PI;
    const dLat = (r * Math.cos(a)) / 111320;
    const dLng = (r * Math.sin(a)) / (111320 * Math.cos((lat * Math.PI) / 180));
    coords.push([lng + dLng, lat + dLat]);
  }
  return { type: 'Polygon', coordinates: [coords] };
}

function areaKm2(g: GeoJSON.Geometry): number {
  if (g.type !== 'Polygon') return 0;
  const ring = g.coordinates[0];
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    a += (x2 - x1) * (2 + Math.sin((y1 * Math.PI) / 180) + Math.sin((y2 * Math.PI) / 180));
  }
  return Math.abs((a * 6378137 * 6378137) / 2) / 1e6 * (Math.PI / 180);
}

export default function MapEditorPage() {
  const { id } = useParams<{ id: string }>();
  const [game, setGame] = useState<Game | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [kind, setKind] = useState<ZoneKind>('spielfeld');
  const [selected, setSelected] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [dirty, setDirty] = useState(false);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const group = useRef<L.FeatureGroup | null>(null);
  const kindRef = useRef(kind);
  kindRef.current = kind;
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const editable = !!game && ['entwurf', 'geplant', 'lobby'].includes(game.status);
  // Nur bei einem anderen Spiel neu aufbauen (nicht bei jedem neu geladenen Spielobjekt).
  const gameId = game?.id;
  const days = game ? parseConfig(game.config_json).game.days : 1;

  const restyle = useCallback((it: Item) => {
    const l = it.layer as L.Path;
    if (l.setStyle) l.setStyle(zoneStyle(it.feature));
    const info = ZONE_INFO[it.feature.properties.kind];
    l.unbindTooltip?.();
    l.bindTooltip?.(esc(`${it.feature.properties.name || info.label}${it.feature.properties.day_index ? ` · Tag ${it.feature.properties.day_index}` : ''}`), { sticky: true });
  }, []);

  const layerToFeature = useCallback((layer: L.Layer, k: ZoneKind, props?: MapFeature['properties']): MapFeature => {
    const base = { ...(props ?? { kind: k }), kind: k };
    if (layer instanceof L.Circle) {
      const c = layer.getLatLng();
      if (ZONE_INFO[k].point) {
        return { type: 'Feature', geometry: { type: 'Point', coordinates: [c.lng, c.lat] }, properties: { ...base, radius_m: Math.round(layer.getRadius()) } };
      }
      return { type: 'Feature', geometry: circleToPolygon(c.lat, c.lng, layer.getRadius()), properties: base };
    }
    if (layer instanceof L.Marker) {
      const c = layer.getLatLng();
      return { type: 'Feature', geometry: { type: 'Point', coordinates: [c.lng, c.lat] }, properties: { ...base, radius_m: base.radius_m ?? (k === 'hq' ? 100 : 30) } };
    }
    const gj = (layer as L.Polygon).toGeoJSON() as GeoJSON.Feature;
    return { type: 'Feature', geometry: gj.geometry, properties: base };
  }, []);

  const addItem = useCallback((feature: MapFeature, layer?: L.Layer) => {
    const g = group.current!;
    let l = layer;
    if (!l) {
      if (feature.geometry.type === 'Point') {
        const [lng, lat] = (feature.geometry as GeoJSON.Point).coordinates;
        l = L.circle([lat, lng], { radius: feature.properties.radius_m || 30 });
      } else {
        const gj = L.geoJSON(feature as GeoJSON.Feature);
        l = gj.getLayers()[0];
      }
    }
    if (!g.hasLayer(l)) g.addLayer(l);
    const it: Item = { key: newKey(), feature, layer: l };
    restyle(it);
    l.on('click', () => setSelected(it.key));
    l.on('pm:edit', () => {
      setItems((prev) => prev.map((x) => (x.key === it.key ? { ...x, feature: layerToFeature(l!, x.feature.properties.kind, x.feature.properties) } : x)));
      setDirty(true);
    });
    l.on('pm:remove', () => {
      setItems((prev) => prev.filter((x) => x.key !== it.key));
      setDirty(true);
    });
    return it;
  }, [layerToFeature, restyle]);

  useEffect(() => {
    if (!id) return;
    void (async () => {
      try {
        setGame(await getGame(id));
      } catch (err) {
        setMsg({ ok: false, text: errorText(err) });
      }
    })();
  }, [id]);

  useEffect(() => {
    if (!el.current || map.current || !gameId) return;
    const m = L.map(el.current).setView([47.3769, 8.5417], 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(m);
    group.current = L.featureGroup().addTo(m);
    map.current = m;
    if (editable) {
      m.pm.addControls({
        position: 'topleft', drawCircleMarker: false, drawPolyline: false, drawText: false, cutPolygon: false, rotateMode: false,
      });
      m.pm.setLang('de');
      m.on('pm:create', (e: { layer: L.Layer }) => {
        const k = kindRef.current;
        let layer = e.layer;
        const f = layerToFeature(layer, k, { kind: k, name: '' });
        if (layer instanceof L.Circle && !ZONE_INFO[k].point) {
          // Kreis als Polygon speichern
          group.current!.removeLayer(layer);
          m.removeLayer(layer);
          layer = L.geoJSON(f as GeoJSON.Feature).getLayers()[0];
        } else if (layer instanceof L.Marker) {
          m.removeLayer(layer);
          layer = L.circle((e.layer as L.Marker).getLatLng(), { radius: f.properties.radius_m || 30 });
        }
        const it = addItem(f, layer);
        setItems((prev) => [...prev, it]);
        setSelected(it.key);
        setDirty(true);
      });
    }
    let cancelled = false;
    void (async () => {
      try {
        const features = await api.map(gameId);
        if (cancelled) return;
        const list = features.map((f) => addItem(f));
        // Was schon gezeichnet oder importiert wurde, bleibt erhalten.
        setItems((prev) => [...list, ...prev]);
        setLoaded(true);
        const b = group.current!.getBounds();
        if (b.isValid()) m.fitBounds(b, { padding: [20, 20], animate: false });
        else if (navigator.geolocation) {
          navigator.geolocation.getCurrentPosition((p) => {
            // Nur zentrieren, wenn inzwischen nichts gezeichnet oder importiert wurde.
            if (!cancelled && itemsRef.current.length === 0) m.setView([p.coords.latitude, p.coords.longitude], 15, { animate: false });
          }, () => undefined, { timeout: 5000 });
        }
      } catch (err) {
        setMsg({ ok: false, text: errorText(err) });
      }
    })();
    return () => {
      cancelled = true;
      m.remove();
      map.current = null;
    };
  }, [gameId, editable, addItem, layerToFeature]);

  function update(key: string, patch: Partial<MapFeature['properties']>) {
    setItems((prev) =>
      prev.map((it) => {
        if (it.key !== key) return it;
        const feature = { ...it.feature, properties: { ...it.feature.properties, ...patch } };
        if (patch.radius_m && it.layer instanceof L.Circle) it.layer.setRadius(patch.radius_m);
        const next = { ...it, feature };
        restyle(next);
        return next;
      }),
    );
    setDirty(true);
  }

  function remove(key: string) {
    const it = items.find((x) => x.key === key);
    if (it) group.current?.removeLayer(it.layer);
    setItems((prev) => prev.filter((x) => x.key !== key));
    setSelected(null);
    setDirty(true);
  }

  async function save() {
    if (!game) return;
    setBusy(true);
    setMsg(null);
    try {
      const features = itemsRef.current.map((it) => {
        const { id: _id, released: _r, visible_from: _v, ...props } = it.feature.properties;
        return { type: 'Feature' as const, geometry: it.feature.geometry, properties: props };
      });
      const n = await api.saveMap(game.id, features);
      setMsg({ ok: true, text: `${n} Zonen gespeichert.` });
      setDirty(false);
    } catch (err) {
      setMsg({ ok: false, text: errorText(err) });
    } finally {
      setBusy(false);
    }
  }

  async function findPlace() {
    if (!search.trim() || !map.current) return;
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(search)}`, {
        headers: { 'Accept-Language': 'de' },
      });
      const j = (await r.json()) as { lat: string; lon: string; boundingbox?: string[] }[];
      if (!j.length) return setMsg({ ok: false, text: 'Ort nicht gefunden.' });
      const bb = j[0].boundingbox;
      if (bb) map.current.fitBounds([[+bb[0], +bb[2]], [+bb[1], +bb[3]]]);
      else map.current.setView([+j[0].lat, +j[0].lon], 15);
    } catch {
      setMsg({ ok: false, text: 'Suche nicht erreichbar.' });
    }
  }

  function exportJson() {
    const fc = { type: 'FeatureCollection', features: items.map((it) => it.feature) };
    const blob = new Blob([JSON.stringify(fc, null, 2)], { type: 'application/geo+json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${game?.name ?? 'karte'}.geojson`;
    a.click();
  }

  async function importJson(file: File) {
    try {
      const fc = JSON.parse(await file.text()) as { features?: MapFeature[] };
      const list: Item[] = [];
      for (const f of fc.features ?? []) {
        if (!f.geometry) continue;
        const k = (ZONE_KINDS as readonly string[]).includes(f.properties?.kind) ? f.properties.kind : 'spielfeld';
        list.push(addItem({ type: 'Feature', geometry: f.geometry, properties: { ...f.properties, kind: k } }));
      }
      setItems((prev) => [...prev, ...list]);
      setDirty(true);
      const b = group.current?.getBounds();
      if (b?.isValid()) map.current?.fitBounds(b, { animate: false });
      setMsg({ ok: true, text: `${list.length} Zonen importiert. Speichern nicht vergessen.` });
    } catch {
      setMsg({ ok: false, text: 'Datei ist kein gültiges GeoJSON.' });
    }
  }

  const sel = items.find((x) => x.key === selected);
  const field = items.filter((x) => x.feature.properties.kind === 'spielfeld' && !x.feature.properties.day_index);
  const area = field.reduce((s, x) => s + areaKm2(x.feature.geometry), 0);
  const counts = ZONE_KINDS.map((k) => [k, items.filter((x) => x.feature.properties.kind === k).length] as const).filter(([, n]) => n > 0);

  return (
    <div className="app wide">
      <div className="topbar">
        <Link to={`/spiel/${id}`} className="button ghost small">←</Link>
        <h1>Karte</h1>
        {editable && <button className="primary small" onClick={save} disabled={busy || !dirty || !loaded}>{busy ? 'Speichere …' : dirty ? 'Speichern' : 'Gespeichert'}</button>}
      </div>
      {!editable && game && <div className="notice">Das Spiel läuft: die Karte ist gesperrt. Die Spielleitung kann im Spiel Sperrzonen ergänzen.</div>}
      {editable && (
        <div className="card stack">
          <div className="row">
            <input placeholder="Ort suchen (z. B. Zürich HB)" value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && findPlace()} style={{ flex: 1 }} />
            <button className="small" onClick={findPlace}>Suchen</button>
          </div>
          <label className="field">
            Was zeichnest du?
            <select value={kind} onChange={(e) => setKind(e.target.value as ZoneKind)}>
              {ZONE_KINDS.map((k) => <option key={k} value={k}>{ZONE_INFO[k].label}</option>)}
            </select>
          </label>
          <div className="muted small">
            {ZONE_INFO[kind].help} {ZONE_INFO[kind].point ? 'Mit dem Kreis- oder Marker-Werkzeug setzen.' : 'Mit Polygon, Rechteck oder Kreis zeichnen.'} Werkzeuge oben links auf der Karte.
          </div>
        </div>
      )}
      <div ref={el} className="map" style={{ height: '58dvh' }} />
      <div className="muted small" style={{ margin: '8px 0' }}>
        {counts.map(([k, n]) => `${n} × ${ZONE_INFO[k].label}`).join(' · ') || 'Noch keine Zonen.'}
        {area > 0 && ` · Spielfeld ${area.toFixed(1)} km²`}
      </div>
      {msg && <div className={`notice ${msg.ok ? 'success' : 'error'}`} style={{ marginBottom: 12 }}>{msg.text}</div>}

      {sel && (
        <div className="card stack">
          <h2 style={{ margin: 0 }}>{ZONE_INFO[sel.feature.properties.kind].label}</h2>
          <label className="field">
            Name
            <input value={sel.feature.properties.name ?? ''} disabled={!editable} onChange={(e) => update(sel.key, { name: e.target.value })} />
          </label>
          <label className="field">
            Art
            <select value={sel.feature.properties.kind} disabled={!editable}
              onChange={(e) => {
                const k = e.target.value as ZoneKind;
                if (ZONE_INFO[k].point !== (sel.feature.geometry.type === 'Point')) return setMsg({ ok: false, text: 'Punkt und Fläche können nicht getauscht werden.' });
                update(sel.key, { kind: k });
              }}>
              {ZONE_KINDS.map((k) => <option key={k} value={k}>{ZONE_INFO[k].label}</option>)}
            </select>
          </label>
          {sel.feature.geometry.type === 'Point' && (
            <label className="field">
              Radius (m)
              <input type="number" min={5} max={2000} disabled={!editable} value={sel.feature.properties.radius_m ?? 30}
                onChange={(e) => update(sel.key, { radius_m: Math.max(5, +e.target.value || 30) })} />
            </label>
          )}
          {sel.feature.properties.kind === 'spielfeld' && days > 1 && (
            <label className="field">
              Gilt ab Spieltag
              <select value={sel.feature.properties.day_index ?? ''} disabled={!editable}
                onChange={(e) => update(sel.key, { day_index: e.target.value ? +e.target.value : null })}>
                <option value="">Alle Tage</option>
                {Array.from({ length: days }, (_, i) => <option key={i} value={i + 1}>Tag {i + 1}</option>)}
              </select>
            </label>
          )}
          {['center', 'kern', 'aussen'].includes(sel.feature.properties.kind) && (
            <label className="field">
              Eigenes Ping-Intervall (min, leer = Regel)
              <input type="number" min={1} max={720} disabled={!editable} value={sel.feature.properties.ping_interval_override ?? ''}
                onChange={(e) => update(sel.key, { ping_interval_override: e.target.value ? +e.target.value : null })} />
            </label>
          )}
          {sel.feature.properties.kind === 'sperrzone' && (
            <label className="check">
              <input type="checkbox" disabled={!editable} checked={!!sel.feature.properties.crossing_allowed}
                onChange={(e) => update(sel.key, { crossing_allowed: e.target.checked })} />
              <span>Durchqueren erlaubt (Aufenthalt nicht)</span>
            </label>
          )}
          {editable && <button className="ghost" onClick={() => remove(sel.key)}>Zone löschen</button>}
        </div>
      )}

      {editable && (
        <div className="row">
          <button className="small" onClick={exportJson}>GeoJSON exportieren</button>
          <label className="button small">
            GeoJSON importieren
            <input type="file" accept=".json,.geojson,application/geo+json" hidden disabled={!loaded} onChange={(e) => e.target.files?.[0] && importJson(e.target.files[0])} />
          </label>
        </div>
      )}
    </div>
  );
}
