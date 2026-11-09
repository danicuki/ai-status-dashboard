import type { Meter, PaceStatus, ProviderStatus, StatusResponse } from './types.ts';
import { fmtDuration, fmtSigned } from './format.ts';

/** Status colors (dataviz reference status palette + the diverging cool pole for "under"). Same as public/style.css. */
export const STATUS_COLOR: Record<PaceStatus, string> = {
  over: '#ec835a',
  limit: '#d03b3b',
  on_pace: '#0ca30c',
  under: '#3987e5',
  idle: '#898781',
  ended: '#898781',
  unknown: '#898781',
};

/** Shape carries the meaning without color: ▲ above pace, ▼ below, ● on pace. */
export const STATUS_GLYPH: Record<PaceStatus, string> = {
  over: '▲',
  limit: '■',
  on_pace: '●',
  under: '▼',
  idle: '○',
  ended: '○',
  unknown: '?',
};

const ANSI: Record<PaceStatus, string> = {
  over: '\u001b[33m',
  limit: '\u001b[31m',
  on_pace: '\u001b[32m',
  under: '\u001b[34m',
  idle: '\u001b[90m',
  ended: '\u001b[90m',
  unknown: '\u001b[90m',
};
const ANSI_RESET = '\u001b[0m';
/** dataviz status "warning" step: action items such as credits about to expire. */
export const WARN_COLOR = '#fab219';

function meterLine(m: Meter): string {
  const delta = m.deltaPct == null ? '' : ` (${fmtSigned(m.deltaPct)})`;
  return `${m.label}: ${m.summary}${delta}`;
}

function ageText(iso: string | null, now: number): string {
  if (!iso) return 'never';
  return `${fmtDuration((now - Date.parse(iso)) / 1000)} ago`;
}

/** SwiftBar / xbar plugin output (macOS menu bar). Pipe characters are reserved by the format. */
export function renderSwiftbar(s: StatusResponse, dashboardUrl: string): string {
  const now = Date.parse(s.generatedAt);
  const clean = (t: string) => t.replace(/\|/g, '/');
  const lines: string[] = [];
  const title = s.providers.map((p) => `${ANSI[p.status]}${p.short}${STATUS_GLYPH[p.status]}${ANSI_RESET}${p.alerts.length ? '⚠' : ''}`).join(' ');
  lines.push(`${title || 'AI ?'} | ansi=true`);
  lines.push('---');
  for (const p of s.providers) {
    lines.push(`${p.name}${p.plan ? ` · ${clean(p.plan)}` : ''} — ${p.statusLabel} | color=${STATUS_COLOR[p.status]}`);
    for (const a of p.alerts) lines.push(`⚠ ${clean(a)} | color=${WARN_COLOR}`);
    for (const m of p.meters) {
      lines.push(`${STATUS_GLYPH[m.status]} ${clean(meterLine(m))} | color=${STATUS_COLOR[m.status]}`);
      if (m.detail) lines.push(`--${clean(m.detail)} | size=11`);
      if (m.expiry) lines.push(`--${clean(m.expiry)} | size=11`);
    }
    for (const x of p.extras) lines.push(`${clean(x.label)}: ${clean(x.value)} | size=12`);
    if (p.error) lines.push(`⚠ ${clean(p.error.message)} | color=${STATUS_COLOR.limit} size=11`);
    else if (p.stale) lines.push(`⚠ stale data (${ageText(p.fetchedAt, now)}) | size=11`);
    lines.push('---');
  }
  const newest = s.providers.map((p) => p.fetchedAt).filter(Boolean).sort().pop() ?? null;
  lines.push(`Updated ${ageText(newest, now)} | size=11`);
  lines.push(`Open dashboard | href=${dashboardUrl}`);
  lines.push('Refresh | refresh=true');
  return `${lines.join('\n')}\n`;
}

/** Waybar custom module (return-type: json). Text uses Pango markup for colored glyphs. */
export function renderWaybar(s: StatusResponse): object {
  const text = s.providers
    .map((p) => `<span color='${STATUS_COLOR[p.status]}'>${p.short}${STATUS_GLYPH[p.status]}</span>${p.alerts.length ? `<span color='${WARN_COLOR}'>⚠</span>` : ''}`)
    .join(' ');
  const tooltip = s.providers
    .map((p) => {
      const rows = [`<b>${esc(p.name)}</b> — ${esc(p.statusLabel)}`];
      for (const a of p.alerts) rows.push(`⚠ ${esc(a)}`);
      for (const m of p.meters) {
        rows.push(`${STATUS_GLYPH[m.status]} ${esc(meterLine(m))}${m.detail ? `\n    ${esc(m.detail)}` : ''}${m.expiry ? `\n    ${esc(m.expiry)}` : ''}`);
      }
      for (const x of p.extras) rows.push(`${esc(x.label)}: ${esc(x.value)}`);
      if (p.error) rows.push(`⚠ ${esc(p.error.message)}`);
      return rows.join('\n');
    })
    .join('\n\n');
  const primary = s.providers.map((p) => p.primary?.usedPct ?? 0);
  const hasAlert = s.providers.some((p) => p.alerts.length > 0);
  return {
    text: text || 'AI ?',
    tooltip,
    class: hasAlert ? [s.overall.status, 'alert'] : s.overall.status,
    alt: s.overall.status,
    percentage: Math.round(Math.max(0, ...primary)),
  };
}

function esc(t: string): string {
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

interface CompactMeter {
  status: PaceStatus;
  gauge: number | null;
  used: number | null;
  expected: number | null;
}

function compactMeter(m: Meter | null): CompactMeter | null {
  if (!m) return null;
  return { status: m.status, gauge: m.gauge, used: m.usedPct == null ? null : Math.round(m.usedPct), expected: m.elapsedPct == null ? null : Math.round(m.elapsedPct) };
}

/** Minimal payload for microcontrollers / LED boards (ESP32, Raspberry Pi Pico W, AWTRIX…). */
export function renderCompact(s: StatusResponse): object {
  return {
    t: s.generatedAt,
    overall: s.overall.status,
    providers: s.providers.map((p: ProviderStatus) => ({
      id: p.id,
      short: p.short,
      status: p.status,
      color: STATUS_COLOR[p.status],
      stale: p.stale,
      alert: p.alerts[0] ?? null,
      main: compactMeter(p.primary),
      session: compactMeter(p.session),
    })),
  };
}
