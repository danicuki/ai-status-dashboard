// AI Pace dashboard — vanilla JS, no build step. Reads /api/v1/status and draws the pace chart.
const GLYPH = { over: '▲', limit: '■', on_pace: '●', under: '▼', idle: '○', ended: '○', unknown: '?' };
const SHORT = { over: 'Above', limit: 'At limit', on_pace: 'On pace', under: 'Below', idle: 'Idle', ended: 'Ended', unknown: 'No data' };
const SVGNS = 'http://www.w3.org/2000/svg';
const TOKEN_KEY = 'aipace.token';
const POLL_MS = 60_000;

const $ = (sel) => document.querySelector(sel);
const state = { token: null, data: null, timer: null };

// ---------- tiny DOM helpers ----------
function h(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  setAttrs(e, attrs);
  for (const c of children.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : String(c));
  return e;
}
function s(tag, attrs = {}, ...children) {
  const e = document.createElementNS(SVGNS, tag);
  setAttrs(e, attrs);
  for (const c of children.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : String(c));
  return e;
}
function setAttrs(e, attrs) {
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : String(v));
  }
}

// ---------- storage (may be unavailable in private mode) ----------
function store(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {}
}
function recall(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

// ---------- formatting (browser locale) ----------
const pct = (v) => (v == null ? '—' : `${Math.round(v)}%`);
function money(v, currency) {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: Math.abs(v) >= 100 ? 0 : 2 }).format(v);
  } catch {
    return `${currency} ${Math.round(v)}`;
  }
}
function signed(v) {
  const r = Math.round(v);
  return r > 0 ? `+${r}` : r < 0 ? `−${-r}` : '0';
}
function ago(iso) {
  if (!iso) return 'never';
  const sec = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (sec < 60) return 'just now';
  if (sec < 3600) return `${Math.round(sec / 60)} min ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ${Math.round((sec % 3600) / 60)}m ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}
function deltaText(m) {
  if (m?.deltaPct == null) return '';
  const r = Math.round(m.deltaPct);
  if (r === 0) return 'exactly on pace';
  return `${signed(r)} pts ${r > 0 ? 'above' : 'below'} pace`;
}
function meterTip(p, m, kind) {
  const lines = [`${p.name} · ${m.label}`, `${GLYPH[m.status]} ${m.statusLabel}`, m.summary];
  const d = deltaText(m);
  if (d) lines.push(d);
  if (m.detail) lines.push(m.detail);
  if (m.expiry) lines.push(m.expiry);
  if (kind === 'session' && m.status === 'idle') lines.push('the ring moves once a session starts');
  return lines.join('\n');
}

// ---------- API ----------
async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { Authorization: `Bearer ${state.token}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (res.status === 401) {
    const err = new Error('invalid token');
    err.status = 401;
    throw err;
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

async function load({ force = false } = {}) {
  if (!state.token) return showLogin();
  const btn = $('#refresh');
  btn.classList.add('spinning');
  btn.disabled = true;
  try {
    state.data = force ? await api('/api/v1/refresh', { method: 'POST' }) : await api('/api/v1/status');
    $('#error').hidden = true;
    $('#login').hidden = true;
    render();
  } catch (e) {
    if (e.status === 401) {
      store(TOKEN_KEY, null);
      state.token = null;
      showLogin('Invalid token. Paste the correct one.');
    } else {
      showError(`Can't reach the server: ${e.message}`);
    }
  } finally {
    btn.classList.remove('spinning');
    btn.disabled = false;
  }
}

function showLogin(message) {
  $('#login').hidden = false;
  $('#hero').hidden = true;
  $('#cards').replaceChildren();
  $('#updated').textContent = message || 'enter the token to continue';
  $('#token-input').focus();
}

function showError(message) {
  const el = $('#error');
  el.textContent = message;
  el.hidden = false;
}

// ---------- render ----------
function render() {
  const d = state.data;
  $('#hero').hidden = false;
  const newest = d.providers.map((p) => p.fetchedAt).filter(Boolean).sort().pop();
  $('#updated').textContent = d.providers.length ? `data ${ago(newest)} · refreshes every ${d.refreshMinutes} min` : 'no provider configured';
  renderPlot(d.providers);
  $('#cards').replaceChildren(...d.providers.map(renderCard));
  $('#foot').replaceChildren(
    `Linear pace: when X% of the period has passed, you should have used at most X% of the allowance. Tolerance ±${d.tolerancePct} pts. `,
    'Other formats: ',
    h('a', { href: '#', onclick: openFormat('status') }, 'JSON'),
    ', ',
    h('a', { href: '#', onclick: openFormat('compact') }, 'compact (LED)'),
    '.',
  );
}

function openFormat(name) {
  return async (ev) => {
    ev.preventDefault();
    // Fetched with the header (never ?token=) so the token doesn't land in a URL or the browser history.
    const data = await api(`/api/v1/${name}`);
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    window.open(url, '_blank', 'noopener');
  };
}

/** Value (0–100 %) → vertical position inside a lane, as a CSS/SVG percentage (0 % at the bottom). */
const yOf = (v) => `${96 - Math.max(0, Math.min(100, v ?? 0)) * 0.92}%`;
const AXIS_TICKS = [100, 75, 50, 25, 0];

/**
 * Pace chart: one column per provider on a shared 0–100 % scale. The dot is how much you've used,
 * the dash is how much you should have used by now; the line between them shows how far off pace you are.
 */
function renderPlot(providers) {
  const plot = $('#plot');
  plot.style.setProperty('--n', String(Math.max(1, providers.length)));
  const children = [
    h('div', { class: 'axis', 'aria-hidden': 'true' }, AXIS_TICKS.map((v) => h('span', { style: `top:${yOf(v)}` }, `${v}%`))),
    h('div', { class: 'gridlines', 'aria-hidden': 'true' }, AXIS_TICKS.map((v) => h('i', { style: `top:${yOf(v)}` }))),
  ];
  providers.forEach((p, i) => {
    const warn = p.alerts.length ? p.alerts.join('\n') : p.error ? p.error.message : p.stale ? 'stale data' : null;
    children.push(h('div', { class: 'lane', style: `grid-column:${i + 2}` }, laneSvg(p)));
    children.push(
      h(
        'div',
        { class: 'col-label', style: `grid-column:${i + 2}` },
        h('div', { class: 'col-name' }, p.name, warn ? h('span', { class: 'warn-mark', title: warn }, '⚠') : null),
        h('div', { class: 'col-status', title: p.statusLabel }, h('i', { class: `g ${p.status}`, 'aria-hidden': 'true' }, GLYPH[p.status]), ' ', SHORT[p.status]),
        p.primary?.usedPct != null && p.primary.elapsedPct != null
          ? h('div', { class: 'col-sub' }, h('span', {}, `${pct(p.primary.usedPct)} used`), h('span', {}, `expected ${pct(p.primary.elapsedPct)}`))
          : h('div', { class: 'col-sub' }, p.primary?.summary ?? 'no data'),
      ),
    );
  });
  plot.replaceChildren(...children);
  plot.setAttribute('role', 'img');
  plot.setAttribute(
    'aria-label',
    providers.map((p) => `${p.name}: ${p.statusLabel}${p.primary ? `, ${p.primary.label} ${p.primary.summary}` : ''}`).join('; '),
  );
}

function laneSvg(p) {
  // Inner <svg x="50%"> puts the origin at the column's center; y is in % so no measuring is needed.
  const inner = s('svg', { x: '50%', y: '0', overflow: 'visible' });
  inner.append(
    s('rect', { class: 'track', x: -14, y: '4%', width: 8, height: '92%', rx: 4 }),
    s('rect', { class: 'track-thin', x: 13, y: '4%', width: 3, height: '92%', rx: 1.5 }),
  );
  if (p.session) inner.append(marker(p, p.session, 'session', 14.5));
  if (p.primary) inner.append(marker(p, p.primary, 'primary', -10));
  else inner.append(s('text', { class: 'nodata', x: 0, y: '50%', 'text-anchor': 'middle', dy: '-14' }, 'no data'));
  return s('svg', { 'aria-hidden': 'true' }, inner);
}

function marker(p, m, kind, cx) {
  const primary = kind === 'primary';
  const cy = yOf(m.usedPct);
  const tip = meterTip(p, m, kind);
  const g = s('g', {
    tabindex: 0,
    onpointerenter: (e) => showTip(e, tip),
    onpointermove: (e) => moveTip(e),
    onpointerleave: hideTip,
    onfocus: (e) => showTipAt(e.currentTarget, tip),
    onblur: hideTip,
    onclick: (e) => showTip(e, tip),
  });
  g.append(s('circle', { class: 'hit', cx, cy, r: 18 }));
  if (m.elapsedPct != null && m.usedPct != null) {
    const ey = yOf(m.elapsedPct);
    // Line from "expected now" to "used": its length is how far off pace you are.
    g.append(s('line', { class: `gap ${m.status}`, x1: cx, x2: cx, y1: ey, y2: cy, 'stroke-width': primary ? 4 : 2.5 }));
    const half = primary ? 13 : 8;
    g.append(s('line', { class: 'expected', x1: cx - half, x2: cx + half, y1: ey, y2: ey, 'stroke-width': primary ? 3 : 2 }));
  }
  if (primary) g.append(s('circle', { class: `dot ${m.status}`, cx, cy, r: 10 }));
  else g.append(s('circle', { class: `ring ${m.status}`, cx, cy, r: 6 }));
  return g;
}

// ---------- tooltip ----------
function showTip(e, text) {
  const tip = $('#tip');
  tip.textContent = text;
  tip.hidden = false;
  moveTip(e);
}
function moveTip(e) {
  const tip = $('#tip');
  if (tip.hidden) return;
  const pad = 12;
  const { innerWidth: w } = window;
  const r = tip.getBoundingClientRect();
  let x = e.clientX + pad;
  if (x + r.width > w - 8) x = e.clientX - r.width - pad;
  tip.style.left = `${Math.max(8, x)}px`;
  tip.style.top = `${Math.max(8, e.clientY - r.height - pad)}px`;
}
function showTipAt(target, text) {
  const b = target.getBoundingClientRect();
  showTip({ clientX: b.right, clientY: b.top }, text);
}
function hideTip() {
  $('#tip').hidden = true;
}
document.addEventListener('scroll', hideTip, { passive: true });
document.addEventListener('pointerdown', (e) => {
  if (!e.target.closest?.('.lane g')) hideTip();
});

// ---------- provider cards ----------
function renderCard(p) {
  const card = h(
    'article',
    { class: 'card provider' },
    h(
      'header',
      { class: 'p-head' },
      h('h2', {}, p.name, p.plan ? h('span', { class: 'plan' }, p.plan) : null),
      h('span', { class: 'chip' }, h('i', { class: `g ${p.status}`, 'aria-hidden': 'true' }, GLYPH[p.status]), ' ', p.statusLabel),
    ),
  );
  for (const a of p.alerts) card.append(h('p', { class: 'p-alert', role: 'status' }, `⚠ ${a}`));
  for (const m of p.meters) card.append(renderMeter(m));
  if (p.extras.length) {
    card.append(
      h(
        'dl',
        { class: 'extras' },
        p.extras.map((x) => h('div', {}, h('dt', {}, x.label), h('dd', { class: x.tone ? `tone-${x.tone}` : null }, x.value))),
      ),
    );
  }
  if (p.error) card.append(h('p', { class: 'p-error' }, `⚠ ${p.error.message}`));
  else if (p.stale && p.fetchedAt) card.append(h('p', { class: 'p-error' }, `⚠ stale data (${ago(p.fetchedAt)})`));
  if (p.acceptsManual) card.append(manualForm(p));
  const src = p.source ? sourceLabel(p.source) : null;
  card.append(h('p', { class: 'p-meta' }, [src, p.fetchedAt ? `updated ${ago(p.fetchedAt)}` : null].filter(Boolean).join(' · ')));
  return card;
}

function renderMeter(m) {
  let value = m.summary;
  let expected = null;
  if (m.kind === 'budget' && m.used != null && m.total != null) {
    value = `${money(m.used, m.currency)} of ${money(m.total, m.currency)}`;
    if (m.elapsedPct != null) expected = `expected ${money((m.total * m.elapsedPct) / 100, m.currency)}`;
  } else if (m.usedPct != null) {
    value = `${pct(m.usedPct)}${m.elapsedPct != null ? ` · expected ${pct(m.elapsedPct)}` : ''}`;
  }
  const sub = [expected, deltaText(m), m.detail].filter(Boolean).join(' · ');
  const bar = h('div', { class: 'bar', role: 'img', 'aria-label': `${m.label}: ${m.summary}` });
  bar.append(h('div', { class: `fill ${m.status}`, style: `width:${Math.min(100, m.usedPct ?? 0)}%` }));
  if (m.elapsedPct != null) bar.append(h('div', { class: 'tick', style: `left:${m.elapsedPct}%`, title: `expected now: ${pct(m.elapsedPct)}` }));
  return h(
    'div',
    { class: 'meter' },
    h('div', { class: 'meter-top' }, h('span', { class: 'label' }, h('i', { class: `g ${m.status}`, 'aria-hidden': 'true' }, GLYPH[m.status]), ' ', m.label), h('span', { class: 'value' }, value)),
    bar,
    sub ? h('div', { class: 'meter-sub' }, sub) : null,
    m.expiry ? h('div', { class: 'meter-sub' }, m.expiry) : null,
  );
}

function sourceLabel(source) {
  const map = {
    'claude-oauth': 'source: Claude (OAuth)',
    'codex-oauth': 'source: Codex (OAuth)',
    'gcp-bigquery': 'source: BigQuery billing export',
    'gcp-budget': 'source: Cloud Billing budget updates',
    manual: 'source: entered manually',
  };
  if (source.startsWith('push:')) return `${map[source.slice(5)] ?? source.slice(5)} via push`;
  return map[source] ?? `source: ${source}`;
}

function manualForm(p) {
  const current = p.primary?.used;
  const input = h('input', {
    type: 'number',
    min: '0',
    step: '0.01',
    inputmode: 'decimal',
    value: current != null ? String(current) : '',
    'aria-label': 'Amount used so far',
    placeholder: '0.00',
  });
  return h(
    'form',
    {
      class: 'manual',
      onsubmit: async (e) => {
        e.preventDefault();
        const used = Number(String(input.value).replace(',', '.'));
        if (!Number.isFinite(used) || used < 0) return;
        try {
          state.data = await api('/api/v1/manual/gemini', { method: 'PUT', body: JSON.stringify({ used }) });
          render();
        } catch (err) {
          showError(err.message);
        }
      },
    },
    h('label', {}, `Amount used so far (${p.primary?.currency ?? 'USD'}):`),
    input,
    h('button', { type: 'submit' }, 'Save'),
  );
}

// ---------- boot ----------
// ?theme=light|dark forces a theme (e.g. a wall display); default follows the system.
const forcedTheme = new URLSearchParams(location.search).get('theme');
if (forcedTheme === 'light' || forcedTheme === 'dark') document.documentElement.dataset.theme = forcedTheme;

function readTokenFromUrl() {
  const m = location.hash.match(/token=([^&]+)/);
  if (!m) return null;
  history.replaceState(null, '', location.pathname + location.search);
  return decodeURIComponent(m[1]);
}

$('#login-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const t = $('#token-input').value.trim();
  if (!t) return;
  state.token = t;
  store(TOKEN_KEY, t);
  load();
});
$('#refresh').addEventListener('click', () => load({ force: true }));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') load();
});

const fromUrl = readTokenFromUrl();
if (fromUrl) store(TOKEN_KEY, fromUrl);
state.token = fromUrl || recall(TOKEN_KEY);
load();
state.timer = setInterval(() => {
  if (document.visibilityState === 'visible') load();
}, POLL_MS);
