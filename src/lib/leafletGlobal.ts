import L from 'leaflet';

// Leaflet-Geoman erwartet Leaflet als globales L.
(window as unknown as { L: typeof L }).L = L;
