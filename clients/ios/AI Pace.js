// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: deep-gray; icon-glyph: tachometer-alt;

/*
 * AI Pace — iPhone widget (Scriptable app, free on the App Store).
 *
 * Install:
 *   1. Install Scriptable, create a new script and paste this whole file.
 *   2. Run the script once inside the app: it asks for the server URL (https://) and the API
 *      token, which are stored only in the iPhone Keychain (never in this file).
 *   3. Add a "Scriptable" widget to the Home Screen (small, medium or large) or the Lock Screen
 *      (rectangular, circular or inline) and pick this script.
 *      For the circular widget, the widget parameter picks the provider: claude, openai or gemini.
 *
 * Reading it: the middle line is the ideal pace. Dot above = using it too fast; below = room to
 * spare. Filled dot = week (or credits); ring = 5-hour session. ⚠ = action needed (e.g. credits
 * about to expire).
 *
 * Security: the script makes a single request (GET <server>/api/v1/status, https only, never
 * following redirects), reads no personal data from the iPhone and never runs code from outside.
 * From the server's response it only keeps short texts and numbers, with fixed types.
 */

const KEY_SERVER = 'ai-pace.server';
const KEY_TOKEN = 'ai-pace.token';
const REFRESH_MINUTES = 15;
const MAX_PROVIDERS = 5;
const STATUSES = ['over', 'limit', 'on_pace', 'under', 'idle', 'ended', 'unknown'];

const GLYPH = { over: '▲', limit: '■', on_pace: '●', under: '▼', idle: '○', ended: '○', unknown: '?' };
const SHORT = { over: 'Above', limit: 'At limit', on_pace: 'On pace', under: 'Below', idle: 'Idle', ended: 'Ended', unknown: 'No data' };
const HEX = {
  over: '#ec835a',
  limit: '#d03b3b',
  on_pace: '#0ca30c',
  under: ['#2a78d6', '#3987e5'],
  idle: '#898781',
  ended: '#898781',
  unknown: '#898781',
};
const WARN = '#fab219';
const C = {
  bg: Color.dynamic(new Color('#fcfcfb'), new Color('#1a1a19')),
  ink: Color.dynamic(new Color('#0b0b0b'), new Color('#f0efec')),
  ink2: Color.dynamic(new Color('#52514e'), new Color('#c3c2b7')),
  muted: new Color('#898781'),
};

function statusColor(status) {
  const v = HEX[status] || HEX.unknown;
  return Array.isArray(v) ? Color.dynamic(new Color(v[0]), new Color(v[1])) : new Color(v);
}

function signed(v) {
  if (v == null) return '';
  const r = Math.round(v);
  return r > 0 ? `+${r}` : r < 0 ? `−${-r}` : '0';
}

function pct(v) {
  return v == null ? '—' : `${Math.round(v)}%`;
}

function timeText(iso) {
  const d = new Date(iso);
  if (!iso || isNaN(d.getTime())) return '';
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

// ---------- settings (iPhone Keychain only) ----------
/** Only https: the token must never travel in cleartext (e.g. http:// over Wi-Fi). */
function isSecureUrl(url) {
  return /^https:\/\/[^\s?#]+$/i.test(url);
}

function getSettings() {
  const server = (Keychain.contains(KEY_SERVER) ? Keychain.get(KEY_SERVER) : '').replace(/\/+$/, '');
  const token = Keychain.contains(KEY_TOKEN) ? Keychain.get(KEY_TOKEN) : '';
  return { server, token };
}

async function askSettings(current) {
  const a = new Alert();
  a.title = 'AI Pace';
  a.message = 'Server https URL (e.g. your "tailscale serve" address) and API token ("npm run token" on the server).';
  a.addTextField('https://your-host.tailXXXX.ts.net', current.server || '');
  a.addSecureTextField('token', current.token || '');
  a.addAction('Save');
  a.addCancelAction('Cancel');
  if ((await a.presentAlert()) === -1) return null;
  const server = a.textFieldValue(0).trim().replace(/\/+$/, '');
  const token = a.textFieldValue(1).trim();
  if (!server || !token) return null;
  if (!isSecureUrl(server)) {
    const warn = new Alert();
    warn.title = 'URL not saved';
    warn.message = 'The URL must start with https:// so the token never travels unencrypted.';
    warn.addAction('OK');
    await warn.presentAlert();
    return null;
  }
  Keychain.set(KEY_SERVER, server);
  Keychain.set(KEY_TOKEN, token);
  return { server, token };
}

// ---------- data ----------
/** Strings from the server: control, zero-width and bidi-override characters removed, length capped. */
function text(v, max) {
  return typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '').slice(0, max) : '';
}
function numberIn(v, lo, hi) {
  return typeof v === 'number' && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null;
}
function statusOf(v) {
  return STATUSES.indexOf(v) >= 0 ? v : 'unknown';
}
function cleanMeter(m) {
  if (!m || typeof m !== 'object') return null;
  return {
    status: statusOf(m.status),
    gauge: numberIn(m.gauge, -1, 1),
    usedPct: numberIn(m.usedPct, 0, 1000),
    elapsedPct: numberIn(m.elapsedPct, 0, 100),
    deltaPct: numberIn(m.deltaPct, -1000, 1000),
    summary: text(m.summary, 80),
  };
}
/** Keep only the fields the widget draws, with fixed types and sizes; everything else is dropped. */
function sanitize(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.providers)) throw new Error('invalid server response');
  return {
    providers: data.providers
      .slice(0, MAX_PROVIDERS)
      .filter((p) => p && typeof p === 'object')
      .map((p) => ({
        id: text(p.id, 16),
        name: text(p.name, 20) || '?',
        short: text(p.short, 2) || '?',
        status: statusOf(p.status),
        fetchedAt: text(p.fetchedAt, 40),
        error: !!p.error,
        alerts: Array.isArray(p.alerts) ? p.alerts.slice(0, 2).map((a) => text(a, 80)).filter(Boolean) : [],
        primary: cleanMeter(p.primary),
        session: cleanMeter(p.session),
      })),
  };
}

async function loadStatus(settings) {
  const fm = FileManager.local();
  const cache = fm.joinPath(fm.cacheDirectory(), 'ai-pace-status.json');
  try {
    const req = new Request(`${settings.server}/api/v1/status`);
    req.headers = { Authorization: `Bearer ${settings.token}` };
    req.timeoutInterval = 15;
    req.onRedirect = () => null; // never follow redirects: the token goes only to the configured server
    const raw = await req.loadJSON();
    const code = req.response && req.response.statusCode;
    if (code !== 200) throw new Error(code === 401 ? 'invalid token' : `server answered HTTP ${code}`);
    const data = sanitize(raw);
    fm.writeString(cache, JSON.stringify(data));
    return { data, offline: false, error: null };
  } catch (e) {
    const error = text(String((e && e.message) || e), 120);
    try {
      if (fm.fileExists(cache)) return { data: sanitize(JSON.parse(fm.readString(cache))), offline: true, error };
    } catch (_) {
      // corrupt cache: ignore it
    }
    return { data: null, offline: true, error };
  }
}

// ---------- drawing ----------
function roundRect(dc, x, y, w, h, r, color) {
  const p = new Path();
  p.addRoundedRect(new Rect(x, y, w, h), r, r);
  dc.addPath(p);
  dc.setFillColor(color);
  dc.fillPath();
}

/**
 * The pace chart: one column per provider, ideal pace on the middle line.
 * mono = Lock Screen (iOS tints it), so meaning comes from position and glyphs, never color.
 */
function drawPace(providers, { width, height, mono = false, labels = 'glyph', fontSize = 11 }) {
  const dc = new DrawContext();
  dc.size = new Size(width, height);
  dc.opaque = false;
  dc.respectScreenScale = true;

  const white = (a) => new Color('#ffffff', a);
  const labelH = labels ? fontSize + 5 : 0;
  const top = 1;
  const plotH = height - labelH - 2;
  const mid = top + plotH / 2;
  const n = Math.max(1, providers.length);
  const colW = width / n;
  const scale = Math.max(4, plotH / 2 - 8);
  const yOf = (g) => mid - (g == null ? 0 : g) * scale;
  const big = Math.max(4.5, Math.min(8, plotH / 13));
  const small = Math.max(3, big * 0.6);

  if (!mono) {
    roundRect(dc, 0, top, width, plotH / 2, 6, new Color(HEX.over, 0.12));
    roundRect(dc, 0, mid, width, plotH / 2, 6, new Color(HEX.under[1], 0.12));
  }
  dc.setFillColor(mono ? white(0.65) : new Color('#898781', 0.9));
  dc.fillRect(new Rect(0, mid - 0.75, width, 1.5));

  providers.forEach((p, i) => {
    const cx = colW * (i + 0.5);
    const xMain = cx - big - 1;
    const xSess = cx + big + 1;
    const track = mono ? white(0.28) : new Color('#898781', 0.28);
    roundRect(dc, xMain - 3, top + 2, 6, plotH - 4, 3, track);
    roundRect(dc, xSess - 1, top + plotH * 0.1, 2, plotH * 0.8, 1, track);

    const s = p.session;
    if (s) {
      const active = s.gauge != null;
      dc.setStrokeColor(mono ? white(active ? 1 : 0.5) : statusColor(s.status));
      dc.setLineWidth(2);
      const y = yOf(s.gauge);
      dc.strokeEllipse(new Rect(xSess - small, y - small, small * 2, small * 2));
    }
    const m = p.primary;
    if (m) {
      const active = m.gauge != null;
      dc.setFillColor(mono ? white(active ? 1 : 0.5) : statusColor(m.status));
      const y = yOf(m.gauge);
      dc.fillEllipse(new Rect(xMain - big, y - big, big * 2, big * 2));
    }

    if (labels) {
      let label = `${p.short}${GLYPH[p.status]}`;
      if (labels === 'delta' && m && m.deltaPct != null) label += ` ${signed(m.deltaPct)}`;
      if (p.alerts.length) label += '⚠';
      dc.setFont(Font.semiboldSystemFont(fontSize));
      dc.setTextColor(mono ? white(1) : p.alerts.length ? new Color(WARN) : new Color('#898781'));
      dc.setTextAlignedCenter();
      dc.drawTextInRect(label, new Rect(colW * i, height - labelH, colW, labelH));
    }
  });
  return dc.getImage();
}

// ---------- widgets ----------
function newestFetch(data) {
  return data.providers.map((p) => p.fetchedAt).filter(Boolean).sort().pop();
}

function footerText(res) {
  const t = timeText(newestFetch(res.data));
  return res.offline ? `offline · ${t}` : t;
}

function errorWidget(message) {
  const w = new ListWidget();
  w.backgroundColor = C.bg;
  const t = w.addText('AI Pace');
  t.font = Font.semiboldSystemFont(13);
  t.textColor = C.ink;
  w.addSpacer(4);
  const e = w.addText(`⚠ ${message}`);
  e.font = Font.systemFont(11);
  e.textColor = C.ink2;
  e.minimumScaleFactor = 0.7;
  return w;
}

function header(w, res) {
  const row = w.addStack();
  row.layoutHorizontally();
  row.centerAlignContent();
  const title = row.addText('AI Pace');
  title.font = Font.semiboldSystemFont(11);
  title.textColor = C.ink2;
  row.addSpacer();
  const time = row.addText(footerText(res));
  time.font = Font.systemFont(10);
  time.textColor = res.offline ? statusColor('over') : C.muted;
}

function providerRow(stack, p, detailed) {
  const row = stack.addStack();
  row.layoutVertically();
  const top = row.addStack();
  top.layoutHorizontally();
  top.centerAlignContent();
  const name = top.addText(p.name);
  name.font = Font.semiboldSystemFont(13);
  name.textColor = C.ink;
  top.addSpacer();
  const glyph = top.addText(`${GLYPH[p.status]} `);
  glyph.font = Font.systemFont(11);
  glyph.textColor = statusColor(p.status);
  const label = top.addText(SHORT[p.status]);
  label.font = Font.systemFont(11);
  label.textColor = C.ink2;

  const m = p.primary;
  let line = m ? (m.usedPct != null && m.elapsedPct != null ? `${pct(m.usedPct)} · expected ${pct(m.elapsedPct)}` : m.summary) : 'no data';
  if (detailed && p.session && p.session.usedPct != null && p.session.gauge != null) line += ` · session ${pct(p.session.usedPct)}`;
  if (p.error) line = `⚠ ${line}`;
  // Medium widget: an alert replaces the numbers (it's the more urgent line). Large: both.
  if (p.alerts.length && !detailed) line = `⚠ ${p.alerts[0]}`;
  const sub = row.addText(line);
  sub.font = Font.systemFont(11);
  sub.textColor = p.alerts.length && !detailed ? new Color(WARN) : C.ink2;
  sub.lineLimit = 1;
  sub.minimumScaleFactor = 0.75;
  if (detailed && p.alerts.length) {
    const alert = row.addText(`⚠ ${p.alerts[0]}`);
    alert.font = Font.semiboldSystemFont(11);
    alert.textColor = new Color(WARN);
    alert.lineLimit = 1;
    alert.minimumScaleFactor = 0.75;
  }
}

function smallWidget(res) {
  const w = new ListWidget();
  w.backgroundColor = C.bg;
  w.setPadding(12, 12, 10, 12);
  header(w, res);
  w.addSpacer(6);
  const img = w.addImage(drawPace(res.data.providers, { width: 134, height: 106, labels: 'glyph', fontSize: 11 }));
  img.imageSize = new Size(134, 106);
  img.centerAlignImage();
  return w;
}

function mediumWidget(res) {
  const w = new ListWidget();
  w.backgroundColor = C.bg;
  w.setPadding(12, 14, 12, 14);
  const body = w.addStack();
  body.layoutHorizontally();
  body.centerAlignContent();
  const img = body.addImage(drawPace(res.data.providers, { width: 120, height: 126, labels: 'glyph', fontSize: 11 }));
  img.imageSize = new Size(120, 126);
  body.addSpacer(14);
  const right = body.addStack();
  right.layoutVertically();
  header(right, res);
  right.addSpacer(4);
  res.data.providers.forEach((p, i) => {
    if (i) right.addSpacer(4);
    providerRow(right, p, false);
  });
  return w;
}

function largeWidget(res) {
  const w = new ListWidget();
  w.backgroundColor = C.bg;
  w.setPadding(14, 16, 14, 16);
  header(w, res);
  w.addSpacer(8);
  const img = w.addImage(drawPace(res.data.providers, { width: 300, height: 150, labels: 'delta', fontSize: 12 }));
  img.imageSize = new Size(300, 150);
  img.centerAlignImage();
  w.addSpacer(10);
  res.data.providers.forEach((p, i) => {
    if (i) w.addSpacer(8);
    providerRow(w, p, true);
  });
  w.addSpacer();
  return w;
}

function rectangularWidget(res) {
  const w = new ListWidget();
  w.setPadding(0, 0, 0, 0);
  const img = w.addImage(drawPace(res.data.providers, { width: 156, height: 66, mono: true, labels: 'delta', fontSize: 10 }));
  img.imageSize = new Size(156, 66);
  img.centerAlignImage();
  return w;
}

function circularWidget(res, param) {
  const ps = res.data.providers;
  const severity = { limit: 6, over: 5, on_pace: 3, under: 2, idle: 1, ended: 1, unknown: 0 };
  const p = (param && ps.find((x) => x.id === param)) || ps.slice().sort((a, b) => severity[b.status] - severity[a.status])[0];
  const w = new ListWidget();
  w.addAccessoryWidgetBackground = true;
  w.setPadding(4, 4, 4, 4);
  if (!p) {
    w.addText('?');
    return w;
  }
  const img = w.addImage(drawPace([p], { width: 54, height: 54, mono: true, labels: 'delta', fontSize: 10 }));
  img.imageSize = new Size(54, 54);
  img.centerAlignImage();
  return w;
}

function inlineWidget(res) {
  const w = new ListWidget();
  const line = res.data.providers
    .map((p) => `${p.short}${GLYPH[p.status]}${p.primary && p.primary.deltaPct != null ? signed(p.primary.deltaPct) : ''}${p.alerts.length ? '⚠' : ''}`)
    .join('  ');
  w.addText(res.offline ? `${line} · offline` : line);
  return w;
}

function buildWidget(family, res, param) {
  if (!res.data) return errorWidget(res.error || 'no data');
  if (!res.data.providers.length) return errorWidget('no provider configured on the server');
  switch (family) {
    case 'medium':
      return mediumWidget(res);
    case 'large':
    case 'extraLarge':
      return largeWidget(res);
    case 'accessoryRectangular':
      return rectangularWidget(res);
    case 'accessoryCircular':
      return circularWidget(res, param);
    case 'accessoryInline':
      return inlineWidget(res);
    default:
      return smallWidget(res);
  }
}

// ---------- main ----------
let settings = getSettings();
if (config.runsInApp && (!settings.server || !settings.token || !isSecureUrl(settings.server))) {
  settings = (await askSettings(settings)) || settings;
}

let widget;
if (!settings.server || !settings.token) {
  widget = errorWidget('open the Scriptable app and run this script to set it up');
} else if (!isSecureUrl(settings.server)) {
  widget = errorWidget('the server URL must use https:// — run the script in the app to fix it');
} else {
  const res = await loadStatus(settings);
  if (config.runsInWidget) {
    widget = buildWidget(config.widgetFamily, res, (args.widgetParameter || '').trim().toLowerCase());
  } else {
    const menu = new Alert();
    menu.title = 'AI Pace';
    menu.message = res.error ? `⚠ ${res.error}` : 'Preview the widget';
    const options = [
      ['Small', 'small'],
      ['Medium', 'medium'],
      ['Large', 'large'],
      ['Lock Screen (rectangular)', 'accessoryRectangular'],
      ['Lock Screen (circular)', 'accessoryCircular'],
    ];
    for (const [label] of options) menu.addAction(label);
    menu.addAction('Change server/token');
    menu.addCancelAction('Close');
    const choice = await menu.presentAlert();
    if (choice === options.length) {
      await askSettings(settings);
    } else if (choice >= 0) {
      const family = options[choice][1];
      widget = buildWidget(family, res, '');
      const present = {
        small: 'presentSmall',
        medium: 'presentMedium',
        large: 'presentLarge',
        accessoryRectangular: 'presentAccessoryRectangular',
        accessoryCircular: 'presentAccessoryCircular',
      }[family];
      await widget[present]();
    }
  }
  if (widget) {
    // Opens the dashboard without the token in the URL (the browser asks for it once and remembers it).
    widget.url = `${settings.server}/`;
  }
}

if (widget) {
  widget.refreshAfterDate = new Date(Date.now() + REFRESH_MINUTES * 60 * 1000);
  Script.setWidget(widget);
}
Script.complete();
