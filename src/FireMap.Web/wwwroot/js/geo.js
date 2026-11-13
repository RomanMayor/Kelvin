// Small geometry helpers (no dependencies).

/** Leaflet bounds → [w, s, e, n] clamped to valid lon/lat. */
export function boundsToBbox(bounds) {
  let w = bounds.getWest(), e = bounds.getEast();
  if (e - w >= 360) { w = -180; e = 180; }
  return [
    clamp(w, -180, 180),
    clamp(bounds.getSouth(), -90, 90),
    clamp(e, -180, 180),
    clamp(bounds.getNorth(), -90, 90),
  ];
}

/**
 * Expand a bbox to the backend's cache grid. Requests for any view inside the same tiles get the
 * same URL → browser LRU and server cache both hit while the user pans around.
 */
export function snapBbox([w, s, e, n], size) {
  const snapDown = (v, origin) => Math.floor((v - origin) / size) * size + origin;
  const snapUp = (v, origin) => Math.ceil((v - origin) / size) * size + origin;
  const out = [
    clamp(snapDown(w, -180), -180, 180),
    clamp(snapDown(s, -90), -90, 90),
    clamp(snapUp(e, -180), -180, 180),
    clamp(snapUp(n, -90), -90, 90),
  ];
  if (out[2] <= out[0]) out[2] = Math.min(180, out[0] + size);
  if (out[3] <= out[1]) out[3] = Math.min(90, out[1] + size);
  return out;
}

/** Number of server cache tiles (grid anchored at -180/-90) touched by a bbox. */
export function tileCount([w, s, e, n], size) {
  const span = (lo, hi, origin) =>
    Math.max(1, Math.ceil((hi - origin) / size - 1e-9) - Math.floor((lo - origin) / size + 1e-9));
  return span(w, e, -180) * span(s, n, -90);
}

export function roundBbox(bbox, digits = 3) {
  const f = 10 ** digits;
  return bbox.map((v) => Math.round(v * f) / f);
}

/** Bounding box of a GeoJSON Polygon/MultiPolygon feature. */
export function featureBbox(feature) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const ring of rings(feature.geometry)) {
    for (const [x, y] of ring) {
      if (x < w) w = x; if (x > e) e = x;
      if (y < s) s = y; if (y > n) n = y;
    }
  }
  return [w, s, e, n];
}

/** Even-odd point-in-polygon over all rings (handles holes and multipolygons). */
export function featureContains(feature, lon, lat) {
  let inside = false;
  for (const ring of rings(feature.geometry)) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

function* rings(geometry) {
  if (geometry.type === 'Polygon') yield* geometry.coordinates;
  else if (geometry.type === 'MultiPolygon') for (const poly of geometry.coordinates) yield* poly;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
