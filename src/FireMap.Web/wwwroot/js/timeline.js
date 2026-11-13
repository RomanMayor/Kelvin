// Day-by-day playback of the loaded hot spots. Purely client-side: whole ranges are already loaded,
// the timeline only tells the layers which day to show — no extra NASA requests.
// With two periods (compare mode) days are aligned by position: step 3 = 3rd day of A and 3rd day of B.

const $ = (id) => document.getElementById(id);
const ICON_PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg>';

export class Timeline {
  /** @param {{ onDay: (days: Record<string, string|null> | null) => void }} hooks  null = show all days */
  constructor(hooks) {
    this.hooks = hooks;
    this.el = $('timeline');
    this.slider = $('tl-slider');
    this.bars = $('tl-bars');
    this.playBtn = $('tl-play');
    this.periods = []; // [{ key, from, to, color, label, days: [...] }]
    this.length = 0;
    this.index = 0;
    this.counts = {};
    this.playing = false;
    this.timer = null;

    this.playBtn.addEventListener('click', () => (this.playing ? this.pause() : this.play()));
    $('tl-prev').addEventListener('click', () => this.step(-1, { user: true }));
    $('tl-next').addEventListener('click', () => this.step(1, { user: true }));
    this.slider.addEventListener('input', () => this.go(Number(this.slider.value), { user: true }));
    $('tl-speed').addEventListener('change', () => this.playing && this._schedule());
    this.bars.addEventListener('click', (e) => {
      const bar = e.target.closest('[data-index]');
      if (bar) this.go(Number(bar.dataset.index), { user: true });
    });
  }

  get visible() {
    return !this.el.hidden;
  }

  /** Current day per period ({ A: 'yyyy-mm-dd', B: ... }), or null when the timeline is off. */
  get days() {
    if (!this.visible) return null;
    return Object.fromEntries(this.periods.map((p) => [p.key, p.days[this.index] ?? null]));
  }

  open(periods) {
    this.el.hidden = false;
    document.body.classList.add('timeline-on');
    this.setPeriods(periods);
    this.play();
  }

  close() {
    this.pause();
    this.el.hidden = true;
    document.body.classList.remove('timeline-on');
    this.hooks.onDay(null);
  }

  /** New period(s): restart from the first day (keeps playing if it was). */
  setPeriods(periods) {
    this.periods = periods.map((p) => ({ ...p, days: enumerateDays(p.from, p.to) }));
    this.length = Math.max(0, ...this.periods.map((p) => p.days.length));
    this.el.classList.toggle('comparing', this.periods.length > 1);
    this.slider.max = String(Math.max(0, this.length - 1));
    const a = this.periods[0];
    $('tl-start').textContent = this.periods.length > 1 ? 'Day 1' : shortDate(a?.days[0]);
    $('tl-end').textContent = this.periods.length > 1 ? `Day ${this.length}` : shortDate(a?.days.at(-1));
    this._renderBars();
    this.go(0);
  }

  /** Detections per period and day ({ A: Map(day → n), B: ... }) — drives the mini histogram. */
  setCounts(counts) {
    this.counts = counts;
    this._renderBars();
    this._updateInfo();
  }

  go(i, { user = false } = {}) {
    if (this.length === 0) return;
    if (user) this.pause(); // manual control takes over
    this.index = ((i % this.length) + this.length) % this.length; // loop around both ends
    this.slider.value = String(this.index);
    this._updateInfo();
    this.hooks.onDay(this.days);
  }

  step(delta, opts) {
    this.go(this.index + delta, opts);
  }

  play() {
    this.playing = true;
    this.playBtn.innerHTML = ICON_PAUSE;
    this.playBtn.setAttribute('aria-label', 'Pause');
    this._schedule();
  }

  pause() {
    this.playing = false;
    clearInterval(this.timer);
    this.playBtn.innerHTML = ICON_PLAY;
    this.playBtn.setAttribute('aria-label', 'Play');
  }

  _schedule() {
    clearInterval(this.timer);
    this.timer = setInterval(() => this.step(1), Number($('tl-speed').value) || 1000);
  }

  _count(p, i) {
    const day = p.days[i];
    return day ? this.counts[p.key]?.get(day) ?? 0 : 0;
  }

  _renderBars() {
    let max = 1;
    for (const p of this.periods) for (let i = 0; i < p.days.length; i++) max = Math.max(max, this._count(p, i));

    const html = [];
    for (let i = 0; i < this.length; i++) {
      const spans = this.periods
        .map((p) => {
          const c = this._count(p, i);
          const h = c === 0 ? 0 : Math.max(6, (c / max) * 100);
          return `<span style="height:${h}%;--c:${p.color}"></span>`;
        })
        .join('');
      const title = this.periods.map((p) => `${p.days[i] ?? '—'}: ${this._count(p, i).toLocaleString()}`).join(' | ');
      html.push(`<button type="button" class="tl-bar${i === this.index ? ' current' : ''}" data-index="${i}" title="${title}" aria-label="${title}">${spans}</button>`);
    }
    this.bars.innerHTML = html.join('');
  }

  _updateInfo() {
    if (this.length === 0) return;
    const multi = this.periods.length > 1;
    $('tl-date').innerHTML = this.periods
      .map((p) => {
        const day = p.days[this.index];
        const dot = multi ? `<span class="tl-dot" style="--c:${p.color}"></span>` : '';
        return `<span class="tl-period">${dot}${day ? longDate(day) : '—'}</span>`;
      })
      .join('');
    const counts = this.periods.map((p) => (multi ? `${p.key} ${this._count(p, this.index).toLocaleString()}` : `${this._count(p, this.index).toLocaleString()} detections`));
    $('tl-count').textContent = `${counts.join(' · ')} · day ${this.index + 1} of ${this.length}`;
    for (const bar of this.bars.children) bar.classList.toggle('current', Number(bar.dataset.index) === this.index);
  }
}

function enumerateDays(from, to) {
  const out = [];
  for (let t = Date.parse(from + 'T00:00:00Z'); t <= Date.parse(to + 'T00:00:00Z'); t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

const longDate = (d) =>
  new Date(d + 'T00:00:00Z').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

const shortDate = (d) =>
  d ? new Date(d + 'T00:00:00Z').toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' }) : '';
