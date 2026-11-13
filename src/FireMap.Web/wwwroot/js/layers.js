/* global L */
// Hot spot layers. Each backend layer (sensor) holds one data "slot" per time period:
//   normal mode  → one period (A), points use the layer colour;
//   compare mode → two periods (A, B), points use the period colour.
// All slots draw on one shared canvas. Layers come from /api/layers, so a new backend provider
// (e.g. harmonized data) appears here automatically.
import { api, ApiError } from './api.js';
import { boundsToBbox, snapBbox, tileCount } from './geo.js';

/**
 * Optional per-layer style overrides, keyed by layer id.
 * Example for the team's harmonized layer:
 *   'harmonized-modis-eq': { stroke: '#002b36', minRadius: 3 }
 */
export const LAYER_STYLES = {};

const BROWSER_CACHE_SIZE = 30;
const RELOAD_DEBOUNCE_MS = 400;

export class HotspotLayers {
  /**
   * @param {L.Map} map
   * @param {{ onStatus?: Function, onLoadingChange?: Function, onData?: Function }} hooks
   */
  constructor(map, hooks) {
    this.map = map;
    this.hooks = hooks;
    this.renderer = L.canvas({ pane: 'hotspots', padding: 0.3, tolerance: 3 });
    this.layers = new Map(); // id → { def, enabled, status, slots: Map<periodKey, slot> }
    this.periods = []; // [{ key: 'A'|'B', from, to, color, label }]
    this.cache = new Map(); // url → response (LRU)
    this.config = null;
    this.popupsEnabled = true;
    this.filter = null; // { type: 'bbox', bbox } | { type: 'country', iso3 } — limits points to the selection
    this.days = null; // timeline: { A: 'yyyy-mm-dd'|null, B: ... } — null = show every day
    this._timer = null;
  }

  get comparing() {
    return this.periods.length > 1;
  }

  init(config, defs, enabledIds) {
    this.config = config;
    for (const def of defs) {
      this.layers.set(def.id, { def, enabled: enabledIds.has(def.id), status: { state: 'idle' }, slots: new Map() });
    }
    this.map.on('moveend', () => this.reload());
  }

  /** Periods to show: one (normal) or two (comparison). Replaces the previous set. */
  setPeriods(periods) {
    this.periods = periods.map((p) => ({ ...p }));
    const keys = new Set(this.periods.map((p) => p.key));
    for (const l of this.layers.values()) {
      for (const [key, slot] of l.slots) {
        if (!keys.has(key)) {
          this._dropSlot(slot);
          l.slots.delete(key);
        }
      }
      for (const p of this.periods) {
        if (!l.slots.has(p.key)) l.slots.set(p.key, this._newSlot(l, p.key));
        l.slots.get(p.key).url = null; // range or colouring may have changed → re-render (browser cache makes it cheap)
      }
    }
    this.reload(0);
    this.hooks.onData?.();
  }

  setEnabled(id, enabled) {
    const l = this.layers.get(id);
    if (!l) return;
    l.enabled = enabled;
    for (const slot of l.slots.values()) {
      if (enabled) {
        slot.group.addTo(this.map);
        this._load(l, slot);
      } else {
        slot.controller?.abort();
        slot.group.remove();
        slot.status = { state: 'idle' };
      }
    }
    this._emitStatus(l);
    this.hooks.onData?.(); // per-day counts changed
  }

  enabledIds() {
    return [...this.layers.values()].filter((l) => l.enabled).map((l) => l.def.id);
  }

  /** Show only points inside the selection (null = everything in the current view). */
  setFilter(selection) {
    this.filter = selection ? { ...selection } : null;
    for (const l of this.layers.values()) for (const slot of l.slots.values()) slot.url = null;
    this.reload(0);
  }

  /** Timeline: one UTC day per period ({ A: 'yyyy-mm-dd', B: ... }), or null for all days. No refetch. */
  setDays(days) {
    this.days = days;
    this._drawAll();
  }

  /** Redraw every loaded slot. In compare mode B goes first so period A stays on top of the shared canvas. */
  _drawAll() {
    const order = [...this.periods].reverse().map((p) => p.key);
    for (const key of order) {
      for (const l of this.layers.values()) {
        const slot = l.enabled && l.slots.get(key);
        if (slot?.data) this._draw(l, slot);
      }
    }
  }

  /** Detections per day and period across enabled layers: { A: Map(day → n), B: ... }. */
  dayCounts() {
    const out = Object.fromEntries(this.periods.map((p) => [p.key, new Map()]));
    for (const l of this.layers.values()) {
      if (!l.enabled) continue;
      for (const [key, slot] of l.slots) {
        if (!slot.byDay || !out[key]) continue;
        for (const [day, markers] of slot.byDay) out[key].set(day, (out[key].get(day) ?? 0) + markers.length);
      }
    }
    return out;
  }

  reload(delay = RELOAD_DEBOUNCE_MS) {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      for (const l of this.layers.values()) {
        if (l.enabled) for (const slot of l.slots.values()) this._load(l, slot);
      }
    }, delay);
  }

  // ---- internals ----------------------------------------------------------------------------

  _period(key) {
    return this.periods.find((p) => p.key === key);
  }

  _newSlot(l, key) {
    const group = L.featureGroup();
    group.on('click', (e) => this._openPopup(l.def, key, e));
    if (l.enabled) group.addTo(this.map);
    return { key, group, url: null, controller: null, data: null, markers: null, byDay: null, status: { state: 'idle' } };
  }

  _dropSlot(slot) {
    slot.controller?.abort();
    slot.group.remove();
  }

  async _load(l, slot) {
    const period = this._period(slot.key);
    if (!period || !this.config) return;
    const { from, to } = period;
    let url;

    if (this.filter) {
      // Selection filter: fixed area, independent of the map view (panning does not reload).
      const area = this.filter.type === 'country' ? { country: this.filter.iso3 } : { bbox: this.filter.bbox };
      url = api.hotspotsUrl({ layer: l.def.id, ...area, from, to });
    } else {
      // Snap to a fine grid so small pans reuse the same URL; the server fetches whole (coarser) cache tiles.
      const bbox = snapBbox(boundsToBbox(this.map.getBounds()), this.config.requestGridDeg);
      const tiles = tileCount(bbox, this.config.tileSizeDeg);
      if (tiles > this.config.mapMaxTiles) {
        slot.controller?.abort();
        slot.url = null;
        this._forget(slot);
        slot.status = { state: 'zoom', tiles, maxTiles: this.config.mapMaxTiles };
        this._emitStatus(l);
        this.hooks.onData?.();
        return;
      }
      url = api.hotspotsUrl({ layer: l.def.id, bbox, from, to });
    }

    // Same request already shown or in flight (pan inside the same tiles, or any pan while filtered).
    if (url === slot.url && slot.status.state !== 'idle') return;

    slot.controller?.abort();
    slot.url = url;

    const cached = this.cache.get(url);
    if (cached) {
      this.cache.delete(url); // refresh LRU position
      this.cache.set(url, cached);
      this._render(l, slot, cached);
      return;
    }

    const controller = new AbortController();
    slot.controller = controller;
    slot.status = { state: 'loading' };
    this._emitStatus(l);
    try {
      const data = await api.hotspots(url, controller.signal);
      if (controller.signal.aborted || slot.url !== url) return;
      if (!data.partial) this._remember(url, data); // never pin incomplete answers
      this._render(l, slot, data);
    } catch (err) {
      if (err.name === 'AbortError') return;
      this._forget(slot);
      const zoom = err instanceof ApiError && err.status === 422 && !this.filter;
      slot.status = { state: zoom ? 'zoom' : 'error', message: err.message };
      this._emitStatus(l);
      this.hooks.onData?.();
    } finally {
      if (slot.controller === controller) slot.controller = null;
    }
  }

  _render(l, slot, data) {
    // Markers are built once per response and indexed by day, so timeline steps only swap which are drawn.
    const periodColor = this.comparing ? this._period(slot.key)?.color : null;
    const periodStyle = periodColor ? { fill: periodColor, ...(slot.key !== 'A' ? { fillOpacity: 0.7 } : {}) } : {};
    const style = { ...defaultStyle(l.def), ...(LAYER_STYLES[l.def.id] || {}), ...periodStyle };
    const all = [];
    const byDay = new Map();
    for (const f of data.features) {
      const [lon, lat] = f.geometry.coordinates;
      const marker = L.circleMarker([lat, lon], {
        renderer: this.renderer,
        radius: radiusFor(f.properties.frp, style),
        color: style.stroke,
        weight: style.weight,
        fillColor: style.fill,
        fillOpacity: style.fillOpacity,
        opacity: 0.9,
      });
      marker.feature = f;
      all.push(marker);
      const day = String(f.properties.acquired).slice(0, 10); // acquired is UTC ISO 8601
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push(marker);
    }
    slot.data = data;
    slot.markers = all;
    slot.byDay = byDay;
    if (this.comparing) this._drawAll(); // keep A above B whichever finished loading last
    else this._draw(l, slot);
    this.hooks.onData?.();
  }

  _draw(l, slot) {
    let shown = slot.markers;
    if (this.days) {
      const day = this.days[slot.key];
      shown = day ? slot.byDay.get(day) ?? [] : []; // a shorter period has no day at this timeline step
    }
    slot.group.clearLayers();
    for (const m of shown) slot.group.addLayer(m);
    slot.status = {
      state: 'ok',
      count: slot.data.features.length,
      total: slot.data.totalCount,
      truncated: slot.data.truncated,
      partial: slot.data.partial,
      shown: shown.length,
    };
    this._emitStatus(l);
  }

  _forget(slot) {
    slot.data = null;
    slot.markers = null;
    slot.byDay = null;
    slot.group.clearLayers();
  }

  /** Combine the per-period slot states into one status for the layer list / banner. */
  _emitStatus(l) {
    const parts = this.periods.map((p) => ({ period: p, s: l.slots.get(p.key)?.status ?? { state: 'idle' } }));
    const states = parts.map((x) => x.s);
    const error = states.find((s) => s.state === 'error');
    const zoom = states.find((s) => s.state === 'zoom');
    let status;
    if (!l.enabled || states.length === 0) status = { state: 'idle' };
    else if (states.some((s) => s.state === 'loading')) status = { state: 'loading' };
    else if (error) status = { ...error };
    else if (zoom) status = { ...zoom };
    else if (states.every((s) => s.state === 'ok')) {
      const truncated = states.find((s) => s.truncated);
      status = {
        state: 'ok',
        truncated: !!truncated,
        count: truncated?.count,
        total: truncated?.total ?? states[0].total,
        partial: states.some((s) => s.partial),
        day: !!this.days,
        parts: parts.map(({ period, s }) => ({ key: period.key, color: period.color, shown: s.shown, total: s.total })),
      };
    } else status = { state: 'idle' };

    l.status = status;
    this.hooks.onStatus?.(l.def.id, status, this.comparing);
    const loading = [...this.layers.values()].filter((x) => x.enabled && x.status.state === 'loading').map((x) => x.def.name);
    this.hooks.onLoadingChange?.(loading);
  }

  _openPopup(def, periodKey, e) {
    if (!this.popupsEnabled) return;
    const f = e.layer.feature;
    if (!f) return;
    const period = this._period(periodKey);
    const head = this.comparing && period
      ? { color: period.color, title: `${def.name} · Period ${period.key} (${period.label})` }
      : { color: def.color, title: def.name };
    L.popup({ maxWidth: 300, className: 'hs-popup' })
      .setLatLng(e.latlng)
      .setContent(popupHtml(head, f))
      .openOn(this.map);
  }

  _remember(url, data) {
    this.cache.set(url, data);
    while (this.cache.size > BROWSER_CACHE_SIZE) this.cache.delete(this.cache.keys().next().value);
  }
}

function defaultStyle(def) {
  return { fill: def.color, stroke: 'rgba(20, 12, 8, 0.75)', weight: 0.6, fillOpacity: 0.88, minRadius: 2.5, maxRadius: 9 };
}

/** Radius grows with log(FRP) so strong fires stand out without hiding weak ones. */
function radiusFor(frp, style) {
  const r = style.minRadius + Math.log10(1 + (frp || 0)) * 2.2;
  return Math.min(style.maxRadius, Math.max(style.minRadius, r));
}

const fmt = (v, digits = 1) => (v === null || v === undefined ? '–' : Number(v).toLocaleString(undefined, { maximumFractionDigits: digits }));

function popupHtml(head, f) {
  const p = f.properties;
  const [lon, lat] = f.geometry.coordinates;
  const when = new Date(p.acquired).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const conf = p.confidencePct != null ? `${p.confidence} (${p.confidencePct}%)` : p.confidence;
  const rows = [
    ['Acquired', when],
    ['Satellite', `${p.satellite} · ${p.instrument}`],
    ['FRP', `${fmt(p.frp)} MW`],
    ['Confidence', conf],
    ['Brightness', `${fmt(p.brightness)} K`],
    ['Day / night', p.dayNight === 'D' ? 'Day' : p.dayNight === 'N' ? 'Night' : '–'],
    ['Pixel', p.scan && p.track ? `${fmt(p.scan, 2)} × ${fmt(p.track, 2)} km` : '–'],
    ['Location', `${lat.toFixed(4)}, ${lon.toFixed(4)}`],
    ['Source', p.source],
  ];
  return `
    <div class="popup-head"><span class="swatch" style="--c:${head.color}"></span>${escapeHtml(head.title)}</div>
    <dl class="popup-grid">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(String(v ?? '–'))}</dd>`).join('')}</dl>`;
}

export function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
