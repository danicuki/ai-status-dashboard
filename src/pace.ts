import type { BudgetReading, Meter, PaceStatus, Reading, WindowReading } from './types.ts';
import { STATUS_LABEL, fmtDuration, fmtMoney, fmtPct, getLocale } from './format.ts';

const DAY_MS = 86_400_000;
/** Projections are noise at the very start of a window; below this share of elapsed time we don't project. */
const MIN_ELAPSED_FOR_PROJECTION = 5;
/** A delta of this many percentage points maps to gauge ≈ ±0.76 (tanh(1)). */
const GAUGE_SCALE = 25;

export interface PaceOptions {
  /** Deviation (in percentage points) still considered "on pace". */
  tolerancePct: number;
}

/**
 * The whole idea in one function: with a linear pace, by the time X% of the window has elapsed
 * you should have used at most X% of the allowance.
 */
export function classify(usedPct: number, elapsedPct: number, tolerancePct: number): PaceStatus {
  if (usedPct >= 100) return 'limit';
  const delta = usedPct - elapsedPct;
  if (delta > tolerancePct) return 'over';
  if (delta < -tolerancePct) return 'under';
  return 'on_pace';
}

/** Soft clamp so small deviations are visible and large ones never fall off the gauge. */
export function gaugeFor(deltaPct: number): number {
  return round(Math.tanh(deltaPct / GAUGE_SCALE), 3);
}

export function computeMeter(r: Reading, now: number, opts: PaceOptions): Meter {
  return r.kind === 'budget' ? computeBudgetMeter(r, now, opts) : computeWindowMeter(r, now, opts);
}

export function computeWindowMeter(r: WindowReading, now: number, opts: PaceOptions): Meter {
  if (r.usedPct == null || !Number.isFinite(r.usedPct)) return blank(r, 'unknown', 'no data');
  const used = Math.max(0, r.usedPct);
  const noWindowText = r.role === 'session' ? 'no active session' : 'window not started';

  if (!r.resetsAt) {
    if (used <= 0) return { ...blank(r, 'idle', noWindowText), usedPct: 0 };
    return { ...blank(r, used >= 100 ? 'limit' : 'unknown', `${fmtPct(used)} used`), usedPct: round(used, 1) };
  }

  const end = Date.parse(r.resetsAt);
  const windowMs = r.windowSeconds * 1000;
  if (!Number.isFinite(end) || !(windowMs > 0)) return blank(r, 'unknown', 'invalid window data');
  const start = end - windowMs;

  if (now >= end) {
    // The window rolled over since the last fetch: usage is back to zero until the next refresh.
    return { ...blank(r, 'idle', r.role === 'session' ? 'no active session' : 'window reset', 'waiting for refresh'), usedPct: 0 };
  }

  const elapsedPct = clamp(((now - start) / windowMs) * 100, 0, 100);
  const deltaPct = used - elapsedPct;
  const status = classify(used, elapsedPct, opts.tolerancePct);
  const projectedPct = elapsedPct >= MIN_ELAPSED_FOR_PROJECTION ? (used / elapsedPct) * 100 : null;
  const exhaustsAt = exhaustion(start, end, now, used, projectedPct);
  const secondsLeft = (end - now) / 1000;

  let detail = `resets in ${fmtDuration(secondsLeft)}`;
  if (status === 'limit') detail = `frees up in ${fmtDuration(secondsLeft)}`;
  else if (exhaustsAt) detail = `at this pace runs out in ${fmtDuration((Date.parse(exhaustsAt) - now) / 1000)} · resets in ${fmtDuration(secondsLeft)}`;

  return {
    id: r.id,
    label: r.label,
    role: r.role,
    kind: 'window',
    status,
    statusLabel: STATUS_LABEL[status],
    usedPct: round(used, 1),
    elapsedPct: round(elapsedPct, 1),
    deltaPct: round(deltaPct, 1),
    gauge: gaugeFor(deltaPct),
    projectedPct: projectedPct == null ? null : round(projectedPct, 0),
    startsAt: new Date(start).toISOString(),
    resetsAt: new Date(end).toISOString(),
    secondsLeft: Math.round(secondsLeft),
    exhaustsAt,
    summary: `${fmtPct(used)} used · expected ${fmtPct(elapsedPct)}`,
    detail,
  };
}

export function computeBudgetMeter(r: BudgetReading, now: number, opts: PaceOptions): Meter {
  const start = Date.parse(r.periodStart);
  const end = Date.parse(r.periodEnd);
  const used = Math.max(0, r.used);
  const money = (v: number) => fmtMoneySmart(v, r.currency);
  const budgetFields = { used: round(used, 2), total: r.total, currency: r.currency, dataAsOf: r.dataAsOf ?? null };

  if (!Number.isFinite(start) || !Number.isFinite(end) || !(end > start) || !(r.total > 0)) {
    return { ...blank(r, 'unknown', 'invalid period or total'), ...budgetFields };
  }
  const usedPct = (used / r.total) * 100;
  const usedSummary = `${money(used)} of ${money(r.total)}`;
  const renew = r.renewDays != null && r.renewDays > 0 ? r.renewDays : null;

  if (now < start) {
    return { ...blank(r, 'idle', usedSummary, `starts in ${fmtDuration((start - now) / 1000)}`), ...budgetFields, usedPct: round(usedPct, 1) };
  }
  if (now >= end) {
    return {
      ...blank(r, 'ended', usedSummary, `${money(Math.max(0, r.total - used))} left unused`),
      ...budgetFields,
      usedPct: round(usedPct, 1),
      elapsedPct: 100,
      expiry: `expired on ${fmtDate(end)}`,
      alert: renew != null ? 'credits expired — set up the new credit' : null,
    };
  }

  const elapsedPct = clamp(((now - start) / (end - start)) * 100, 0, 100);
  const deltaPct = usedPct - elapsedPct;
  const status = classify(usedPct, elapsedPct, opts.tolerancePct);
  const daysElapsed = (now - start) / DAY_MS;
  const daysLeft = (end - now) / DAY_MS;
  const burnPerDay = daysElapsed >= 0.25 ? used / daysElapsed : null;
  const allowancePerDay = daysLeft > 0 ? Math.max(0, r.total - used) / daysLeft : null;
  const projectedPct = elapsedPct >= MIN_ELAPSED_FOR_PROJECTION ? (usedPct / elapsedPct) * 100 : null;
  const projectedUsed = projectedPct == null ? null : (r.total * projectedPct) / 100;
  const exhaustsAt = exhaustion(start, end, now, usedPct, projectedPct);
  const secondsLeft = (end - now) / 1000;

  const parts: string[] = [];
  if (status === 'limit') parts.push('credits used up');
  else if (exhaustsAt) parts.push(`at this pace runs out in ${fmtDuration((Date.parse(exhaustsAt) - now) / 1000)}`);
  else if (projectedUsed != null && projectedUsed < r.total) parts.push(`at this pace ~${money(r.total - projectedUsed)} goes unused`);
  if (burnPerDay != null && allowancePerDay != null && status !== 'limit') {
    parts.push(`spending ${money(burnPerDay)}/day, budget allows ${money(allowancePerDay)}/day`);
  }

  const days = Math.floor(daysLeft);
  const daysText = days < 1 ? 'less than 1 day' : days === 1 ? '1 day' : `${days} days`;
  let expiry = `expires in ${daysText} (${fmtDate(end)})`;
  let alert: string | null = null;
  if (renew != null) {
    if (daysLeft <= renew) alert = `credits expire in ${daysText} — request more`;
    else expiry += ` · request more from ${fmtDate(end - renew * DAY_MS)}`;
  }

  return {
    id: r.id,
    label: r.label,
    role: r.role,
    kind: 'budget',
    status,
    statusLabel: STATUS_LABEL[status],
    usedPct: round(usedPct, 1),
    elapsedPct: round(elapsedPct, 1),
    deltaPct: round(deltaPct, 1),
    gauge: gaugeFor(deltaPct),
    projectedPct: projectedPct == null ? null : round(projectedPct, 0),
    startsAt: new Date(start).toISOString(),
    resetsAt: new Date(end).toISOString(),
    secondsLeft: Math.round(secondsLeft),
    exhaustsAt,
    summary: `${usedSummary} · expected ${money((r.total * elapsedPct) / 100)}`,
    detail: parts.join(' · '),
    expiry,
    alert,
    ...budgetFields,
    burnPerDay: burnPerDay == null ? null : round(burnPerDay, 2),
    allowancePerDay: allowancePerDay == null ? null : round(allowancePerDay, 2),
    projectedUsed: projectedUsed == null ? null : round(projectedUsed, 2),
  };
}

/** "Dec 1" (en-US) in the server's time zone (TZ) and LOCALE. */
function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString(getLocale(), { month: 'short', day: 'numeric' });
}

/** If the current rate would exhaust the allowance before the window ends, when? */
function exhaustion(start: number, end: number, now: number, usedPct: number, projectedPct: number | null): string | null {
  if (!(usedPct > 0) || usedPct >= 100 || projectedPct == null || projectedPct <= 100) return null;
  const t = start + (now - start) * (100 / usedPct);
  return t < end ? new Date(t).toISOString() : null;
}

function blank(r: Reading, status: PaceStatus, summary: string, detail = ''): Meter {
  return {
    id: r.id,
    label: r.label,
    role: r.role,
    kind: r.kind,
    status,
    statusLabel: STATUS_LABEL[status],
    usedPct: null,
    elapsedPct: null,
    deltaPct: null,
    gauge: null,
    projectedPct: null,
    startsAt: null,
    resetsAt: r.kind === 'window' ? r.resetsAt : r.periodEnd,
    secondsLeft: null,
    exhaustsAt: null,
    summary,
    detail,
  };
}

/** Whole units for big amounts ("US$ 312"), cents for small ones ("US$ 3,40"). */
function fmtMoneySmart(v: number, currency: string): string {
  return fmtMoney(v, currency, Math.abs(v) >= 100);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
