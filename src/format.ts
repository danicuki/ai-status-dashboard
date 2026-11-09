import type { PaceStatus } from './types.ts';

export const STATUS_LABEL: Record<PaceStatus, string> = {
  over: 'Above pace',
  on_pace: 'On pace',
  under: 'Below pace',
  limit: 'Limit reached',
  idle: 'Idle',
  ended: 'Period ended',
  unknown: 'No data',
};

let locale = 'en-US';

/** Locale for numbers, money and dates in server-generated text (LOCALE env, default en-US). */
export function setLocale(value: string): void {
  try {
    new Intl.NumberFormat(value);
    locale = value;
    moneyFormatters.clear();
  } catch {
    // invalid locale: keep the default
  }
}

export function getLocale(): string {
  return locale;
}

/** Which status is "worse" when several are combined into one indicator. */
export const STATUS_SEVERITY: Record<PaceStatus, number> = {
  limit: 6,
  over: 5,
  on_pace: 3,
  under: 2,
  idle: 1,
  ended: 1,
  unknown: 0,
};

export function worstStatus(statuses: PaceStatus[]): PaceStatus {
  let worst: PaceStatus = 'unknown';
  for (const s of statuses) if (STATUS_SEVERITY[s] > STATUS_SEVERITY[worst]) worst = s;
  return worst;
}

/** "2d 4h", "3h 20m", "45m", "<1m" */
export function fmtDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 60) return '<1m';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

export function fmtPct(v: number): string {
  return `${Math.round(v)}%`;
}

/** Signed integer with a real minus sign: "+5", "−12", "0". */
export function fmtSigned(v: number): string {
  const r = Math.round(v);
  if (r > 0) return `+${r}`;
  if (r < 0) return `−${Math.abs(r)}`;
  return '0';
}

const moneyFormatters = new Map<string, Intl.NumberFormat>();

export function fmtMoney(v: number, currency: string, compact = false): string {
  const key = `${currency}:${compact}`;
  let f = moneyFormatters.get(key);
  if (!f) {
    try {
      f = new Intl.NumberFormat(locale, {
        style: 'currency',
        currency,
        maximumFractionDigits: compact ? 0 : 2,
        minimumFractionDigits: compact ? 0 : 2,
      });
    } catch {
      f = new Intl.NumberFormat(locale, { maximumFractionDigits: compact ? 0 : 2 });
    }
    moneyFormatters.set(key, f);
  }
  return f.format(v);
}

/** Number of fraction digits a currency uses (USD → 2, JPY → 0). Used to convert minor units. */
export function currencyDigits(currency: string): number {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}
