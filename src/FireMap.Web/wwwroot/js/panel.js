// Sidebar rendering: layer list with live status, and the statistics view (single period or A vs B).
import { escapeHtml } from './layers.js';

const nf = (v, digits = 0) =>
  v === null || v === undefined || Number.isNaN(v) ? '–' : Number(v).toLocaleString(undefined, { maximumFractionDigits: digits });

// ---- Layer list ------------------------------------------------------------------------------

export function renderLayerList(el, defs, enabledIds, onToggle) {
  const groups = Map.groupBy ? Map.groupBy(defs, (d) => d.group) : groupBy(defs, (d) => d.group);
  el.innerHTML = '';
  for (const [group, items] of groups) {
    const head = document.createElement('li');
    head.className = 'layer-group';
    head.textContent = group;
    el.appendChild(head);

    for (const d of items) {
      const li = document.createElement('li');
      li.className = 'layer-item';
      li.dataset.id = d.id;
      const coverage = d.minDate ? `Data ${d.minDate} → ${d.maxDate}` : 'Coverage unknown';
      li.innerHTML = `
        <label title="${escapeHtml(d.description)}&#10;${coverage}">
          <input type="checkbox" ${enabledIds.has(d.id) ? 'checked' : ''} />
          <span class="swatch" style="--c:${d.color}"></span>
          <span class="layer-name">${escapeHtml(d.name)}</span>
          <span class="layer-meta">${d.resolutionM ? `${d.resolutionM} m` : ''}</span>
          <span class="layer-status" data-state="idle"></span>
        </label>`;
      li.querySelector('input').addEventListener('change', (e) => onToggle(d.id, e.target.checked));
      el.appendChild(li);
    }
  }
}

export function updateLayerStatus(el, id, status, comparing = false) {
  const badge = el.querySelector(`.layer-item[data-id="${CSS.escape(id)}"] .layer-status`);
  if (!badge) return;
  badge.dataset.state = status.state;
  badge.title = '';
  switch (status.state) {
    case 'loading':
      badge.innerHTML = '<span class="spinner small"></span>';
      break;
    case 'ok': {
      const parts = status.parts ?? [];
      if (comparing) {
        // "A count · B count", each in its period colour
        badge.innerHTML = parts
          .map((p) => `<span style="color:${p.color}">${nf(status.day ? p.shown : p.total)}</span>`)
          .join('<span class="muted"> · </span>');
        badge.title = parts.map((p) => `Period ${p.key}: ${nf(status.day ? p.shown : p.total)}${status.day ? ' on this day' : ''}`).join('\n');
        break;
      }
      const p = parts[0] ?? {};
      if (status.day) {
        badge.textContent = nf(p.shown);
        badge.title = `${nf(p.shown)} on this day · ${nf(p.total)} in the whole range`;
        break;
      }
      badge.textContent = nf(p.total) + (status.partial || status.truncated ? '*' : '');
      badge.title = status.truncated ? `Showing ${nf(status.count)} strongest of ${nf(status.total)}` : status.partial ? 'Partial data' : '';
      break;
    }
    case 'zoom':
      badge.textContent = 'zoom in';
      break;
    case 'error':
      badge.textContent = 'error';
      badge.title = status.message || '';
      break;
    default:
      badge.textContent = '';
  }
}

// ---- Statistics ------------------------------------------------------------------------------

export function renderStatsLoading(el, label) {
  el.innerHTML = `<div class="stats-loading"><span class="spinner"></span> Calculating ${escapeHtml(label)}…</div>`;
}

export function renderStatsError(el, message) {
  el.innerHTML = `<div class="stats-error">${escapeHtml(message)}</div>`;
}

/**
 * @param results  one /api/stats result per period (same order as periods)
 * @param periods  [{ key, from, to, color, label }]
 */
export function renderStats(el, results, periods, layerNames) {
  const area = results[0].area;
  const multi = periods.length > 1;
  const head = `
    <div class="stats-area">
      <div class="area-name">${escapeHtml(area.name)}</div>
      <div class="muted">${nf(area.areaKm2)} km²</div>
      ${periods
        .map((p, i) => {
          const days = results[i].layers[0]?.daily.length ?? 0;
          const dot = multi ? `<span class="dot" style="--c:${p.color}"></span>Period ${p.key}: ` : '';
          return `<div class="muted period-line">${dot}${p.from} → ${p.to} (${days} day${days === 1 ? '' : 's'})</div>`;
        })
        .join('')}
    </div>`;

  const partial = results.some((r) => r.partial)
    ? `<div class="stats-warn">Some tiles could not be fetched (NASA quota or network). Numbers are a lower bound.</div>`
    : '';

  if (!multi) {
    el.innerHTML = head + partial + periodDetails(results[0], 'A', layerNames);
    return;
  }

  el.innerHTML =
    head +
    partial +
    periodComparison(results, periods, layerNames) +
    periods
      .map(
        (p, i) => `
        <details class="period-details" ${i === 0 ? 'open' : ''}>
          <summary><span class="dot" style="--c:${p.color}"></span>Period ${p.key} details <span class="muted">${escapeHtml(p.label)}</span></summary>
          ${periodDetails(results[i], p.key, layerNames)}
        </details>`,
      )
      .join('');
}

function periodDetails(r, periodKey, layerNames) {
  const comparisons = r.comparisons.length
    ? `<div class="compare">
         <h3>Sensor comparison</h3>
         ${r.comparisons
           .map(
             (c) => `<div class="compare-row">
                <span>${escapeHtml(layerNames[c.layerA] || c.layerA)} vs ${escapeHtml(layerNames[c.layerB] || c.layerB)}</span>
                <span><b>${c.countRatio == null ? '–' : nf(c.countRatio, 2) + '×'}</b> detections · <b>${c.frpRatio == null ? '–' : nf(c.frpRatio, 2) + '×'}</b> FRP</span>
              </div>`,
           )
           .join('')}
       </div>`
    : '';
  return r.layers.map((s) => layerCard(s, periodKey)).join('') + comparisons;
}

/** Period A vs B: per-layer table with change, plus a per-day chart of both periods aligned by day number. */
function periodComparison(results, periods, layerNames) {
  const [a, b] = results;
  const [pa, pb] = periods;
  const rows = a.layers
    .map((la) => {
      const lb = b.layers.find((x) => x.layerId === la.layerId);
      if (!lb) return '';
      return `
        <tr class="pc-layer"><th colspan="4">${escapeHtml(layerNames[la.layerId] || la.name)}</th></tr>
        <tr><td>Detections</td><td>${nf(la.count)}</td><td>${nf(lb.count)}</td>${change(la.count, lb.count)}</tr>
        <tr><td>Total FRP, MW</td><td>${nf(la.frp.sum)}</td><td>${nf(lb.frp.sum)}</td>${change(la.frp.sum, lb.frp.sum)}</tr>
        <tr><td>Mean FRP, MW</td><td>${nf(la.frp.mean, 1)}</td><td>${nf(lb.frp.mean, 1)}</td>${change(la.frp.mean, lb.frp.mean)}</tr>`;
    })
    .join('');

  return `
    <div class="period-compare">
      <h3>Period A vs Period B</h3>
      <table class="pc-table">
        <thead><tr><th></th>
          <th><span class="dot" style="--c:${pa.color}"></span>A</th>
          <th><span class="dot" style="--c:${pb.color}"></span>B</th>
          <th title="Change of A relative to B">A vs B</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${dualDailyChart(results, periods)}
    </div>`;
}

function change(a, b) {
  if (!b) return `<td class="chg">${a ? 'new' : '–'}</td>`;
  const pct = ((a - b) / b) * 100;
  const cls = pct > 0.5 ? 'up' : pct < -0.5 ? 'down' : '';
  const sign = pct > 0 ? '+' : '';
  return `<td class="chg ${cls}">${sign}${nf(pct, 0)}%</td>`;
}

/** Total detections per day (all selected layers) — A and B side by side for each day number. */
function dualDailyChart(results, periods) {
  const series = results.map((r) => {
    const n = r.layers[0]?.daily.length ?? 0;
    return Array.from({ length: n }, (_, i) => ({
      date: r.layers[0].daily[i].date,
      count: r.layers.reduce((sum, l) => sum + (l.daily[i]?.count ?? 0), 0),
    }));
  });
  const len = Math.max(...series.map((s) => s.length));
  if (len < 2) return '';
  const max = Math.max(1, ...series.flat().map((d) => d.count));
  const w = 300, h = 60, gap = len > 20 ? 1 : 2;
  const gw = (w - gap * (len - 1)) / len; // group width
  const bw = gw / series.length;
  let bars = '';
  for (let i = 0; i < len; i++) {
    series.forEach((s, k) => {
      const d = s[i];
      if (!d) return;
      const bh = d.count === 0 ? 0 : Math.max(1.5, (d.count / max) * (h - 4));
      bars += `<rect data-period="${periods[k].key}" data-date="${d.date}" x="${(i * (gw + gap) + k * bw).toFixed(2)}" y="${(h - bh).toFixed(2)}" width="${Math.max(0.5, bw - 0.4).toFixed(2)}" height="${bh.toFixed(2)}" rx="0.8" style="fill:${periods[k].color}"><title>Period ${periods[k].key} · ${d.date}: ${nf(d.count)} detections</title></rect>`;
    });
  }
  return `
    <div class="bar-label"><span>Detections per day (all selected layers)</span><span>max ${nf(max)}</span></div>
    <svg class="daily dual" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Detections per day, period A and B">${bars}</svg>
    <div class="axis"><span>Day 1</span><span>Day ${len}</span></div>`;
}

function layerCard(s, periodKey) {
  const total = Math.max(1, s.count);
  const pct = (v) => ((v / total) * 100).toFixed(1);
  return `
  <article class="layer-card" style="--c:${s.color}">
    <header>
      <span class="swatch"></span>
      <h3>${escapeHtml(s.name)}</h3>
      <span class="big">${nf(s.count)}</span>
    </header>
    <dl class="kv">
      <div><dt>Total FRP</dt><dd>${nf(s.frp.sum)} MW</dd></div>
      <div><dt>Mean / median</dt><dd>${nf(s.frp.mean, 1)} / ${nf(s.frp.median, 1)}</dd></div>
      <div><dt>Max FRP</dt><dd>${nf(s.frp.max, 1)} MW</dd></div>
      <div><dt>Density</dt><dd>${nf(s.densityPer1000Km2, 2)} /1000 km²</dd></div>
    </dl>
    ${s.count > 0 ? `
    <div class="bar-label"><span>Day ${nf(s.dayCount)}</span><span>Night ${nf(s.nightCount)}</span></div>
    <div class="split" role="img" aria-label="Day ${s.dayCount}, night ${s.nightCount}">
      <span class="seg day" style="width:${pct(s.dayCount)}%"></span><span class="seg night" style="width:${pct(s.nightCount)}%"></span>
    </div>
    <div class="bar-label"><span>Confidence</span><span>low ${nf(s.confidence.low)} · nom ${nf(s.confidence.nominal)} · high ${nf(s.confidence.high)}</span></div>
    <div class="split" role="img" aria-label="Confidence low ${s.confidence.low}, nominal ${s.confidence.nominal}, high ${s.confidence.high}">
      <span class="seg c-low" style="width:${pct(s.confidence.low)}%"></span><span class="seg c-nom" style="width:${pct(s.confidence.nominal)}%"></span><span class="seg c-high" style="width:${pct(s.confidence.high)}%"></span>
    </div>
    ${dailyChart(s.daily, periodKey)}` : '<p class="muted small">No detections in this area and period.</p>'}
    ${s.partial ? '<p class="stats-warn small">Partial: some tiles missing.</p>' : ''}
  </article>`;
}

/** Per-day detections as a small inline SVG bar chart. */
function dailyChart(daily, periodKey) {
  if (daily.length < 2) return '';
  const max = Math.max(1, ...daily.map((d) => d.count));
  const w = 300, h = 54, gap = daily.length > 20 ? 1 : 2;
  const bw = (w - gap * (daily.length - 1)) / daily.length;
  const bars = daily
    .map((d, i) => {
      const bh = d.count === 0 ? 0 : Math.max(1.5, (d.count / max) * (h - 4));
      return `<rect data-period="${periodKey}" data-date="${d.date}" x="${(i * (bw + gap)).toFixed(2)}" y="${(h - bh).toFixed(2)}" width="${bw.toFixed(2)}" height="${bh.toFixed(2)}" rx="1"><title>${d.date}: ${nf(d.count)} detections, ${nf(d.frpSum)} MW</title></rect>`;
    })
    .join('');
  return `
    <div class="bar-label"><span>Detections per day</span><span>max ${nf(max)}</span></div>
    <svg class="daily" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Detections per day">${bars}</svg>
    <div class="axis"><span>${daily[0].date.slice(5)}</span><span>${daily[daily.length - 1].date.slice(5)}</span></div>`;
}

function groupBy(arr, fn) {
  const m = new Map();
  for (const x of arr) {
    const k = fn(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}
