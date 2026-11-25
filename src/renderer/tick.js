'use strict';
// Server tick helpers, shared by the main process (require) and the renderer (<script>): pure functions only.
//   stripColours(text)            remove ANSI escapes and Minecraft section-sign colour codes
//   parseTickNumber(text)         first number of a text, tolerant of colour codes, thousands separators, decimal commas and units
//   classify(value, metric)       'good' | 'warn' | 'bad' | '' (no thresholds) by the metric's thresholds / tickTarget
//   aggregateTick(rows, mode)     header "Tick" stat over the running servers that report a tick metric
(function (root) {
  const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;            // CSI sequences (colours, cursor)
  const SECTION = /Â?§[0-9a-fk-orx]/gi;                  // Minecraft colour codes, also when mis-decoded as Latin-1 ("Â§")
  function stripColours(s) { return String(s == null ? '' : s).replace(ANSI, '').replace(SECTION, ''); }

  /** "§a20.0", "*20.0", "1,234.5 ms", "20,0", "12.3ms", "\x1b[32m19.8\x1b[0m" -> number, or NaN. */
  function parseTickNumber(text) {
    const m = /(-?)(\d+(?:[.,]\d+)*)/.exec(stripColours(text));
    if (!m) return NaN;
    let t = m[2];
    const dot = t.includes('.'); const comma = t.includes(',');
    if (dot && comma) { const dec = t.lastIndexOf('.') > t.lastIndexOf(',') ? '.' : ','; const th = dec === '.' ? ',' : '.'; t = t.split(th).join('').replace(dec, '.'); }
    else if (comma) t = /^\d{1,3}(,\d{3})+$/.test(t) ? t.split(',').join('') : t.replace(',', '.');
    else if (dot && (t.match(/\./g) || []).length > 1) t = t.split('.').join('');
    const v = Number(t);
    return Number.isFinite(v) ? (m[1] ? -v : v) : NaN;
  }

  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  /**
   * Colour class of a value. higherIsBetter (default true): bad when < badBelow, warn when < warnBelow.
   * lower is better: bad when > badAbove, warn when > warnAbove. Without thresholds a tickTarget gives defaults:
   * higher: warn < 90% / bad < 75% of the target; lower: warn > target / bad > 2 x target. No thresholds, no target: ''.
   */
  function classify(value, metric) {
    const v = num(value); const m = metric || {};
    if (v === null) return '';
    const higher = m.higherIsBetter !== false; const target = num(m.tickTarget);
    if (higher) {
      const bad = num(m.badBelow) ?? (target ? target * 0.75 : null); const warn = num(m.warnBelow) ?? (target ? target * 0.9 : null);
      if (bad === null && warn === null) return '';
      if (bad !== null && v < bad) return 'bad'; if (warn !== null && v < warn) return 'warn'; return 'good';
    }
    const bad = num(m.badAbove) ?? (target ? target * 2 : null); const warn = num(m.warnAbove) ?? (target || null);
    if (bad === null && warn === null) return '';
    if (bad !== null && v > bad) return 'bad'; if (warn !== null && v > warn) return 'warn'; return 'good';
  }

  const RANK = { bad: 3, warn: 2, good: 1, '': 0 };
  const fmt = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
  const label = (t) => `${fmt(t.value)}${t.unit ? ' ' + t.unit : ''}`;

  /**
   * Header "Tick" stat. rows: [{ name, pid?, status?, tick: { value, unit, name, cls, higherIsBetter } | null }] (snapshot rows).
   * Only running servers (pid set, or status Started/Starting when there is no pid field) that report a tick metric count.
   * mode "worst" (default): the worst server (by colour, then value in the bad direction); "avg": mean when all use the same unit
   * and direction, otherwise falls back to worst. Returns { text, cls, title, count }.
   */
  function aggregateTick(rows, mode) {
    const list = (rows || []).filter((r) => r && r.tick && num(r.tick.value) !== null && (r.pid || r.status === 'Started' || r.status === 'Starting'));
    if (!list.length) return { text: 'n/a', cls: '', count: 0, title: 'No running server reports a tick metric. Latency (query round trip) is shown in the table / dashboard.' };
    const title = list.map((r) => `${r.name}: ${label(r.tick)} (${r.tick.name || 'Tick'})`).join('\n');
    const sameKind = list.every((r) => r.tick.unit === list[0].tick.unit && (r.tick.higherIsBetter !== false) === (list[0].tick.higherIsBetter !== false));
    if (mode === 'avg' && sameKind && list.length > 1) {
      const avg = list.reduce((n, r) => n + r.tick.value, 0) / list.length;
      const t = { value: avg, unit: list[0].tick.unit };
      return { text: `${label(t)} avg`, cls: list.map((r) => r.tick.cls || '').sort((a, b) => RANK[b] - RANK[a])[0] || '', count: list.length, title };
    }
    const worse = (a, b) => {
      const d = RANK[b.tick.cls || ''] - RANK[a.tick.cls || '']; if (d) return d;
      return a.tick.higherIsBetter === false ? b.tick.value - a.tick.value : a.tick.value - b.tick.value;
    };
    const w = [...list].sort(worse)[0];
    const tag = list.length > 1 ? (w.tick.higherIsBetter === false ? ' max' : ' min') : '';
    return { text: label(w.tick) + tag, cls: w.tick.cls || '', count: list.length, title: `${title}${list.length > 1 ? `
Shown: worst (${w.name})` : ''}` };
  }

  const api = { stripColours, parseTickNumber, classify, aggregateTick };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.NGSMTick = api;
})(typeof window !== 'undefined' ? window : globalThis);
