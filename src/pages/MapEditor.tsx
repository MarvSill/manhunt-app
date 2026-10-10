import '../lib/leafletGlobal';
import '@geoman-io/leaflet-geoman-free';
import '@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { esc, zoneBadge, zoneStyle } from '../components/MapView';
import { api, ZONE_INFO, ZONE_KINDS, type MapFeature, type ZoneKind } from '../lib/engine';
import {
  areaKm2, bandFromLine, centerOf, checkMap, clipTo, fieldOfPhase, INSIDE_FIELD, outsideShare, pointInside,
  recommendedKm2PerPlayer, RESTRICTED_TYPES, restrictedInfo, shrinkArea, type Area,
} from '../lib/geo';
import { diffConfig, getGame, updateConfig, type Game } from '../lib/games';
import { suggestHazards, type HazardSuggestion } from '../lib/hazards';
import { errorText } from '../lib/supabase';
import { gameConfigSchema, parseConfig, type GameConfig } from '../shared/config';

interface Item { key: string; feature: MapFeature; layer: L.Layer }
type Tool = 'Polygon' | 'Rectangle' | 'Circle' | 'Marker' | 'Line';
interface Pending { kind: ZoneKind; tool: Tool; phase?: number | null; restrictedType?: string; widthM?: number }

let seq = 0;
const newKey = () => `z${Date.now()}_${seq++}`;

/** Symbol je Zonenart (Liste und Knöpfe). */
const ICON: Record<ZoneKind, string> = {
  spielfeld: '🟩', sektion: '🧩', startzone: '🚩', center: '⭐', kern: '🎯', aussen: '⭕',
  sperrzone: '⚠️', sicher: '🛡️', exit: '🏁', hq: '🚓', treffpunkt: '📍',
};

const TOOL_HINT: Record<Tool, string> = {
  Polygon: 'Tippe die Ecken nacheinander auf die Karte. Zum Abschliessen den ersten Punkt nochmals antippen.',
  Rectangle: 'Tippe eine Ecke, dann die gegenüberliegende Ecke.',
  Circle: 'Tippe den Mittelpunkt, dann tippe so weit weg, wie der Kreis gross sein soll.',
  Marker: 'Tippe die Stelle auf der Karte an.',
  Line: 'Tippe der Strasse oder den Gleisen entlang. Zum Abschliessen den letzten Punkt nochmals antippen.',
};

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

const asArea = (f: MapFeature): Area => ({ type: 'Feature', geometry: f.geometry as GeoJSON.Polygon, properties: {} });
const isArea = (f: MapFeature) => f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon';

/** Anzahl Phasen wie in der Engine (phase_count). */
export function phaseCount(c: GameConfig): number {
  const every = c.zone.shrink_mode === 'aus' ? 0 : c.zone.shrink_every_minutes;
  return every > 0 ? Math.min(50, Math.max(1, Math.ceil(c.game.duration_minutes / every))) : c.game.days;
}

export default function MapEditorPage() {
  const { id } = useParams<{ id: string }>();
  const [game, setGame] = useState<Game | null>(null);
  const [savedConfig, setSavedConfig] = useState<GameConfig | null>(null);
  const [config, setConfig] = useState<GameConfig | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [dirty, setDirty] = useState(false);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [preview, setPreview] = useState(1);
  const [hazards, setHazards] = useState<HazardSuggestion[] | null>(null);
  const [hazardBusy, setHazardBusy] = useState(false);
  const [lineWidth, setLineWidth] = useState(30);
  const [restrictedType, setRestrictedType] = useState('gleise');
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const group = useRef<L.FeatureGroup | null>(null);
  const badges = useRef<L.LayerGroup | null>(null);
  const previewLayer = useRef<L.LayerGroup | null>(null);
  const hazardLayer = useRef<L.LayerGroup | null>(null);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const handleCreateRef = useRef<(layer: L.Layer) => void>(() => undefined);

  const editable = !!game && ['entwurf', 'geplant', 'lobby'].includes(game.status);
  const gameId = game?.id;
  const features = useMemo(() => items.map((x) => x.feature), [items]);
  const phases = config ? phaseCount(config) : 1;
  const shrink = config?.zone.shrink_mode ?? 'aus';

  const restyle = useCallback((it: Item) => {
    const l = it.layer as L.Path;
    const p = it.feature.properties;
    if (l.setStyle) l.setStyle(zoneStyle(it.feature));
    const path = (l as unknown as { _path?: SVGElement })._path;
    if (path) path.classList.toggle('hm-danger', p.kind === 'sperrzone');
    const info = ZONE_INFO[p.kind];
    const extra = p.kind === 'sperrzone' ? ` (${restrictedInfo(p.restricted_type).label})` : p.day_index ? ` · Phase ${p.day_index}` : '';
    l.unbindTooltip?.();
    l.bindTooltip?.(esc(`${ICON[p.kind]} ${p.name || info.label}${extra}`), { sticky: true });
  }, []);

  const layerToFeature = useCallback((layer: L.Layer, props: MapFeature['properties']): MapFeature => {
    const k = props.kind;
    if (layer instanceof L.Circle) {
      const c = layer.getLatLng();
      if (ZONE_INFO[k].point) {
        return { type: 'Feature', geometry: { type: 'Point', coordinates: [c.lng, c.lat] }, properties: { ...props, radius_m: Math.round(layer.getRadius()) } };
      }
      return { type: 'Feature', geometry: circleToPolygon(c.lat, c.lng, layer.getRadius()), properties: props };
    }
    if (layer instanceof L.Marker) {
      const c = layer.getLatLng();
      return { type: 'Feature', geometry: { type: 'Point', coordinates: [c.lng, c.lat] }, properties: { ...props, radius_m: props.radius_m ?? (k === 'hq' ? 100 : 30) } };
    }
    const gj = (layer as L.Polygon).toGeoJSON() as GeoJSON.Feature;
    return { type: 'Feature', geometry: gj.geometry, properties: props };
  }, []);

  const addItem = useCallback((feature: MapFeature) => {
    const g = group.current!;
    let l: L.Layer;
    if (feature.geometry.type === 'Point') {
      const [lng, lat] = (feature.geometry as GeoJSON.Point).coordinates;
      l = L.circle([lat, lng], { radius: feature.properties.radius_m || 30 });
    } else {
      l = L.geoJSON(feature as GeoJSON.Feature).getLayers()[0];
    }
    g.addLayer(l);
    const it: Item = { key: newKey(), feature, layer: l };
    restyle(it);
    l.on('click', () => setSelected(it.key));
    l.on('pm:edit', () => {
      setItems((prev) => prev.map((x) => (x.key === it.key ? { ...x, feature: layerToFeature(l, x.feature.properties) } : x)));
      setDirty(true);
    });
    return it;
  }, [layerToFeature, restyle]);

  // Spiel laden
  useEffect(() => {
    if (!id) return;
    void (async () => {
      try {
        const g = await getGame(id);
        setGame(g);
        if (g) {
          const c = parseConfig(g.config_json);
          setSavedConfig(c);
          setConfig(c);
        }
      } catch (err) {
        setMsg({ ok: false, text: errorText(err) });
      }
    })();
  }, [id]);

  // Karte aufbauen
  useEffect(() => {
    if (!el.current || map.current || !gameId) return;
    const m = L.map(el.current).setView([47.3769, 8.5417], 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(m);
    previewLayer.current = L.layerGroup().addTo(m);
    group.current = L.featureGroup().addTo(m);
    badges.current = L.layerGroup().addTo(m);
    hazardLayer.current = L.layerGroup().addTo(m);
    map.current = m;
    m.pm.setLang('de');
    m.pm.setGlobalOptions({ snappable: true, snapDistance: 15, allowSelfIntersection: false } as L.PM.GlobalOptions);
    m.on('pm:create', (e: { layer: L.Layer }) => handleCreateRef.current(e.layer));
    let cancelled = false;
    void (async () => {
      try {
        const list = (await api.map(gameId)).map((f) => addItem(f));
        if (cancelled) return;
        // Was schon gezeichnet oder importiert wurde, bleibt erhalten.
        setItems((prev) => [...list, ...prev]);
        setLoaded(true);
        const b = group.current!.getBounds();
        if (b.isValid()) m.fitBounds(b, { padding: [20, 20], animate: false });
        else if (navigator.geolocation) {
          navigator.geolocation.getCurrentPosition((p) => {
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
  }, [gameId, addItem]);

  // Symbole auf Gefahren- und Schutzzonen
  useEffect(() => {
    const b = badges.current;
    if (!b) return;
    b.clearLayers();
    for (const f of features) if (f.properties.kind === 'sperrzone' || f.properties.kind === 'sicher') b.addLayer(zoneBadge(f));
  }, [features]);

  // Gewählte Zone bearbeitbar machen
  useEffect(() => {
    for (const it of items) {
      const pm = (it.layer as L.Layer & { pm?: { enable: (o?: object) => void; disable: () => void; enabled: () => boolean } }).pm;
      if (!pm) continue;
      if (editable && it.key === selected) {
        if (!pm.enabled()) pm.enable({ draggable: true, allowSelfIntersection: false });
      } else if (pm.enabled()) pm.disable();
    }
  }, [selected, items, editable]);

  // Vorschau der Verkleinerung
  const phaseFields = useMemo(() => {
    const out: (Area | null)[] = [];
    if (!config) return out;
    const f1 = fieldOfPhase(features, 1);
    const exitPt = features.find((f) => f.properties.kind === 'exit' && f.geometry.type === 'Point');
    for (let p = 1; p <= phases; p++) {
      if (shrink === 'auto' && f1) {
        out.push(p === 1 ? f1 : shrinkArea(f1, centerOf(f1, exitPt ? (exitPt.geometry as GeoJSON.Point).coordinates : null), config.zone.auto_shrink_percent, p - 1));
      } else {
        out.push(fieldOfPhase(features, p));
      }
    }
    return out;
  }, [features, config, phases, shrink]);

  useEffect(() => {
    const l = previewLayer.current;
    if (!l) return;
    l.clearLayers();
    if (shrink === 'aus' || phases < 2) return;
    phaseFields.forEach((f, i) => {
      if (!f || i === 0) return;
      const active = i + 1 === preview;
      l.addLayer(L.geoJSON(f, {
        style: { color: active ? '#f0f6fc' : '#3fb950', weight: active ? 3 : 1.5, dashArray: '8 6', fillOpacity: active ? 0.08 : 0, opacity: active ? 1 : 0.6 },
        interactive: false,
      }));
    });
  }, [phaseFields, preview, shrink, phases]);

  // Neue Zeichnung übernehmen
  handleCreateRef.current = (layer: L.Layer) => {
    const m = map.current!;
    m.removeLayer(layer);
    const p = pendingRef.current;
    setPending(null);
    m.pm.disableDraw();
    if (!p) return;
    const field1 = fieldOfPhase(itemsRef.current.map((x) => x.feature), 1);
    const props: MapFeature['properties'] = { kind: p.kind, name: '' };
    if (p.kind === 'spielfeld' && p.phase) props.day_index = p.phase;
    if (p.kind === 'sperrzone') props.restricted_type = p.restrictedType ?? 'andere';
    let f: MapFeature;
    if (p.tool === 'Line') {
      const coords = ((layer as L.Polyline).toGeoJSON() as GeoJSON.Feature<GeoJSON.LineString>).geometry.coordinates;
      f = { type: 'Feature', geometry: bandFromLine(coords, p.widthM ?? 30).geometry, properties: props };
    } else {
      f = layerToFeature(layer, props);
    }

    if (f.geometry.type === 'Point') {
      const pt = (f.geometry as GeoJSON.Point).coordinates;
      if ((p.kind === 'treffpunkt' || p.kind === 'exit') && field1 && !pointInside(pt, field1)) {
        setMsg({ ok: false, text: `${ZONE_INFO[p.kind].label} muss im Spielfeld liegen. Bitte innerhalb antippen.` });
        return;
      }
      if (p.kind === 'treffpunkt' || p.kind === 'hq') {
        // Nur einen davon: der alte wird ersetzt.
        for (const old of itemsRef.current.filter((x) => x.feature.properties.kind === p.kind)) group.current?.removeLayer(old.layer);
        setItems((prev) => prev.filter((x) => x.feature.properties.kind !== p.kind));
      }
    } else {
      // Zonen, die nur innerhalb eines anderen Gebiets liegen dürfen, werden zugeschnitten.
      let container: Area | null = null;
      let where = 'im Spielfeld';
      if (INSIDE_FIELD.includes(p.kind)) container = field1;
      if (p.kind === 'spielfeld' && p.phase && p.phase > 1) {
        container = fieldOfPhase(itemsRef.current.map((x) => x.feature), p.phase - 1);
        where = `im Spielfeld von Phase ${p.phase - 1}`;
      }
      if (INSIDE_FIELD.includes(p.kind) && !container) {
        setMsg({ ok: false, text: 'Zeichne zuerst das Spielfeld. Diese Zone muss darin liegen.' });
        return;
      }
      if (container) {
        const share = outsideShare(asArea(f), container);
        if (share > 0.001) {
          const clipped = clipTo(asArea(f), container);
          if (!clipped) {
            setMsg({ ok: false, text: `Die Zone liegt ganz ausserhalb. Sie muss ${where} liegen.` });
            return;
          }
          f = { ...f, geometry: clipped.geometry };
          setMsg({ ok: true, text: `Der Teil ausserhalb wurde abgeschnitten: die Zone liegt jetzt ganz ${where}.` });
        } else {
          setMsg(null);
        }
      } else {
        setMsg(null);
      }
    }
    const it = addItem(f);
    setItems((prev) => [...prev, it]);
    setSelected(it.key);
    setDirty(true);
  };

  function startDraw(p: Pending) {
    const m = map.current;
    if (!m || !editable) return;
    m.pm.disableDraw();
    setSelected(null);
    setPending(p);
    setMsg(null);
    const color = p.kind === 'sperrzone' ? '#f85149' : ZONE_INFO[p.kind].color;
    m.pm.enableDraw(p.tool, {
      snappable: true,
      templineStyle: { color },
      hintlineStyle: { color, dashArray: '5,5' },
      pathOptions: { color },
      finishOn: p.tool === 'Line' ? 'dblclick' : undefined,
    } as L.PM.DrawModeOptions);
    el.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function cancelDraw() {
    map.current?.pm.disableDraw();
    setPending(null);
  }

  function finishLine() {
    // Linie mit den bisher gesetzten Punkten abschliessen.
    const m = map.current as unknown as { pm: { Draw: { Line: { _finishShape: () => void } } } } | null;
    m?.pm.Draw.Line._finishShape();
  }

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

  function select(key: string) {
    setSelected(key);
    const it = items.find((x) => x.key === key);
    const l = it?.layer as L.Polygon | L.Circle | undefined;
    if (l && 'getBounds' in l) map.current?.fitBounds(l.getBounds(), { padding: [40, 40], maxZoom: 17 });
    el.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function setZone<K extends keyof GameConfig['zone']>(key: K, value: GameConfig['zone'][K]) {
    if (!config) return;
    const next = structuredClone(config);
    next.zone[key] = value;
    const parsed = gameConfigSchema.safeParse(next);
    if (parsed.success) setConfig(parsed.data);
    setDirty(true);
  }

  /** Spielfeld der nächsten Phase als verkleinerte Kopie der vorherigen anlegen. */
  function copyShrunk(phase: number, percent: number) {
    const prev = fieldOfPhase(features, phase - 1);
    if (!prev) return setMsg({ ok: false, text: `Zeichne zuerst das Spielfeld von Phase ${phase - 1}.` });
    const exitPt = features.find((f) => f.properties.kind === 'exit' && f.geometry.type === 'Point');
    const shape = shrinkArea(prev, centerOf(prev, exitPt ? (exitPt.geometry as GeoJSON.Point).coordinates : null), percent, 1);
    for (const old of items.filter((x) => x.feature.properties.kind === 'spielfeld' && x.feature.properties.day_index === phase)) group.current?.removeLayer(old.layer);
    const it = addItem({ type: 'Feature', geometry: shape.geometry, properties: { kind: 'spielfeld', name: `Spielfeld Phase ${phase}`, day_index: phase } });
    setItems((prevItems) => [...prevItems.filter((x) => !(x.feature.properties.kind === 'spielfeld' && x.feature.properties.day_index === phase)), it]);
    setSelected(it.key);
    setPreview(phase);
    setDirty(true);
  }

  /** Alle Zonen, die über das Spielfeld hinausragen, zuschneiden. */
  function clipAll() {
    const field1 = fieldOfPhase(features, 1);
    if (!field1) return;
    let n = 0;
    const next: Item[] = [];
    for (const it of items) {
      const f = it.feature;
      if (INSIDE_FIELD.includes(f.properties.kind) && isArea(f) && outsideShare(asArea(f), field1) > 0.001) {
        const c = clipTo(asArea(f), field1);
        group.current?.removeLayer(it.layer);
        if (c) next.push(addItem({ ...f, geometry: c.geometry }));
        n++;
      } else next.push(it);
    }
    setItems(next);
    setDirty(true);
    setMsg({ ok: true, text: `${n} Zone(n) aufs Spielfeld zugeschnitten.` });
  }

  async function loadHazards() {
    const field1 = fieldOfPhase(features, 1);
    if (!field1) return setMsg({ ok: false, text: 'Zeichne zuerst das Spielfeld.' });
    setHazardBusy(true);
    setMsg(null);
    try {
      const list = await suggestHazards(field1);
      setHazards(list);
      if (list.length === 0) setMsg({ ok: true, text: 'Keine Autobahnen, Gleise, Gewässer oder Schulen im Spielfeld gefunden.' });
    } catch {
      setMsg({ ok: false, text: 'OpenStreetMap ist gerade nicht erreichbar. Versuch es später nochmals oder zeichne die Sperrzonen selbst.' });
    } finally {
      setHazardBusy(false);
    }
  }

  useEffect(() => {
    const l = hazardLayer.current;
    if (!l) return;
    l.clearLayers();
    for (const h of hazards ?? []) {
      l.addLayer(L.geoJSON(h.shape, { style: { color: '#f85149', weight: 1, dashArray: '3 3', fillOpacity: 0.25 }, interactive: false }));
    }
  }, [hazards]);

  function takeHazards(list: HazardSuggestion[]) {
    const added = list.map((h) => addItem({ type: 'Feature', geometry: h.shape.geometry, properties: { kind: 'sperrzone', name: h.name, restricted_type: h.type } }));
    setItems((prev) => [...prev, ...added]);
    setHazards((prev) => (prev ?? []).filter((h) => !list.includes(h)));
    setDirty(true);
  }

  async function save() {
    if (!game || !config || !savedConfig) return;
    setBusy(true);
    setMsg(null);
    try {
      const list = itemsRef.current.map((it) => {
        const { id: _id, released: _r, visible_from: _v, ...props } = it.feature.properties;
        return { type: 'Feature' as const, geometry: it.feature.geometry, properties: props };
      });
      const n = await api.saveMap(game.id, list);
      const changes = diffConfig(savedConfig, config);
      if (changes.length) {
        await updateConfig(game.id, config, changes);
        setSavedConfig(config);
      }
      setMsg({ ok: true, text: `Gespeichert: ${n} Zonen${changes.length ? ' und die Einstellungen zur Verkleinerung' : ''}.` });
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
      const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(search)}`, { headers: { 'Accept-Language': 'de' } });
      const j = (await r.json()) as { lat: string; lon: string; boundingbox?: string[] }[];
      if (!j.length) return setMsg({ ok: false, text: 'Ort nicht gefunden.' });
      const bb = j[0].boundingbox;
      if (bb) map.current.fitBounds([[+bb[0], +bb[2]], [+bb[1], +bb[3]]]);
      else map.current.setView([+j[0].lat, +j[0].lon], 15);
    } catch {
      setMsg({ ok: false, text: 'Suche nicht erreichbar.' });
    }
  }

  function locate() {
    navigator.geolocation?.getCurrentPosition((p) => map.current?.setView([p.coords.latitude, p.coords.longitude], 16), () => setMsg({ ok: false, text: 'Standort nicht verfügbar.' }), { timeout: 8000 });
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

  if (!game || !config) {
    return <div className="app">{msg ? <div className="notice error">{msg.text}</div> : <span className="muted">Lade …</span>}</div>;
  }

  const sel = items.find((x) => x.key === selected);
  const field1 = fieldOfPhase(features, 1);
  const km2 = areaKm2(field1);
  const has = (k: ZoneKind) => features.some((f) => f.properties.kind === k);
  const players = config.roles.players_max;
  const rec = recommendedKm2PerPlayer(config.game.duration_minutes);
  const issues = checkMap({
    features, exitEnabled: config.exit.enabled && config.win.mode !== 'letzter_ueberlebender', phases,
    autoShrink: shrink === 'auto', manualShrink: shrink === 'manuell', hqMinDistanceM: config.start.hq_min_distance_m,
    players, durationMinutes: config.game.duration_minutes,
  });
  const sticking = field1 ? items.filter((it) => INSIDE_FIELD.includes(it.feature.properties.kind) && isArea(it.feature) && outsideShare(asArea(it.feature), field1) > 0.01) : [];
  const unitLabel = config.zone.shrink_every_minutes > 0 ? 'Phase' : 'Spieltag';
  const draw = (p: Pending) => () => startDraw(p);

  return (
    <div className="app wide map-editor">
      <div className="topbar">
        <Link to={`/spiel/${id}`} className="button ghost small">←</Link>
        <h1>Karte</h1>
        {editable && <button className="primary small" onClick={save} disabled={busy || !dirty || !loaded}>{busy ? 'Speichere …' : dirty ? 'Speichern' : 'Gespeichert'}</button>}
      </div>
      {!editable && <div className="notice">Das Spiel läuft: die Karte ist gesperrt. Die Spielleitung kann im Spiel Sperrzonen ergänzen.</div>}

      {editable && (
        <div className="row" style={{ marginBottom: 8 }}>
          <input placeholder="Ort suchen (z. B. Zürich HB)" value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && findPlace()} style={{ flex: 1 }} />
          <button className="small" onClick={findPlace}>Suchen</button>
          <button className="small" onClick={locate} aria-label="Mein Standort">◎</button>
        </div>
      )}

      <div className="map-wrap">
        <div ref={el} className="map" style={{ height: '55dvh' }} />
        {pending && (
          <div className="draw-hint">
            <strong>{ICON[pending.kind]} {pending.kind === 'spielfeld' && pending.phase && pending.phase > 1 ? `Spielfeld ${unitLabel} ${pending.phase}` : ZONE_INFO[pending.kind].label}</strong>
            <div className="small">{TOOL_HINT[pending.tool]}</div>
            <div className="row">
              {pending.tool === 'Line' && <button className="small primary" onClick={finishLine}>Linie fertig</button>}
              <button className="small" onClick={cancelDraw}>Abbrechen</button>
            </div>
          </div>
        )}
      </div>
      <div className="muted small" style={{ margin: '6px 0' }}>
        {km2 > 0 ? `Spielfeld ${km2.toFixed(2)} km² · ${(km2 / Math.max(1, players)).toFixed(2)} km² pro Spieler (empfohlen ${rec[0]}–${rec[1]})` : 'Noch kein Spielfeld.'}
      </div>
      {msg && <div className={`notice ${msg.ok ? 'success' : 'error'}`} style={{ marginBottom: 12 }}>{msg.text}</div>}

      {sel && (
        <ZoneProps sel={sel} editable={editable} phases={phases} unitLabel={unitLabel} update={update} remove={remove} close={() => setSelected(null)} />
      )}

      {editable && (
        <div className="stack">
          <Step n={1} done={!!field1} title="Spielfeld" text="Der Bereich, in dem gespielt wird. Alle anderen Zonen liegen darin.">
            <div className="tool-row">
              <button onClick={draw({ kind: 'spielfeld', tool: 'Circle' })}>◯ Kreis</button>
              <button onClick={draw({ kind: 'spielfeld', tool: 'Rectangle' })}>▭ Rechteck</button>
              <button onClick={draw({ kind: 'spielfeld', tool: 'Polygon' })}>✎ Eigene Form</button>
            </div>
          </Step>

          <Step n={2} done={has('treffpunkt')} title="Treffpunkt" text="Hier sammeln sich alle vor dem Start. Muss im Spielfeld liegen.">
            <button onClick={draw({ kind: 'treffpunkt', tool: 'Marker' })} disabled={!field1}>📍 Treffpunkt antippen</button>
          </Step>

          <Step n={3} done={has('hq')} title="HQ der Hunter" text={`Hier warten die Hunter während des Vorsprungs. Mindestens ${config.start.hq_min_distance_m} m vom Treffpunkt entfernt.`}>
            <button onClick={draw({ kind: 'hq', tool: 'Marker' })}>🚓 HQ antippen</button>
          </Step>

          {config.exit.enabled && (
            <Step n={4} done={has('exit')} title="Exitpoint" text="Mehrere Kandidaten möglich, einer wird zufällig gewählt und erst gegen Schluss verraten.">
              <button onClick={draw({ kind: 'exit', tool: 'Marker' })} disabled={!field1}>🏁 Exit-Kandidat antippen</button>
            </Step>
          )}

          <Step n={config.exit.enabled ? 5 : 4} keepOpen done={shrink !== 'manuell' || phases < 2 || features.some((f) => f.properties.kind === 'spielfeld' && (f.properties.day_index ?? 0) > 1)}
            title="Verkleinerung über die Zeit" text="Das Spielfeld wird im Lauf des Spiels kleiner. Neue Grenzen werden vorher angekündigt und gestrichelt gezeigt.">
            <div className="chips">
              {([['aus', 'Nie'], ['auto', 'Automatisch'], ['manuell', 'Selbst zeichnen']] as const).map(([v, t]) => (
                <button key={v} type="button" className={`chip${shrink === v ? ' on' : ''}`} onClick={() => setZone('shrink_mode', v)}>{t}</button>
              ))}
            </div>
            {shrink !== 'aus' && (
              <>
                <div className="field">
                  <span>Wann wird es kleiner?</span>
                  <div className="chips">
                    <button type="button" className={`chip${config.zone.shrink_every_minutes === 0 ? ' on' : ''}`} onClick={() => setZone('shrink_every_minutes', 0)}>
                      Jeden Spieltag ({config.game.days})
                    </button>
                    <button type="button" className={`chip${config.zone.shrink_every_minutes > 0 ? ' on' : ''}`}
                      onClick={() => setZone('shrink_every_minutes', config.zone.shrink_every_minutes || Math.max(10, Math.round(config.game.duration_minutes / 4 / 5) * 5))}>
                      Alle paar Minuten
                    </button>
                  </div>
                </div>
                {config.zone.shrink_every_minutes > 0 && (
                  <NumberRow label="Alle (Minuten)" value={config.zone.shrink_every_minutes} min={5} max={1440} step={5} onChange={(v) => setZone('shrink_every_minutes', v)} />
                )}
                <div className="muted small">{phases} {unitLabel === 'Phase' ? 'Phasen' : 'Spieltage'} → das Spielfeld ändert sich {Math.max(0, phases - 1)}-mal.</div>
                {shrink === 'auto' && (
                  <NumberRow label="Kleiner um (% Fläche je Schritt)" value={config.zone.auto_shrink_percent} min={1} max={80} step={5} onChange={(v) => setZone('auto_shrink_percent', v)} />
                )}
                <NumberRow label="Vorher ankündigen (Minuten)" value={config.zone.shrink_announce_minutes} min={0} max={1440} step={5} onChange={(v) => setZone('shrink_announce_minutes', v)} />
                <NumberRow label="Zeit zum Rauslaufen (Minuten)" value={config.zone.shrink_grace_minutes} min={0} max={120} step={1} onChange={(v) => setZone('shrink_grace_minutes', v)} />
                {shrink === 'auto' && <div className="muted small">Es wird Richtung Exitpoint kleiner (ohne Exit Richtung Mitte).</div>}
                {shrink === 'manuell' && phases > 1 && (
                  <div className="stack">
                    {Array.from({ length: phases - 1 }, (_, i) => i + 2).map((p) => {
                      const own = features.some((f) => f.properties.kind === 'spielfeld' && f.properties.day_index === p);
                      return (
                        <div key={p} className="phase-row">
                          <span className="spacer">{own ? '✓' : '○'} {unitLabel} {p}</span>
                          <button className="small" onClick={() => copyShrunk(p, 25)}>Vorherige −25 %</button>
                          <button className="small" onClick={draw({ kind: 'spielfeld', tool: 'Polygon', phase: p })}>✎ Zeichnen</button>
                        </div>
                      );
                    })}
                    <div className="muted small">Tipp: „Vorherige −25 %“ legt eine kleinere Kopie an, deren Ecken du danach verschieben kannst.</div>
                  </div>
                )}
                {phases > 1 && (
                  <label className="field">
                    <span>Vorschau: {unitLabel} {preview} {phaseFields[preview - 1] ? `(${areaKm2(phaseFields[preview - 1]).toFixed(2)} km²)` : ''}</span>
                    <input type="range" min={1} max={phases} value={preview} onChange={(e) => setPreview(+e.target.value)} />
                  </label>
                )}
              </>
            )}
          </Step>

          <Step n={config.exit.enabled ? 6 : 5} done={has('sperrzone')} optional title="Gefahrenzonen (Sperrzonen)"
            text="Orte, die nie betreten werden dürfen: Autobahn, Gleise, Gewässer, Schulen, Baustellen. Sie werden rot schraffiert mit Warnsymbol gezeigt, und Spieler werden beim Annähern gewarnt.">
            <button onClick={loadHazards} disabled={!field1 || hazardBusy}>{hazardBusy ? 'Suche …' : '🔎 Gefahrenstellen automatisch vorschlagen'}</button>
            {hazards && hazards.length > 0 && (
              <div className="stack">
                <div className="row"><strong className="spacer">{hazards.length} Vorschläge</strong><button className="small primary" onClick={() => takeHazards(hazards)}>Alle übernehmen</button></div>
                {hazards.map((h) => (
                  <div key={h.key} className="phase-row">
                    <span className="spacer">{restrictedInfo(h.type).icon} {h.name} <span className="muted small">({restrictedInfo(h.type).label})</span></span>
                    <button className="small" onClick={() => takeHazards([h])}>Übernehmen</button>
                  </div>
                ))}
              </div>
            )}
            <label className="field">
              Art der Gefahr
              <select value={restrictedType} onChange={(e) => setRestrictedType(e.target.value)}>
                {Object.entries(RESTRICTED_TYPES).map(([k, v]) => <option key={k} value={k}>{v.icon} {v.label}</option>)}
              </select>
            </label>
            <div className="tool-row">
              <button onClick={draw({ kind: 'sperrzone', tool: 'Polygon', restrictedType })} disabled={!field1}>✎ Fläche</button>
              <button onClick={draw({ kind: 'sperrzone', tool: 'Line', restrictedType, widthM: lineWidth })} disabled={!field1}>〰 Entlang Strasse/Gleis</button>
            </div>
            <NumberRow label="Breite bei Linien (m)" value={lineWidth} min={5} max={200} step={5} onChange={setLineWidth} />
          </Step>

          <Step n={config.exit.enabled ? 7 : 6} done={['sicher', 'kern', 'aussen', 'center', 'sektion', 'startzone'].some((k) => has(k as ZoneKind))} optional title="Weitere Zonen"
            text="Alle liegen innerhalb des Spielfelds. Was darüber hinausragt, wird automatisch abgeschnitten.">
            <div className="kind-grid">
              {(['sicher', 'kern', 'aussen', 'center', 'sektion', 'startzone'] as ZoneKind[]).map((k) => (
                <button key={k} className="kind-btn" onClick={draw({ kind: k, tool: 'Polygon' })} disabled={!field1}>
                  <span>{ICON[k]} {ZONE_INFO[k].label}</span>
                  <span className="muted small">{ZONE_INFO[k].help}</span>
                </button>
              ))}
            </div>
            {config.zone.sections_per_player && <div className="muted small">Sektionen pro Spieler sind aktiv: zeichne {players} Sektionen.</div>}
          </Step>

          <div className="card stack">
            <h2 style={{ margin: 0 }}>Prüfung</h2>
            {issues.length === 0 && <div className="notice success">Alles in Ordnung.</div>}
            {issues.map((i, n) => <div key={n} className={`notice ${i.level === 'error' ? 'error' : 'warning'}`}>{i.text}</div>)}
            {sticking.length > 0 && (
              <div className="notice warning">
                {sticking.length} Zone(n) ragen über das Spielfeld hinaus.{' '}
                <button className="small" onClick={clipAll}>Zuschneiden</button>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="card stack" style={{ marginTop: 12 }}>
        <h2 style={{ margin: 0 }}>Alle Zonen ({items.length})</h2>
        {items.length === 0 && <span className="muted small">Noch keine Zonen.</span>}
        <ul className="list zone-list">
          {items.map((it) => {
            const p = it.feature.properties;
            const size = it.feature.geometry.type === 'Point' ? `${p.radius_m ?? 30} m` : `${areaKm2(asArea(it.feature)).toFixed(2)} km²`;
            return (
              <li key={it.key} className={it.key === selected ? 'selected' : ''} onClick={() => select(it.key)}>
                <span>{p.kind === 'sperrzone' ? restrictedInfo(p.restricted_type).icon : ICON[p.kind]}</span>
                <span className="spacer">
                  {p.name || ZONE_INFO[p.kind].label}
                  {p.kind === 'spielfeld' && p.day_index ? ` · ${unitLabel} ${p.day_index}` : ''}
                  {p.kind === 'sperrzone' && <span className="muted small"> · {restrictedInfo(p.restricted_type).label}</span>}
                </span>
                <span className="muted small">{size}</span>
              </li>
            );
          })}
        </ul>
      </div>

      {editable && (
        <div className="row" style={{ marginTop: 12 }}>
          <button className="small" onClick={exportJson}>GeoJSON exportieren</button>
          <label className="button small">
            GeoJSON importieren
            <input type="file" accept=".json,.geojson,application/geo+json" hidden disabled={!loaded} onChange={(e) => e.target.files?.[0] && importJson(e.target.files[0])} />
          </label>
        </div>
      )}

      {editable && dirty && (
        <div className="save-bar">
          <span className="spacer small">Ungespeicherte Änderungen</span>
          <button className="primary" onClick={save} disabled={busy || !loaded}>{busy ? 'Speichere …' : 'Speichern'}</button>
        </div>
      )}
    </div>
  );
}

function Step({ n, title, text, done, optional, keepOpen, children }: { n: number; title: string; text: string; done: boolean; optional?: boolean; keepOpen?: boolean; children: ReactNode }) {
  // Nur beim ersten Anzeigen: erledigte Schritte zugeklappt, danach entscheidet der Nutzer.
  const [open, setOpen] = useState(keepOpen || !done);
  return (
    <details className={`card step${done ? ' done' : ''}`} open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>
        <span className="step-n">{done ? '✓' : n}</span>
        <span className="spacer"><strong>{title}</strong>{optional && <span className="muted small"> (optional)</span>}</span>
      </summary>
      <div className="stack" style={{ marginTop: 8 }}>
        <div className="muted small">{text}</div>
        {children}
      </div>
    </details>
  );
}

function NumberRow({ label, value, min, max, step, onChange }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void }) {
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  return (
    <div className="quick-row">
      <span className="spacer">{label}</span>
      <div className="stepper">
        <button type="button" aria-label={`${label} weniger`} disabled={value <= min} onClick={() => onChange(clamp(value - step))}>−</button>
        <input type="number" inputMode="numeric" aria-label={label} value={value} min={min} max={max}
          onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v)) onChange(clamp(Math.round(v))); }} />
        <button type="button" aria-label={`${label} mehr`} disabled={value >= max} onClick={() => onChange(clamp(value + step))}>+</button>
      </div>
    </div>
  );
}

function ZoneProps({ sel, editable, phases, unitLabel, update, remove, close }: {
  sel: Item; editable: boolean; phases: number; unitLabel: string;
  update: (key: string, patch: Partial<MapFeature['properties']>) => void; remove: (key: string) => void; close: () => void;
}) {
  const p = sel.feature.properties;
  const isPoint = sel.feature.geometry.type === 'Point';
  const areaKinds = ZONE_KINDS.filter((k) => !ZONE_INFO[k].point);
  return (
    <div className="card stack zone-props">
      <div className="row">
        <h2 className="spacer" style={{ margin: 0 }}>{p.kind === 'sperrzone' ? restrictedInfo(p.restricted_type).icon : ICON[p.kind]} {p.name || ZONE_INFO[p.kind].label}</h2>
        <button className="ghost small" onClick={close} aria-label="Schliessen">✕</button>
      </div>
      {editable && !isPoint && <div className="muted small">Ecken ziehen zum Ändern, Mitte einer Kante ziehen für eine neue Ecke, ganze Zone verschieben mit Ziehen.</div>}
      {editable && isPoint && <div className="muted small">Zum Verschieben den Kreis ziehen.</div>}
      <label className="field">
        Name
        <input value={p.name ?? ''} disabled={!editable} onChange={(e) => update(sel.key, { name: e.target.value })} />
      </label>
      {!isPoint && (
        <label className="field">
          Art
          <select value={p.kind} disabled={!editable} onChange={(e) => update(sel.key, { kind: e.target.value as ZoneKind })}>
            {areaKinds.map((k) => <option key={k} value={k}>{ICON[k]} {ZONE_INFO[k].label}</option>)}
          </select>
        </label>
      )}
      {p.kind === 'sperrzone' && (
        <>
          <label className="field">
            Art der Gefahr
            <select value={p.restricted_type ?? 'andere'} disabled={!editable} onChange={(e) => update(sel.key, { restricted_type: e.target.value })}>
              {Object.entries(RESTRICTED_TYPES).map(([k, v]) => <option key={k} value={k}>{v.icon} {v.label}</option>)}
            </select>
          </label>
          <label className="check">
            <input type="checkbox" disabled={!editable} checked={!!p.crossing_allowed} onChange={(e) => update(sel.key, { crossing_allowed: e.target.checked })} />
            <span>Überqueren erlaubt (z. B. Brücke), Aufenthalt nicht</span>
          </label>
        </>
      )}
      {isPoint && (
        <label className="field">
          Radius: {p.radius_m ?? 30} m
          <input type="range" min={10} max={p.kind === 'hq' ? 500 : 300} step={5} disabled={!editable} value={p.radius_m ?? 30}
            onChange={(e) => update(sel.key, { radius_m: +e.target.value })} />
        </label>
      )}
      {p.kind === 'spielfeld' && phases > 1 && (
        <>
          <label className="field">
            Gilt ab
            <select value={p.day_index ?? ''} disabled={!editable} onChange={(e) => update(sel.key, { day_index: e.target.value ? +e.target.value : null })}>
              <option value="">Von Anfang an</option>
              {Array.from({ length: phases }, (_, i) => <option key={i} value={i + 1}>{unitLabel} {i + 1}</option>)}
            </select>
          </label>
          {(p.day_index ?? 1) > 1 && (
            <label className="check">
              <input type="checkbox" disabled={!editable} checked={!!p.grows} onChange={(e) => update(sel.key, { grows: e.target.checked })} />
              <span>Wird bewusst grösser (statt kleiner)</span>
            </label>
          )}
        </>
      )}
      {['center', 'kern', 'aussen'].includes(p.kind) && (
        <label className="field">
          Eigenes Ping-Intervall (min, leer = Regel)
          <input type="number" min={1} max={720} disabled={!editable} value={p.ping_interval_override ?? ''}
            onChange={(e) => update(sel.key, { ping_interval_override: e.target.value ? +e.target.value : null })} />
        </label>
      )}
      {editable && <button className="ghost" onClick={() => remove(sel.key)}>🗑 Zone löschen</button>}
    </div>
  );
}
