// Entry point: wires map, layers, selection, timeline and sidebar together. State is mirrored in the URL hash:
//   #d:2026-08-01..2026-08-15;b:2025-08-01..2025-08-15;l:modis,viirs-noaa20;@12.5,42.5,6z;c:ITA
//   d = period A, b = period B (compare mode, optional), c = country / r = rectangle (w,s,e,n)
import { api } from './api.js';
import { createMap } from './map.js';
import { HotspotLayers } from './layers.js';
import { AreaSelector } from './selection.js';
import { Timeline } from './timeline.js';
import { renderLayerList, updateLayerStatus, renderStats, renderStatsLoading, renderStatsError } from './panel.js';

const $ = (id) => document.getElementById(id);
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const DEFAULT_VIEW = { center: [48.1, 28.3], zoom: 5 };

/** Applied state. Inputs may hold an unapplied draft until Apply is pressed. */
const state = {
  from: null, // period A
  to: null,
  compare: null, // period B: { from, to } | null
  enabled: new Set(),
  selection: null, // { type: 'bbox', bbox } | { type: 'country', iso3, name }
};

let config, defs, map, hotspots, selector, timeline, statsController;
let compareOpen = false; // period B controls visible (may not be applied yet)
const layerStatus = new Map();

main().catch((err) => {
  console.error(err);
  showBanner(`Could not start: ${err.message}`, 'error');
});

async function main() {
  const [cfg, layerDefs, countries] = await Promise.all([
    api.config(),
    api.layers(),
    fetch('/data/countries.json').then((r) => r.json()),
  ]);
  config = cfg;
  defs = layerDefs;

  const fromHash = parseHash(location.hash);
  const today = config.today;
  state.to = fromHash.to ?? today;
  state.from = fromHash.from ?? addDays(today, -1);
  state.compare = fromHash.compare ?? null;
  state.enabled = new Set(fromHash.layers ?? defs.filter((d) => d.defaultVisible).map((d) => d.id));

  // In sample mode the data covers fixed dates; start where there is something to see.
  if (config.mode === 'sample' && !fromHash.from) {
    const max = defs.map((d) => d.maxDate).filter(Boolean).sort().at(-1);
    if (max) { state.to = max; state.from = addDays(max, -4); }
  }

  ({ map } = createMap('map', fromHash.view ?? DEFAULT_VIEW));

  hotspots = new HotspotLayers(map, {
    onStatus: (id, s, comparing) => {
      layerStatus.set(id, s);
      updateLayerStatus($('layer-list'), id, s, comparing);
      updateBanner();
    },
    onLoadingChange: (names) => {
      $('loading').hidden = names.length === 0;
      $('loading-text').textContent = `Loading ${names.join(', ')}…`;
    },
    onData: () => {
      if (timeline?.visible) timeline.setCounts(hotspots.dayCounts());
    },
  });
  hotspots.init(config, defs, state.enabled);

  timeline = new Timeline({
    onDay: (days) => {
      hotspots.setDays(days);
      highlightStatsDay(days);
    },
  });

  selector = new AreaSelector(map, {
    onSelect: (sel) => {
      state.selection = sel;
      hotspots.setFilter(sel); // map shows only points inside the selection
      $('country-search').value = sel.type === 'country' ? sel.name : '';
      updateTools();
      writeHash();
      runStats();
    },
    onClear: () => {
      state.selection = null;
      hotspots.setFilter(null); // back to everything in the current view
      statsController?.abort();
      $('stats-panel').hidden = true;
      $('country-search').value = '';
      updateTools();
      writeHash();
    },
    onModeChange: () => updateTools(),
  });
  selector.setCountries(countries);

  setupSidebar();

  // A shared link may carry out-of-range periods: fall back to defaults.
  if (validateRange(state.from, state.to)) {
    state.to = maxDate();
    state.from = addDays(state.to, -1);
  }
  if (state.compare && validateRange(state.compare.from, state.compare.to)) state.compare = null;
  compareOpen = !!state.compare;
  showCompareControls(compareOpen);
  applyState({ from: state.from, to: state.to, compare: state.compare }, { initial: true });

  if (fromHash.country) selector.selectCountry(fromHash.country, { fit: !fromHash.view });
  else if (fromHash.bbox) selector.selectBbox(fromHash.bbox, { fit: !fromHash.view });

  map.on('moveend', writeHash);
  $('mode-badge').hidden = config.mode !== 'sample';
  pollStatus();
  setInterval(pollStatus, 30_000);
}

// ---- Sidebar wiring --------------------------------------------------------------------------

function setupSidebar() {
  renderLayerList($('layer-list'), defs, state.enabled, (id, on) => {
    on ? state.enabled.add(id) : state.enabled.delete(id);
    hotspots.setEnabled(id, on);
    updateDateLimits();
    writeHash();
    if (state.selection) runStats();
  });

  // Editing dates only validates; nothing is loaded until Apply (or Enter), so all ends can be changed freely.
  for (const id of ['date-from', 'date-to', 'cmp-from', 'cmp-to']) {
    $(id).addEventListener('input', onDateDraft);
    $(id).addEventListener('change', onDateDraft);
    $(id).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') applyDraft();
      if (e.key === 'Escape') cancelDraft();
    });
  }
  $('range-apply').addEventListener('click', applyDraft);
  $('range-cancel').addEventListener('click', cancelDraft);

  // Period A quick ranges apply at once (period B keeps its year offset).
  for (const chip of document.querySelectorAll('#range-presets .chip')) {
    chip.addEventListener('click', () => {
      const to = maxDate();
      const from = addDays(to, -(Number(chip.dataset.days) - 1));
      const yearsBack = compareOpen ? yearOffset() : 0;
      $('date-from').value = from;
      $('date-to').value = to;
      if (compareOpen) setCompareInputs(from, to, yearsBack || 1);
      applyDraft();
    });
  }

  // Compare: reveal period B (prefilled with the same dates a year earlier); a second press removes it.
  $('compare-toggle').addEventListener('click', () => {
    if (compareOpen) {
      compareOpen = false;
      showCompareControls(false);
      if (state.compare) applyState({ from: state.from, to: state.to, compare: null });
      else onDateDraft();
      return;
    }
    compareOpen = true;
    showCompareControls(true);
    setCompareInputs($('date-from').value || state.from, $('date-to').value || state.to, 1);
    onDateDraft(); // Apply becomes available
    $('cmp-from').focus();
  });
  for (const chip of document.querySelectorAll('#compare-presets .chip')) {
    chip.addEventListener('click', () => {
      setCompareInputs($('date-from').value, $('date-to').value, Number(chip.dataset.years));
      onDateDraft();
    });
  }

  $('play-toggle').addEventListener('change', (e) => {
    if (e.target.checked) {
      timeline.open(periodsFromState());
      timeline.setCounts(hotspots.dayCounts());
    } else {
      timeline.close();
    }
  });

  // Each button toggles its own filter; activating one removes the other.
  $('tool-rect').addEventListener('click', () => selector.toggleRectangle());
  $('tool-country').addEventListener('click', () => selector.toggleCountry());
  $('tool-clear').addEventListener('click', () => selector.clear());

  const list = selector.countryList();
  $('country-names').innerHTML = list.map((c) => `<option value="${c.name.replace(/"/g, '&quot;')}"></option>`).join('');
  $('country-search').addEventListener('change', (e) => {
    const c = selector.findByName(e.target.value);
    if (c) selector.selectCountry(c.iso3);
  });

  $('sidebar-close').addEventListener('click', () => document.body.classList.add('sidebar-hidden'));
  $('sidebar-open').addEventListener('click', () => document.body.classList.remove('sidebar-hidden'));
  if (window.matchMedia('(max-width: 720px)').matches) document.body.classList.add('sidebar-hidden');

  updateDateLimits();
}

// ---- Time ranges (period A, optional period B) ----------------------------------------------

/** Periods as the map, timeline and stats see them. */
function periodsFromState() {
  const a = { key: 'A', from: state.from, to: state.to, color: cssVar('--period-a'), label: rangeLabel(state.from, state.to) };
  if (!state.compare) return [a];
  const { from, to } = state.compare;
  return [a, { key: 'B', from, to, color: cssVar('--period-b'), label: rangeLabel(from, to) }];
}

function readDraft() {
  return {
    from: $('date-from').value,
    to: $('date-to').value,
    compare: compareOpen ? { from: $('cmp-from').value, to: $('cmp-to').value } : null,
  };
}

/** Returns an error message, or null when [from, to] is a valid range. */
function validateRange(from, to) {
  if (!from || !to) return 'Choose both a start and an end date.';
  if (from > to) return 'Start date is after end date.';
  const min = $('date-from').min, max = maxDate();
  if (min && from < min) return `Data starts on ${min}.`;
  if (to > max) return `End date cannot be after ${max}.`;
  const days = dayDiff(from, to) + 1;
  if (days > config.maxRangeDays) return `Range is ${days} days — maximum is ${config.maxRangeDays}.`;
  return null;
}

function validateDraft(d) {
  const a = validateRange(d.from, d.to);
  if (a) return d.compare ? `Period A: ${a}` : a;
  if (d.compare) {
    const b = validateRange(d.compare.from, d.compare.to);
    if (b) return `Period B: ${b}`;
  }
  return null;
}

const sameCompare = (x, y) => (x?.from ?? null) === (y?.from ?? null) && (x?.to ?? null) === (y?.to ?? null);

function draftSummary(d) {
  const days = (r) => dayDiff(r.from, r.to) + 1;
  const tx = (n) => n * config.transactionsPerDay;
  if (!d.compare) return `${days(d)} day${days(d) === 1 ? '' : 's'} · up to ${tx(days(d))} NASA transactions per layer & tile (cached afterwards)`;
  const a = days(d), b = days(d.compare);
  return `A ${a} d · B ${b} d · up to ${tx(a + b)} NASA transactions per layer & tile${a !== b ? ' · timeline aligns by day number' : ''}`;
}

/** User is editing date inputs: validate live, enable Apply, but don't load anything yet. */
function onDateDraft() {
  const d = readDraft();
  const aDirty = d.from !== state.from || d.to !== state.to;
  const bDirty = !sameCompare(d.compare, state.compare);
  const dirty = aDirty || bDirty;
  const error = validateDraft(d);
  const hint = $('range-hint');

  hint.classList.toggle('error', !!error);
  hint.textContent = error ?? (dirty ? `${draftSummary(d)} — press Apply` : draftSummary(d));
  $('range-apply').disabled = !dirty || !!error;
  $('range-cancel').hidden = !dirty;
  $('date-row-a').classList.toggle('dirty', aDirty);
  $('date-row-b').classList.toggle('dirty', !!d.compare && bDirty);
}

function applyDraft() {
  const d = readDraft();
  if (validateDraft(d)) return onDateDraft(); // keep the inputs, show why
  applyState(d);
}

function cancelDraft() {
  compareOpen = !!state.compare;
  showCompareControls(compareOpen);
  syncInputs();
  onDateDraft();
}

/** Apply period A (+ optional B): reload map layers, restart the timeline, recompute stats. */
function applyState({ from, to, compare }, { initial = false } = {}) {
  state.from = from;
  state.to = to;
  state.compare = compare ? { ...compare } : null;
  syncInputs();
  onDateDraft();
  const days = dayDiff(from, to) + 1;
  for (const chip of document.querySelectorAll('#range-presets .chip')) {
    chip.classList.toggle('active', to === maxDate() && Number(chip.dataset.days) === days);
  }

  const periods = periodsFromState();
  hotspots.setPeriods(periods);
  if (timeline.visible) {
    timeline.setPeriods(periods);
    timeline.setCounts(hotspots.dayCounts());
  }
  document.body.classList.toggle('comparing', !!state.compare);
  if (initial) return;
  writeHash();
  if (state.selection) runStats();
}

function syncInputs() {
  $('date-from').value = state.from;
  $('date-to').value = state.to;
  if (state.compare) {
    $('cmp-from').value = state.compare.from;
    $('cmp-to').value = state.compare.to;
  }
}

function showCompareControls(open) {
  $('period-b').hidden = !open;
  $('period-a-label').hidden = !open;
  $('compare-toggle').setAttribute('aria-pressed', String(open));
}

/** Period B = period A's dates shifted back by whole years. */
function setCompareInputs(from, to, yearsBack) {
  if (!from || !to) return;
  $('cmp-from').value = shiftYears(from, -yearsBack);
  $('cmp-to').value = shiftYears(to, -yearsBack);
}

/** Whole years between the period A and period B inputs (keeps "−2 years" when A changes). */
function yearOffset() {
  const a = $('date-from').value, b = $('cmp-from').value;
  if (!a || !b) return 1;
  return Math.max(1, Number(a.slice(0, 4)) - Number(b.slice(0, 4)));
}

function updateDateLimits() {
  const active = defs.filter((d) => state.enabled.has(d.id) && d.minDate);
  const min = active.map((d) => d.minDate).sort()[0] ?? '2000-11-01';
  for (const id of ['date-from', 'date-to', 'cmp-from', 'cmp-to']) {
    $(id).min = min;
    $(id).max = maxDate();
  }
}

const maxDate = () => {
  if (config.mode === 'sample') return defs.map((d) => d.maxDate).filter(Boolean).sort().at(-1) ?? config.today;
  return config.today;
};

// ---- Area tools ------------------------------------------------------------------------------

/** Button state = "this filter is being drawn or is active". */
function updateTools() {
  const mode = selector.mode;
  const sel = state.selection;
  $('tool-rect').setAttribute('aria-pressed', String(mode === 'rect' || sel?.type === 'bbox'));
  $('tool-country').setAttribute('aria-pressed', String(mode === 'country' || sel?.type === 'country'));
  hotspots.popupsEnabled = mode === null;
  $('tool-hint').textContent =
    mode === 'rect' ? 'Click two opposite corners on the map. Esc to cancel.'
    : mode === 'country' ? 'Click a country on the map. Esc to cancel.'
    : sel?.type === 'country' ? `Showing only hot spots in ${sel.name}. Press "Pick country" again to remove the filter.`
    : sel?.type === 'bbox' ? 'Showing only hot spots inside the rectangle (drag its corners to adjust). Press "Draw rectangle" again to remove it.'
    : '';
}

// ---- Statistics ------------------------------------------------------------------------------

async function runStats() {
  const sel = state.selection;
  if (!sel) return;
  $('stats-panel').hidden = false;
  document.body.classList.remove('sidebar-hidden');

  const layers = [...state.enabled];
  if (layers.length === 0) {
    renderStatsError($('stats'), 'Enable at least one layer to calculate statistics.');
    return;
  }

  statsController?.abort();
  const controller = new AbortController();
  statsController = controller;
  renderStatsLoading($('stats'), sel.type === 'country' ? sel.name : 'rectangle');

  try {
    const area = sel.type === 'country' ? { country: sel.iso3 } : { bbox: sel.bbox };
    const periods = periodsFromState();
    const results = await Promise.all(
      periods.map((p) => api.stats({ layers, from: p.from, to: p.to, ...area }, controller.signal)),
    );
    if (controller.signal.aborted) return;
    const names = Object.fromEntries(defs.map((d) => [d.id, d.name]));
    renderStats($('stats'), results, periods, names);
    highlightStatsDay(timeline?.days);
  } catch (err) {
    if (err.name === 'AbortError') return;
    renderStatsError($('stats'), err.message);
  }
}

/** Mark the timeline's current day(s) in the per-day charts of the statistics panel. */
function highlightStatsDay(days) {
  for (const bar of document.querySelectorAll('.daily rect')) {
    const day = days?.[bar.dataset.period || 'A'];
    bar.classList.toggle('current', !!day && bar.dataset.date === day);
  }
}

// ---- Banner & status -------------------------------------------------------------------------

function updateBanner() {
  const statuses = [...layerStatus.entries()].filter(([id]) => state.enabled.has(id)).map(([, s]) => s);
  const zoom = statuses.find((s) => s.state === 'zoom');
  const truncated = statuses.find((s) => s.state === 'ok' && s.truncated);
  const partial = statuses.some((s) => s.state === 'ok' && s.partial);
  const error = statuses.find((s) => s.state === 'error');

  if (error) showBanner(`Error: ${error.message}`, 'error');
  else if (zoom) showBanner(zoom.tiles ? `Zoom in to load hot spots (view spans ${zoom.tiles} tiles, max ${zoom.maxTiles}).` : zoom.message, 'info');
  else if (truncated) showBanner(`Showing the ${truncated.count.toLocaleString()} strongest of ${truncated.total.toLocaleString()} detections. Zoom in or shorten the range.`, 'info');
  else if (partial) showBanner('Partial data: some tiles could not be fetched from NASA (quota or network). Showing cached data.', 'warn');
  else showBanner(null);
}

function showBanner(text, kind = 'info') {
  const b = $('banner');
  b.hidden = !text;
  if (!text) return;
  b.textContent = text;
  b.dataset.kind = kind;
}

async function pollStatus() {
  try {
    const s = await api.status();
    const q = s.quota;
    const el = $('quota');
    el.textContent = s.mode === 'sample' ? 'Offline sample data' : `NASA quota: ${q.transactionsUsed.toLocaleString()} / ${q.limit.toLocaleString()}`;
    el.title = `FIRMS transactions in the last 10 min. Cache: ${s.cache.hits} hits, ${s.cache.upstreamCalls} NASA calls, ${s.disk.files} tiles on disk (${s.disk.sizeMb} MB).`;
    el.classList.toggle('warn', q.transactionsUsed >= q.softLimit * 0.8);
  } catch { /* ignore */ }
}

// ---- URL hash --------------------------------------------------------------------------------

function writeHash() {
  if (!map) return;
  const c = map.getCenter();
  const parts = [`d:${state.from}..${state.to}`];
  if (state.compare) parts.push(`b:${state.compare.from}..${state.compare.to}`);
  parts.push(`l:${[...state.enabled].join(',')}`, `@${c.lng.toFixed(2)},${c.lat.toFixed(2)},${map.getZoom()}z`);
  if (state.selection?.type === 'country') parts.push(`c:${state.selection.iso3}`);
  if (state.selection?.type === 'bbox') parts.push(`r:${state.selection.bbox.join(',')}`);
  history.replaceState(null, '', '#' + parts.join(';'));
}

function parseHash(hash) {
  const out = {};
  const range = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/;
  for (const part of decodeURIComponent(hash.replace(/^#/, '')).split(';')) {
    let m;
    if (part.startsWith('d:') && (m = part.slice(2).match(range))) [, out.from, out.to] = m;
    else if (part.startsWith('b:') && (m = part.slice(2).match(range))) out.compare = { from: m[1], to: m[2] };
    else if ((m = part.match(/^l:(.*)$/))) out.layers = m[1].split(',').filter(Boolean);
    else if ((m = part.match(/^@(-?[\d.]+),(-?[\d.]+),([\d.]+)z$/))) out.view = { center: [Number(m[2]), Number(m[1])], zoom: Number(m[3]) };
    else if ((m = part.match(/^c:([A-Z0-9]{3})$/))) out.country = m[1];
    else if ((m = part.match(/^r:(.+)$/))) {
      const b = m[1].split(',').map(Number);
      if (b.length === 4 && b.every(Number.isFinite)) out.bbox = b;
    }
  }
  return out;
}

// ---- dates (yyyy-mm-dd strings, UTC) ---------------------------------------------------------

function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Same calendar day n years later/earlier (29 Feb → 28 Feb in non-leap years). */
function shiftYears(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const year = y + n;
  const last = new Date(Date.UTC(year, m, 0)).getUTCDate();
  return `${year}-${String(m).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

function dayDiff(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86_400_000);
}

function rangeLabel(from, to) {
  const f = (d, opts) => new Date(d + 'T00:00:00Z').toLocaleDateString(undefined, { timeZone: 'UTC', ...opts });
  return from.slice(0, 4) === to.slice(0, 4)
    ? `${f(from, { day: 'numeric', month: 'short' })} – ${f(to, { day: 'numeric', month: 'short', year: 'numeric' })}`
    : `${f(from, { day: 'numeric', month: 'short', year: 'numeric' })} – ${f(to, { day: 'numeric', month: 'short', year: 'numeric' })}`;
}
