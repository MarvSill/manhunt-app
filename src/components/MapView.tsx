import L from 'leaflet';
import { addMapButtons } from '../lib/mapControls';
import 'leaflet/dist/leaflet.css';
import { useEffect, useRef } from 'react';
import { pointOnFeature } from '@turf/turf';
import { ZONE_INFO, type MapFeature } from '../lib/engine';
import { restrictedInfo } from '../lib/geo';

export interface Marker {
  id: string;
  lat: number;
  lng: number;
  label: string;
  color: string;
  kind: 'me' | 'player' | 'hunter' | 'ping' | 'fake' | 'challenge' | 'emergency' | 'hotel' | 'pick';
  accuracy?: number | null;
  opacity?: number;
  pulse?: boolean;
  popup?: string;
}

interface Props {
  zones: MapFeature[];
  markers: Marker[];
  lines?: { id: string; points: [number, number][]; color: string }[];
  onClick?: (lat: number, lng: number) => void;
  fitKey?: string | number;
  height?: string;
  showDay?: number;
}

export function zoneStyle(f: MapFeature, day?: number): L.PathOptions {
  const k = f.properties.kind;
  const info = ZONE_INFO[k] ?? ZONE_INFO.spielfeld;
  const color = f.properties.color || info.color;
  const future = k === 'spielfeld' && f.properties.day_index != null && day != null && f.properties.day_index > day;
  const past = k === 'spielfeld' && f.properties.day_index != null && day != null && f.properties.day_index < day;
  return {
    color,
    weight: k === 'spielfeld' ? 3 : 2,
    fillOpacity: k === 'spielfeld' ? (future || past ? 0 : 0.05) : k === 'sperrzone' ? 0.3 : 0.15,
    dashArray: future ? '8 8' : k === 'sperrzone' ? '6 4' : undefined,
    opacity: past ? 0.25 : 1,
    // Gefahren schraffiert (Muster in index.html).
    className: k === 'sperrzone' ? 'hm-danger' : undefined,
  };
}

export function addZones(layer: L.LayerGroup, zones: MapFeature[], day?: number) {
  for (const f of zones) {
    const k = f.properties.kind;
    const info = ZONE_INFO[k] ?? ZONE_INFO.spielfeld;
    const name = f.properties.name || info.label;
    let l: L.Layer;
    if (f.geometry.type === 'Point') {
      const [lng, lat] = (f.geometry as GeoJSON.Point).coordinates;
      // Punkt mit Symbol; der Radius nur gestrichelt darum.
      l = L.marker([lat, lng], { icon: pointIcon(k) });
      if (k !== 'treffpunkt') {
        layer.addLayer(L.circle([lat, lng], { radius: f.properties.radius_m || (k === 'hq' ? 100 : 30), color: info.color, weight: 2, dashArray: '6 6', fill: false, interactive: false }));
      }
    } else {
      l = L.geoJSON(f as GeoJSON.Feature, { style: () => zoneStyle(f, day) });
    }
    const dayText = f.properties.day_index ? ` (Phase ${f.properties.day_index})` : '';
    if (k === 'sperrzone' || k === 'sicher') layer.addLayer(zoneBadge(f));
    // Exit und HQ immer beschriftet, alles andere beim Antippen.
    const permanent = k === 'exit' || k === 'hq';
    const prefix = k === 'exit' ? 'EXIT: ' : k === 'sperrzone' ? `GEFAHR (${restrictedInfo(f.properties.restricted_type).label}): ` : '';
    (l as L.Path).bindTooltip(esc(`${prefix}${name}${dayText}`), permanent ? { permanent: true, direction: 'top' } : { sticky: true });
    layer.addLayer(l);
  }
}

const POINT_ICON: Record<string, string> = { hq: '🚓', treffpunkt: '📍', exit: '🏁' };

/** Punkt-Symbol für HQ, Treffpunkt und Exit (gut antipp- und verschiebbar). */
export function pointIcon(kind: string): L.DivIcon {
  const color = ZONE_INFO[kind as keyof typeof ZONE_INFO]?.color ?? '#fff';
  return L.divIcon({
    className: '',
    html: `<div class="point-pin" style="border-color:${color}">${POINT_ICON[kind] ?? '•'}</div>`,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
  });
}

/** Symbol in der Mitte einer Gefahren- oder Schutzzone, damit man sie sofort erkennt. */
export function zoneBadge(f: MapFeature): L.Marker {
  const k = f.properties.kind;
  let lat: number;
  let lng: number;
  if (f.geometry.type === 'Point') {
    [lng, lat] = (f.geometry as GeoJSON.Point).coordinates;
  } else {
    [lng, lat] = pointOnFeature(f as GeoJSON.Feature).geometry.coordinates;
  }
  const info = restrictedInfo(f.properties.restricted_type);
  const html = k === 'sperrzone'
    ? `<div class="zone-badge danger" title="${esc(info.label)}">⚠️${info.icon === '⚠️' ? '' : info.icon}</div>`
    : '<div class="zone-badge safe" title="Sichere Zone">🛡️</div>';
  return L.marker([lat, lng], { icon: L.divIcon({ className: '', html, iconSize: [36, 22], iconAnchor: [18, 11] }), interactive: false, keyboard: false });
}

// Tooltips rendern HTML: Namen von Nutzern immer escapen.
export function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

function markerIcon(m: Marker) {
  const size = m.kind === 'ping' || m.kind === 'fake' ? 16 : m.kind === 'me' ? 20 : 18;
  const shape = m.kind === 'ping' || m.kind === 'fake' ? 'border-radius:3px;transform:rotate(45deg);' : 'border-radius:50%;';
  return L.divIcon({
    className: 'hm-marker',
    html: `<div style="width:${size}px;height:${size}px;background:${m.color};${shape}border:2px solid #fff;opacity:${m.opacity ?? 1};box-shadow:0 0 0 2px rgba(0,0,0,.4)${m.pulse ? ';animation:hm-pulse 1.2s infinite' : ''}"></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

export default function MapView({ zones, markers, lines, onClick, fitKey, height = '60dvh', showDay }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const zoneLayer = useRef<L.LayerGroup | null>(null);
  const markerLayer = useRef<L.LayerGroup | null>(null);
  const clickRef = useRef(onClick);
  clickRef.current = onClick;
  const fitted = useRef<string | number | undefined>(undefined);
  const centered = useRef(false);
  const pendingFit = useRef<L.LatLngBounds | null>(null);

  useEffect(() => {
    if (!el.current || map.current) return;
    const m = L.map(el.current, { zoomControl: true, attributionControl: true }).setView([47.3769, 8.5417], 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap',
    }).addTo(m);
    zoneLayer.current = L.layerGroup().addTo(m);
    markerLayer.current = L.layerGroup().addTo(m);
    m.on('click', (e: L.LeafletMouseEvent) => clickRef.current?.(e.latlng.lat, e.latlng.lng));
    addMapButtons(m, {
      wrap: () => el.current?.parentElement ?? null,
      fit: () => {
        const ls = zoneLayer.current?.getLayers() ?? [];
        return ls.length ? L.featureGroup(ls).getBounds() : null;
      },
    });
    map.current = m;
    fitted.current = undefined;
    centered.current = false;
    const ro = new ResizeObserver(() => {
      m.invalidateSize();
      // Karte war beim Laden versteckt (anderer Tab): jetzt einpassen.
      if (pendingFit.current && el.current && el.current.clientWidth > 0) {
        m.fitBounds(pendingFit.current, { padding: [20, 20], animate: false });
        pendingFit.current = null;
      }
    });
    ro.observe(el.current);
    return () => {
      ro.disconnect();
      m.remove();
      map.current = null;
    };
  }, []);

  useEffect(() => {
    const layer = zoneLayer.current;
    if (!layer || !map.current) return;
    layer.clearLayers();
    addZones(layer, zones, showDay);
    if (fitted.current !== fitKey || fitKey === undefined) {
      const group = L.featureGroup(layer.getLayers() as L.Layer[]);
      const b = group.getBounds();
      if (b.isValid()) {
        if (el.current && el.current.clientWidth === 0) pendingFit.current = b;
        else map.current.fitBounds(b, { padding: [20, 20], animate: false });
        fitted.current = fitKey;
        centered.current = true;
      }
    }
  }, [zones, fitKey, showDay]);

  useEffect(() => {
    const layer = markerLayer.current;
    if (!layer) return;
    layer.clearLayers();
    // Ohne Zonen einmal auf den ersten Marker zentrieren.
    if (!centered.current && markers.length && map.current) {
      map.current.setView([markers[0].lat, markers[0].lng], 15, { animate: false });
      centered.current = true;
    }
    for (const ln of lines ?? []) {
      if (ln.points.length > 1) layer.addLayer(L.polyline(ln.points, { color: ln.color, weight: 3, opacity: 0.7 }));
    }
    for (const m of markers) {
      if (m.accuracy && m.accuracy > 15 && (m.kind === 'me' || m.kind === 'player' || m.kind === 'hunter')) {
        layer.addLayer(L.circle([m.lat, m.lng], { radius: m.accuracy, color: m.color, weight: 1, fillOpacity: 0.08, interactive: false }));
      }
      if (m.kind === 'hotel' && m.accuracy) {
        layer.addLayer(L.circle([m.lat, m.lng], { radius: m.accuracy, color: m.color, weight: 2, fillOpacity: 0.1 }));
      }
      const mk = L.marker([m.lat, m.lng], { icon: markerIcon(m), zIndexOffset: m.kind === 'me' ? 1000 : 0 });
      mk.bindTooltip(esc(m.label), { direction: 'top', offset: [0, -8] });
      if (m.popup) mk.bindPopup(esc(m.popup));
      layer.addLayer(mk);
    }
  }, [markers, lines]);

  return <div className="map-wrap"><div ref={el} className="map" style={{ height }} /></div>;
}
