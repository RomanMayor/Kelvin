/* global L */
// Leaflet map with OSM base layers and the panes that keep layers in a predictable order.

const OSM_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

export function createMap(elementId, { center, zoom }) {
  const map = L.map(elementId, {
    zoomControl: false,
    worldCopyJump: true,
    minZoom: 2,
    maxBounds: [[-90, -540], [90, 540]],
  }).setView(center, zoom);

  L.control.zoom({ position: 'bottomright' }).addTo(map);
  L.control.scale({ position: 'bottomleft', imperial: false }).addTo(map);

  const baseLayers = {
    OpenStreetMap: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: OSM_ATTR,
    }),
    'Light (CARTO)': L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      subdomains: 'abcd',
      maxZoom: 20,
      attribution: `${OSM_ATTR} &copy; <a href="https://carto.com/attributions">CARTO</a>`,
    }),
    'Dark (CARTO)': L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      subdomains: 'abcd',
      maxZoom: 20,
      attribution: `${OSM_ATTR} &copy; <a href="https://carto.com/attributions">CARTO</a>`,
    }),
    'Satellite (Esri)': L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      { maxZoom: 19, attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics' },
    ),
  };
  baseLayers.OpenStreetMap.addTo(map);

  // Pane order (bottom → top): tiles 200 · countries 380 · selection 390 · hotspots 420 · markers 600 · popups 700
  addPane(map, 'countries', 380, true);
  addPane(map, 'selection', 390, true);
  addPane(map, 'hotspots', 420, false);

  const layerControl = L.control.layers(baseLayers, {}, { position: 'topright', collapsed: true }).addTo(map);

  return { map, layerControl };
}

function addPane(map, name, zIndex, passThrough) {
  const pane = map.createPane(name);
  pane.style.zIndex = String(zIndex);
  if (passThrough) pane.style.pointerEvents = 'none';
  return pane;
}
