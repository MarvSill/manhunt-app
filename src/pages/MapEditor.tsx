import '../lib/leafletGlobal';
import '@geoman-io/leaflet-geoman-free';
import '@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css';
import L from 'leaflet';
import { addMapButtons } from '../lib/mapControls';
import 'leaflet/dist/leaflet.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import Info from '../components/Info';
import { esc, pointIcon, zoneBadge, zoneStyle } from '../components/MapView';
import { STEP_HELP, ZONE_HELP } from '../shared/help';
import { api, ZONE_INFO, ZONE_KINDS, type MapFeature, type ZoneKind } from '../lib/engine';
import {
  areaKm2, bandFromLine, centerOf, checkMap, circleWithArea, clipTo, fieldOfPhase, INSIDE_FIELD, middleOf, outsideShare, pointAtDistance, pointInside,
  recommendedKm2PerPlayer, RESTRICTED_TYPES, restrictedInfo, shrinkArea, spreadPoints, unionAll, type Area,
} from '../lib/geo';
import { diffConfig, getGame, updateConfig, type Game } from '../lib/games';
import { suggestHazards, type HazardSuggestion } from '../lib/hazards';
import { errorText } from '../lib/supabase';
import { gameConfigSchema, parseConfig, type GameConfig } from '../shared/config';
import { durationText, fitTimes, timeLimits } from '../shared/timeRules';

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
  const [stepIdx, setStepIdx] = useState(0);
  const stepPicked = useRef(false);
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
  const editableRef = useRef(editable);
  editableRef.current = editable;
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
      l = L.marker([lat, lng], { icon: pointIcon(feature.properties.kind), draggable: editableRef.current });
    } else {
      l = L.geoJSON(feature as GeoJSON.Feature).getLayers()[0];
    }
    g.addLayer(l);
    const it: Item = { key: newKey(), feature, layer: l };
    restyle(it);
    l.on('click', () => setSelected(it.key));
    const changed = () => {
      setItems((prev) => prev.map((x) => (x.key === it.key ? { ...x, feature: layerToFeature(l, x.feature.properties) } : x)));
      setDirty(true);
    };
    l.on('pm:edit', changed);
    l.on('dragend', changed);
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
          // Alte Spiele: unstimmige Zeiten gleich anpassen (wird mit der Karte gespeichert).
          const fit = fitTimes(c);
          setConfig(fit.config);
          if (fit.fixes.length && ['entwurf', 'geplant', 'lobby'].includes(g.status)) {
            setDirty(true);
            setMsg({ ok: true, text: 'Angepasst: ' + fit.fixes.map((f) => f.message).join(' ') });
          }
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
    addMapButtons(m, {
      wrap: () => el.current?.parentElement ?? null,
      fit: () => {
        const b = group.current?.getBounds();
        return b?.isValid() ? b : null;
      },
    });
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

  // Beim Öffnen beim ersten offenen Schritt beginnen.
  useEffect(() => {
    if (!loaded || !config || stepPicked.current) return;
    stepPicked.current = true;
    const f = itemsRef.current.map((x) => x.feature);
    const has = (k: ZoneKind) => f.some((x) => x.properties.kind === k);
    const exit = config.exit.enabled;
    const order: boolean[] = [!!fieldOfPhase(f, 1), has('treffpunkt'), has('hq'), ...(exit ? [has('exit')] : [])];
    const open = order.findIndex((d) => !d);
    setStepIdx(open >= 0 ? open : (exit ? 8 : 7) - 1);
  }, [loaded, config]);

  // Symbole auf Gefahren- und Schutzzonen
  useEffect(() => {
    const b = badges.current;
    if (!b) return;
    b.clearLayers();
    for (const f of features) if (f.properties.kind === 'sperrzone' || f.properties.kind === 'sicher') b.addLayer(zoneBadge(f));
    // Gestrichelte Kreise: Mindestabstand um das HQ, Ankunftsradius um den Exit.
    for (const f of features) {
      if (f.geometry.type !== 'Point' || !config) continue;
      const [lng, lat] = (f.geometry as GeoJSON.Point).coordinates;
      const k = f.properties.kind;
      const r = k === 'hq' ? config.start.hq_min_distance_m : k === 'exit' ? config.exit.radius_m : 0;
      if (!r) continue;
      const ring = L.circle([lat, lng], { radius: r, color: ZONE_INFO[k].color, weight: 2, dashArray: '6 6', fill: false, interactive: false });
      if (k === 'hq') ring.bindTooltip(`${r} m Mindestabstand zum Treffpunkt`, { direction: 'top', opacity: 0.8 });
      b.addLayer(ring);
    }
  }, [features, config]);

  // Gewählte Zone bearbeitbar machen
  useEffect(() => {
    for (const it of items) {
      if (it.layer instanceof L.Marker) continue;
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
    m.doubleClickZoom.enable();
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
    setDirty(true);
    // Pflicht-Schritte: nach dem Setzen gleich weiter zum nächsten Schritt.
    if (p.kind === 'spielfeld' && !p.phase && !field1) setStepIdx(1);
    if (p.kind === 'treffpunkt') setStepIdx(2);
    if (p.kind === 'hq') setStepIdx(3);
  };

  function startDraw(p: Pending) {
    const m = map.current;
    if (!m || !editable) return;
    m.pm.disableDraw();
    m.doubleClickZoom.disable();
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
    map.current?.doubleClickZoom.enable();
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
    if (!parsed.success) return;
    // Zeiten müssen in die Spieldauer passen.
    const fit = fitTimes(parsed.data);
    setConfig(fit.config);
    if (fit.fixes.length) setMsg({ ok: true, text: fit.fixes.map((f) => f.message).join(' ') });
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
        // Punkte: Radius kommt aus den Regeln (HQ-Kreis, Exit-Radius).
        if (props.kind === 'hq') props.radius_m = config.start.hq_radius_m;
        if (props.kind === 'exit') props.radius_m = config.exit.radius_m;
        if (props.kind === 'treffpunkt') props.radius_m = 30;
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

  /** Punkt (Treffpunkt, HQ, Exit) setzen; Treffpunkt und HQ gibt es nur einmal. */
  function placePoints(kind: ZoneKind, coords: GeoJSON.Position[], radius: number) {
    const replace = kind === 'treffpunkt' || kind === 'hq';
    if (replace) for (const old of itemsRef.current.filter((x) => x.feature.properties.kind === kind)) group.current?.removeLayer(old.layer);
    const added = coords.map((c) => addItem({ type: 'Feature', geometry: { type: 'Point', coordinates: c }, properties: { kind, name: '', radius_m: radius } }));
    const next = [...itemsRef.current.filter((x) => !(replace && x.feature.properties.kind === kind)), ...added];
    itemsRef.current = next;
    setItems(next);
    setDirty(true);
  }

  const blockedArea = () => unionAll(itemsRef.current.map((x) => x.feature).filter((f) => f.properties.kind === 'sperrzone' && isArea(f)).map(asArea));
  const meetPoint = () => {
    const m = itemsRef.current.find((x) => x.feature.properties.kind === 'treffpunkt' && x.feature.geometry.type === 'Point');
    return m ? (m.feature.geometry as GeoJSON.Point).coordinates : null;
  };

  /** Spielfeld als Kreis mit gewünschter Fläche in der Kartenmitte. */
  function quickField(km2: number) {
    const m = map.current;
    if (!m) return;
    const c = m.getCenter();
    for (const old of itemsRef.current.filter((x) => x.feature.properties.kind === 'spielfeld' && !x.feature.properties.day_index)) group.current?.removeLayer(old.layer);
    const shape = circleWithArea([c.lng, c.lat], km2);
    const it = addItem({ type: 'Feature', geometry: shape.geometry, properties: { kind: 'spielfeld', name: 'Spielfeld' } });
    const next = [...itemsRef.current.filter((x) => !(x.feature.properties.kind === 'spielfeld' && !x.feature.properties.day_index)), it];
    itemsRef.current = next;
    setItems(next);
    setDirty(true);
    m.fitBounds((it.layer as L.Polygon).getBounds(), { padding: [20, 20] });
    setMsg({ ok: true, text: 'Spielfeld erstellt. Du kannst es antippen und die Ecken verschieben.' });
    setStepIdx(1);
  }

  function autoMeet(): GeoJSON.Position | null {
    const f = fieldOfPhase(itemsRef.current.map((x) => x.feature), 1);
    if (!f) return null;
    const pt = middleOf(f);
    placePoints('treffpunkt', [pt], 30);
    return pt;
  }

  function autoHq(meet?: GeoJSON.Position | null) {
    const f = fieldOfPhase(itemsRef.current.map((x) => x.feature), 1);
    const from = meet ?? meetPoint() ?? (f ? middleOf(f) : null);
    if (!from || !config) return;
    placePoints('hq', [pointAtDistance(from, config.start.hq_min_distance_m + 50, f, blockedArea())], 100);
  }

  function autoExits(n: number, meet?: GeoJSON.Position | null) {
    const feats = itemsRef.current.map((x) => x.feature);
    const f = fieldOfPhase(feats, phases) ?? fieldOfPhase(feats, 1);
    if (!f) return;
    for (const old of itemsRef.current.filter((x) => x.feature.properties.kind === 'exit')) group.current?.removeLayer(old.layer);
    itemsRef.current = itemsRef.current.filter((x) => x.feature.properties.kind !== 'exit');
    const from = meet ?? meetPoint();
    placePoints('exit', spreadPoints(f, n, from ? [from] : [], blockedArea()), 30);
  }

  function autoPoints() {
    const meet = autoMeet();
    autoHq(meet);
    if (config?.exit.enabled) autoExits(3, meet);
    setMsg({ ok: true, text: 'Treffpunkt, HQ' + (config?.exit.enabled ? ' und 3 Exit-Kandidaten' : '') + ' gesetzt. Zum Verschieben antippen und ziehen.' });
    setStepIdx(config?.exit.enabled ? 4 : 3);
  }

  function goStep(i: number) {
    cancelDraw();
    setSelected(null);
    setMsg(null);
    setStepIdx(Math.max(0, i));
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
  const limits = timeLimits(config);
  const draw = (p: Pending) => () => startDraw(p);
  const others: ZoneKind[] = ['sicher', 'kern', 'aussen', 'center', 'sektion', 'startzone'];
  const steps: { id: string; icon: string; title: string; text: string; done: boolean; optional?: boolean }[] = [
    { id: 'feld', icon: '🟩', title: 'Spielfeld', text: 'Der Bereich, in dem gespielt wird. Alle anderen Zonen liegen darin.', done: !!field1 },
    { id: 'treff', icon: '📍', title: 'Treffpunkt', text: 'Hier sammeln sich alle vor dem Start. Muss im Spielfeld liegen.', done: has('treffpunkt') },
    { id: 'hq', icon: '🚓', title: 'HQ', text: `Hier warten die Hunter während des Vorsprungs. Mindestens ${config.start.hq_min_distance_m} m vom Treffpunkt entfernt.`, done: has('hq') },
    ...(config.exit.enabled ? [{ id: 'exit', icon: '🏁', title: 'Exit', text: 'Mehrere Kandidaten möglich. Einer wird zufällig gewählt und erst gegen Schluss verraten.', done: has('exit') }] : []),
    { id: 'klein', icon: '⏳', title: 'Kleiner werden', text: 'Soll das Spielfeld im Lauf des Spiels kleiner werden? Neue Grenzen werden vorher angekündigt und gestrichelt gezeigt.', done: shrink !== 'aus', optional: true },
    { id: 'gefahr', icon: '⚠️', title: 'Gefahren', text: 'Orte, die nie betreten werden dürfen: Autobahn, Gleise, Gewässer, Schulen, Baustellen. Sie werden rot schraffiert mit Warnsymbol gezeigt, und Spieler werden beim Annähern gewarnt.', done: has('sperrzone'), optional: true },
    { id: 'mehr', icon: '🧩', title: 'Mehr Zonen', text: 'Schutzzonen, Kern-Gebiete und mehr. Alle liegen im Spielfeld; was hinausragt, wird abgeschnitten.', done: others.some(has), optional: true },
    { id: 'fertig', icon: '✅', title: 'Prüfen', text: 'Hier siehst du, ob die Karte bereit ist.', done: !issues.some((i) => i.level === 'error') },
  ];
  const cur = steps[Math.min(stepIdx, steps.length - 1)];
  const sizes = (() => {
    const n = Math.max(2, players);
    return [
      { label: 'Klein', km2: n * rec[0] },
      { label: 'Mittel', km2: n * ((rec[0] + rec[1]) / 2), recommended: true },
      { label: 'Gross', km2: n * rec[1] },
    ];
  })();
  const legend = (['spielfeld', 'sperrzone', 'sicher', 'kern', 'treffpunkt', 'hq', 'exit'] as ZoneKind[]).filter((k) => k === 'spielfeld' || has(k));

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
        <div ref={el} className="map" style={{ height: '48dvh' }} />
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
      <div className="legend">
        {legend.map((k) => (
          <span key={k}><i className={`swatch${k === 'sperrzone' ? ' danger' : ''}`} style={{ background: k === 'sperrzone' ? undefined : ZONE_INFO[k].color }} />{ZONE_INFO[k].label}</span>
        ))}
        {shrink !== 'aus' && phases > 1 && <span><i className="swatch dashed" />spätere Grenze</span>}
      </div>
      <div className="muted small" style={{ margin: '6px 0' }}>
        {km2 > 0 ? `Spielfeld ${km2.toFixed(2)} km² · ${(km2 / Math.max(1, players)).toFixed(2)} km² pro Spieler (empfohlen ${rec[0]}–${rec[1]})` : 'Noch kein Spielfeld.'}
      </div>
      {msg && <div className={`notice ${msg.ok ? 'success' : 'error'}`} style={{ marginBottom: 12 }}>{msg.text}</div>}

      {sel && (
        <ZoneProps sel={sel} editable={editable} phases={phases} unitLabel={unitLabel} update={update} remove={remove} close={() => setSelected(null)} />
      )}

      {editable && (
        <div className="wizard card stack">
          <div className="wizard-steps" role="tablist">
            {steps.map((st, i) => (
              <button key={st.id} type="button" role="tab" aria-selected={i === stepIdx} aria-label={st.title}
                className={`wizard-dot${i === stepIdx ? ' on' : ''}${st.done ? ' done' : ''}`} onClick={() => goStep(i)}>
                <span>{st.done && i !== stepIdx ? '✓' : st.icon}</span>
                <small>{st.title}</small>
              </button>
            ))}
          </div>
          <div>
            <div className="muted small">Schritt {stepIdx + 1} von {steps.length}{cur.optional ? ' · freiwillig' : ''}</div>
            <h2 style={{ margin: '2px 0 0' }}>{cur.icon} {cur.title} <Info title={cur.title} text={STEP_HELP[cur.id]} /></h2>
            <div className="muted small" style={{ marginTop: 4 }}>{cur.text}</div>
          </div>

          {cur.id === 'feld' && (
            <>
              <div className="muted small"><strong>Am einfachsten:</strong> Karte auf den Ort schieben (oder oben suchen), dann Grösse antippen.</div>
              <div className="tool-row size-row">
                {sizes.map((z) => (
                  <button key={z.label} className={`size-btn${z.recommended ? ' primary' : ''}`} onClick={() => quickField(z.km2)}>
                    <strong>{z.label}</strong><span className="small">{z.km2 < 1 ? `${Math.round(z.km2 * 100)} ha` : `${z.km2.toFixed(1)} km²`}{z.recommended ? ' · empfohlen' : ''}</span>
                  </button>
                ))}
              </div>
              <div className="muted small">Oder selbst zeichnen:</div>
              <div className="tool-row">
                <button onClick={draw({ kind: 'spielfeld', tool: 'Circle' })}>◯ Kreis</button>
                <button onClick={draw({ kind: 'spielfeld', tool: 'Rectangle' })}>▭ Rechteck</button>
                <button onClick={draw({ kind: 'spielfeld', tool: 'Polygon' })}>✎ Eigene Form</button>
              </div>
              {field1 && <div className="muted small">Tipp: Tippe das Spielfeld an, um die Ecken zu verschieben.</div>}
            </>
          )}

          {cur.id === 'treff' && (
            <>
              <button className="primary" onClick={autoPoints} disabled={!field1}>✨ Treffpunkt, HQ{config.exit.enabled ? ' und Exits' : ''} automatisch setzen</button>
              <button onClick={draw({ kind: 'treffpunkt', tool: 'Marker' })} disabled={!field1}>📍 Treffpunkt selbst antippen</button>
            </>
          )}

          {cur.id === 'hq' && (
            <>
              <button className="primary" onClick={() => autoHq()} disabled={!field1}>✨ HQ automatisch setzen ({config.start.hq_min_distance_m + 50} m vom Treffpunkt)</button>
              <button onClick={draw({ kind: 'hq', tool: 'Marker' })}>🚓 HQ selbst antippen</button>
            </>
          )}

          {cur.id === 'exit' && (
            <>
              <button className="primary" onClick={() => autoExits(3)} disabled={!field1}>✨ 3 Exit-Kandidaten automatisch setzen</button>
              <button onClick={draw({ kind: 'exit', tool: 'Marker' })} disabled={!field1}>🏁 Exit-Kandidat selbst antippen</button>
              <div className="muted small">{features.filter((f) => f.properties.kind === 'exit').length} Kandidaten gesetzt.</div>
            </>
          )}

          {cur.id === 'klein' && (
            <>
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
                    {config.game.days > 1 && (
                      <button type="button" className={`chip${config.zone.shrink_every_minutes === 0 ? ' on' : ''}`} onClick={() => setZone('shrink_every_minutes', 0)}>
                        Jeden Spieltag ({config.game.days})
                      </button>
                    )}
                    <button type="button" className={`chip${config.zone.shrink_every_minutes > 0 ? ' on' : ''}`}
                      onClick={() => setZone('shrink_every_minutes', config.zone.shrink_every_minutes || Math.max(10, Math.round(config.game.duration_minutes / 4 / 5) * 5))}>
                      {config.game.days > 1 ? 'Alle paar Minuten' : `Alle paar Minuten (Spiel dauert ${durationText(config.game.duration_minutes)})`}
                    </button>
                  </div>
                </div>
                {config.zone.shrink_every_minutes > 0 && (
                  <NumberRow label="Alle (Minuten)" value={config.zone.shrink_every_minutes} min={5} max={limits['zone.shrink_every_minutes']?.max ?? 1440} step={5} onChange={(v) => setZone('shrink_every_minutes', v)} />
                )}
                <div className="muted small">{phases} {unitLabel === 'Phase' ? 'Phasen' : 'Spieltage'} → das Spielfeld ändert sich {Math.max(0, phases - 1)}-mal.</div>
                {shrink === 'auto' && (
                  <NumberRow label="Kleiner um (% Fläche je Schritt)" value={config.zone.auto_shrink_percent} min={1} max={80} step={5} onChange={(v) => setZone('auto_shrink_percent', v)} />
                )}
                <NumberRow label="Vorher ankündigen (Minuten)" value={config.zone.shrink_announce_minutes} min={0} max={limits['zone.shrink_announce_minutes']?.max ?? 1440} step={5} onChange={(v) => setZone('shrink_announce_minutes', v)} />
                <NumberRow label="Zeit zum Rauslaufen (Minuten)" value={config.zone.shrink_grace_minutes} min={0} max={limits['zone.shrink_grace_minutes']?.max ?? 120} step={1} onChange={(v) => setZone('shrink_grace_minutes', v)} />
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
            </>
          )}

          {cur.id === 'gefahr' && (
            <>
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
            </>
          )}

          {cur.id === 'mehr' && (
            <>
            <div className="kind-grid">
              {(['sicher', 'kern', 'aussen', 'center', 'sektion', 'startzone'] as ZoneKind[]).map((k) => (
                <div key={k} className="kind-item">
                  <button className="kind-btn" onClick={draw({ kind: k, tool: 'Polygon' })} disabled={!field1}>
                    <span>{ICON[k]} {ZONE_INFO[k].label}</span>
                    <span className="muted small">{ZONE_INFO[k].help}</span>
                  </button>
                  <span className="kind-info"><Info title={ZONE_HELP[k].title} text={ZONE_HELP[k].text} /></span>
                </div>
              ))}
            </div>
            {config.zone.sections_per_player && <div className="muted small">Sektionen pro Spieler sind aktiv: zeichne {players} Sektionen.</div>}
            </>
          )}

          {cur.id === 'fertig' && (
            <>
              {issues.length === 0 && <div className="notice success">Alles in Ordnung. Die Karte ist bereit.</div>}
              {issues.map((i, n) => <div key={n} className={`notice ${i.level === 'error' ? 'error' : 'warning'}`}>{i.text}</div>)}
              {sticking.length > 0 && (
                <div className="notice warning">
                  {sticking.length} Zone(n) ragen über das Spielfeld hinaus.{' '}
                  <button className="small" onClick={clipAll}>Zuschneiden</button>
                </div>
              )}
              {dirty && <button className="primary" onClick={save} disabled={busy || !loaded}>{busy ? 'Speichere …' : 'Karte speichern'}</button>}
            </>
          )}

          <div className="row wizard-nav">
            <button onClick={() => goStep(stepIdx - 1)} disabled={stepIdx === 0}>← Zurück</button>
            <span className="spacer" />
            {stepIdx < steps.length - 1 && (
              <button className={cur.done || cur.optional ? 'primary' : ''} onClick={() => goStep(stepIdx + 1)}>
                {cur.done || cur.optional ? 'Weiter →' : 'Überspringen →'}
              </button>
            )}
          </div>
        </div>
      )}

      <details className="card" style={{ marginTop: 12 }}>
        <summary><strong>Alle Zonen ({items.length})</strong> <span className="muted small">· zum Ändern antippen</span></summary>
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
        {editable && (
          <div className="row" style={{ marginTop: 12 }}>
            <button className="small" onClick={exportJson}>GeoJSON exportieren</button>
            <label className="button small">
              GeoJSON importieren
              <input type="file" accept=".json,.geojson,application/geo+json" hidden disabled={!loaded} onChange={(e) => e.target.files?.[0] && importJson(e.target.files[0])} />
            </label>
          </div>
        )}
      </details>

      {editable && dirty && (
        <div className="save-bar">
          <span className="spacer small">Ungespeicherte Änderungen</span>
          <button className="primary" onClick={save} disabled={busy || !loaded}>{busy ? 'Speichere …' : 'Speichern'}</button>
        </div>
      )}
    </div>
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
        <h2 className="spacer" style={{ margin: 0 }}>{p.kind === 'sperrzone' ? restrictedInfo(p.restricted_type).icon : ICON[p.kind]} {p.name || ZONE_INFO[p.kind].label} <Info title={ZONE_HELP[p.kind].title} text={ZONE_HELP[p.kind].text} /></h2>
        <button className="ghost small" onClick={close} aria-label="Schliessen">✕</button>
      </div>
      {editable && !isPoint && <div className="muted small">Ecken ziehen zum Ändern, Mitte einer Kante ziehen für eine neue Ecke, ganze Zone verschieben mit Ziehen.</div>}
      {editable && isPoint && <div className="muted small">Zum Verschieben das Symbol gedrückt halten und ziehen.</div>}
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
