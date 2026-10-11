import L from 'leaflet';

/**
 * Zusätzliche Knöpfe auf der Karte: Vollbild, auf das Spielfeld zoomen, eigener Standort.
 * Grosse Knöpfe, damit es auf dem Handy einfach geht.
 */
export function addMapButtons(m: L.Map, opts: { wrap: () => HTMLElement | null; fit: () => L.LatLngBounds | null }) {
  const Ctl = L.Control.extend({
    onAdd() {
      const box = L.DomUtil.create('div', 'leaflet-bar hm-map-buttons');
      const btn = (text: string, title: string, fn: () => void) => {
        const a = L.DomUtil.create('a', '', box) as HTMLAnchorElement;
        a.href = '#';
        a.innerHTML = text;
        a.title = title;
        a.setAttribute('role', 'button');
        a.setAttribute('aria-label', title);
        L.DomEvent.on(a, 'click', (e) => { L.DomEvent.preventDefault(e); L.DomEvent.stopPropagation(e); fn(); });
        return a;
      };
      const full = btn('⛶', 'Vollbild', () => {
        const w = opts.wrap();
        if (!w) return;
        const on = w.classList.toggle('map-fullscreen');
        document.body.classList.toggle('no-scroll', on);
        full.innerHTML = on ? '✕' : '⛶';
        full.title = on ? 'Vollbild beenden' : 'Vollbild';
        setTimeout(() => m.invalidateSize(), 50);
      });
      btn('⌖', 'Auf das Spielfeld zoomen', () => {
        const b = opts.fit();
        if (b?.isValid()) m.fitBounds(b, { padding: [20, 20] });
      });
      btn('◎', 'Mein Standort', () => {
        navigator.geolocation?.getCurrentPosition((p) => m.setView([p.coords.latitude, p.coords.longitude], Math.max(m.getZoom(), 16)), () => undefined, { timeout: 8000 });
      });
      L.DomEvent.disableClickPropagation(box);
      return box;
    },
  });
  new Ctl({ position: 'topright' }).addTo(m);
}
