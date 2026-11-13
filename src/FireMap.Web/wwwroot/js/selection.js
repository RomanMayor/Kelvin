/* global L */
// Area selection: draw a rectangle (Leaflet-Geoman) or pick a country (click / search).
import { featureBbox, featureContains, roundBbox } from './geo.js';

const SELECTED_STYLE = { color: '#ffb703', weight: 2.5, fillColor: '#ffb703', fillOpacity: 0.07 };
const HOVER_STYLE = { color: '#ffffff', weight: 1.5, dashArray: '4 4', fill: true, fillColor: '#ffffff', fillOpacity: 0.08 };
const OUTLINE_STYLE = { color: '#5b6b80', weight: 0.7, opacity: 0.7, fill: false };

export class AreaSelector {
  /**
   * @param {L.Map} map
   * @param {{ onSelect: (sel: object) => void, onClear: () => void, onModeChange: (mode: string|null) => void }} hooks
   */
  constructor(map, hooks) {
    this.map = map;
    this.hooks = hooks;
    this.mode = null; // 'rect' | 'country' | null
    this.countries = [];
    this.selected = null; // Leaflet layer of current selection
    this.selectionKind = null; // 'bbox' | 'country' | null
    this.hover = null;
    this.hoverIso = null;
    this.outlines = null;
    this._raf = 0;

    map.pm.setGlobalOptions({ panes: { layerPane: 'selection', vertexPane: 'markerPane', markerPane: 'markerPane' } });
    map.on('pm:create', (e) => this._onRectangleCreated(e));
    map.on('pm:drawend', () => this.mode === 'rect' && this.setMode(null));
    this._onMove = this._onMove.bind(this);
    this._onClick = this._onClick.bind(this);
    document.addEventListener('keydown', (e) => e.key === 'Escape' && this.setMode(null));
  }

  setCountries(geojson) {
    this.countries = geojson.features.map((f) => ({ feature: f, bbox: featureBbox(f), iso3: f.properties.iso3, name: f.properties.name }));
    this.outlines = L.geoJSON(geojson, {
      pane: 'countries',
      interactive: false,
      style: OUTLINE_STYLE,
      renderer: L.canvas({ pane: 'countries' }),
    });
  }

  countryList() {
    return this.countries.map((c) => ({ iso3: c.iso3, name: c.name })).sort((a, b) => a.name.localeCompare(b.name));
  }

  findByName(name) {
    const n = name.trim().toLowerCase();
    return this.countries.find((c) => c.name.toLowerCase() === n);
  }

  /** 'bbox' | 'country' | null — the active filter. Only one can exist at a time. */
  get selectionType() {
    return this.selectionKind;
  }

  /** "Draw rectangle" button: a second press removes the rectangle; otherwise replaces any country and starts drawing. */
  toggleRectangle() {
    if (this.mode === 'rect' || this.selectionKind === 'bbox') return this.clear();
    if (this.selectionKind || this.mode) this.clear();
    this.setMode('rect');
  }

  /** "Pick country" button: a second press removes the country; otherwise replaces any rectangle and starts picking. */
  toggleCountry() {
    if (this.mode === 'country' || this.selectionKind === 'country') return this.clear();
    if (this.selectionKind || this.mode) this.clear();
    this.setMode('country');
  }

  setMode(mode) {
    if (this.mode === mode) return;
    const old = this.mode;
    this.mode = mode; // set first: disableDraw() fires pm:drawend synchronously
    if (old === 'rect') this.map.pm.disableDraw();
    if (old === 'country') {
      this.map.off('mousemove', this._onMove);
      this.map.off('click', this._onClick);
      this.outlines?.remove();
      this._clearHover();
      this.map.getContainer().classList.remove('picking');
    }
    if (mode === 'rect') {
      this.map.pm.enableDraw('Rectangle', {
        snappable: false,
        cursorMarker: false,
        pathOptions: SELECTED_STYLE,
        templineStyle: SELECTED_STYLE,
        hintlineStyle: { ...SELECTED_STYLE, dashArray: '4 4' },
      });
    } else if (mode === 'country') {
      this.outlines?.addTo(this.map);
      this.map.on('mousemove', this._onMove);
      this.map.on('click', this._onClick);
      this.map.getContainer().classList.add('picking');
    }
    this.hooks.onModeChange?.(mode);
  }

  selectCountry(iso3, { fit = true } = {}) {
    const c = this.countries.find((x) => x.iso3 === iso3);
    if (!c) return;
    this.setMode(null);
    this._clearSelection(); // replaces a rectangle or another country
    this.selectionKind = 'country';
    this.selected = L.geoJSON(c.feature, { pane: 'selection', interactive: false, style: SELECTED_STYLE }).addTo(this.map);
    if (fit) this.map.fitBounds(this.selected.getBounds(), { padding: [30, 30], maxZoom: 7 });
    this.hooks.onSelect({ type: 'country', iso3: c.iso3, name: c.name });
  }

  selectBbox(bbox, { fit = false } = {}) {
    this.setMode(null);
    this._clearSelection(); // replaces a country or another rectangle
    this.selectionKind = 'bbox';
    const [w, s, e, n] = bbox;
    this.selected = L.rectangle([[s, w], [n, e]], { pane: 'selection', ...SELECTED_STYLE }).addTo(this.map);
    this._makeEditable(this.selected);
    if (fit) this.map.fitBounds(this.selected.getBounds(), { padding: [30, 30] });
    this.hooks.onSelect({ type: 'bbox', bbox });
  }

  clear() {
    this.setMode(null);
    const had = !!this.selectionKind;
    this._clearSelection();
    if (had) this.hooks.onClear?.();
  }

  // ---- internals ----------------------------------------------------------------------------

  _onRectangleCreated(e) {
    if (e.shape !== 'Rectangle') return;
    const bbox = boundsBbox(e.layer.getBounds());
    e.layer.remove(); // re-created by selectBbox so all selections share one code path
    this.setMode(null);
    this.selectBbox(bbox);
  }

  _makeEditable(layer) {
    layer.pm?.enable({ snappable: false, draggable: false });
    layer.on('pm:edit', () => this.hooks.onSelect({ type: 'bbox', bbox: boundsBbox(layer.getBounds()) }));
  }

  _countryAt(latlng) {
    const lon = wrapLon(latlng.lng), lat = latlng.lat;
    return this.countries.find(
      (c) => lon >= c.bbox[0] && lon <= c.bbox[2] && lat >= c.bbox[1] && lat <= c.bbox[3] && featureContains(c.feature, lon, lat),
    );
  }

  _onMove(e) {
    cancelAnimationFrame(this._raf);
    this._raf = requestAnimationFrame(() => {
      const c = this._countryAt(e.latlng);
      if (c?.iso3 === this.hoverIso) return;
      this._clearHover();
      if (!c) return;
      this.hoverIso = c.iso3;
      this.hover = L.geoJSON(c.feature, { pane: 'selection', interactive: false, style: HOVER_STYLE }).addTo(this.map);
      this.map.getContainer().title = c.name;
    });
  }

  _onClick(e) {
    const c = this._countryAt(e.latlng);
    if (!c) return;
    this.setMode(null);
    this.selectCountry(c.iso3, { fit: true });
  }

  _clearHover() {
    this.hover?.remove();
    this.hover = null;
    this.hoverIso = null;
    this.map.getContainer().title = '';
  }

  _clearSelection() {
    if (this.selected) {
      this.selected.pm?.disable();
      this.selected.remove();
    }
    this.selected = null;
    this.selectionKind = null;
  }
}

function boundsBbox(b) {
  // The map may be scrolled onto a world copy: shift by whole turns, keep the width.
  const w = wrapLon(b.getWest());
  const e = w + (b.getEast() - b.getWest());
  return roundBbox([
    Math.max(-180, w),
    Math.max(-90, b.getSouth()),
    Math.min(180, e),
    Math.min(90, b.getNorth()),
  ]);
}

function wrapLon(lon) {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}
