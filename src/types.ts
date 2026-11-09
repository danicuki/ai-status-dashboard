export type ProviderId = 'claude' | 'openai' | 'gemini';

export const PROVIDER_ORDER: ProviderId[] = ['claude', 'openai', 'gemini'];

/** What a meter represents. `session` and `week` are rolling usage windows; `credits` is a money budget. */
export type MeterRole = 'session' | 'week' | 'credits' | 'other';

/** A usage window as reported by the provider (percent of the window's allowance already used). */
export interface WindowReading {
  kind: 'window';
  id: string;
  label: string;
  role: MeterRole;
  /** 0–100 (may exceed 100 on some providers). null = provider did not report it. */
  usedPct: number | null;
  /** ISO timestamp when the window resets. null = no active window (e.g. no session started). */
  resetsAt: string | null;
  windowSeconds: number;
}

/** A money budget spread over a fixed period (e.g. US$ 1000 of GCP credits over 3 months). */
export interface BudgetReading {
  kind: 'budget';
  id: string;
  label: string;
  role: MeterRole;
  used: number;
  total: number;
  currency: string;
  periodStart: string;
  periodEnd: string;
  /** When the underlying data was last updated (billing exports lag a few hours). */
  dataAsOf?: string | null;
  /** Credit name as shown in the billing console (display only). */
  name?: string | null;
  /** Raise a renewal alert this many days before periodEnd (e.g. request new credits 15 days ahead). */
  renewDays?: number | null;
}

export type Reading = WindowReading | BudgetReading;

export type Tone = 'neutral' | 'good' | 'warn' | 'bad';

export interface Extra {
  id: string;
  label: string;
  value: string;
  tone?: Tone;
}

/** Raw data collected from one provider at one moment. Pace is computed later, at read time. */
export interface ProviderSnapshot {
  provider: ProviderId;
  fetchedAt: string;
  source: string;
  plan?: string | null;
  readings: Reading[];
  extras?: Extra[];
}

export type PaceStatus = 'under' | 'on_pace' | 'over' | 'limit' | 'idle' | 'ended' | 'unknown';

export interface Meter {
  id: string;
  label: string;
  role: MeterRole;
  kind: 'window' | 'budget';
  status: PaceStatus;
  statusLabel: string;
  /** Share of the allowance already used, 0–100+. */
  usedPct: number | null;
  /** Share of the window/period already elapsed, 0–100. This is the "expected" usage for a linear pace. */
  elapsedPct: number | null;
  /** usedPct − elapsedPct, in percentage points. Positive = consuming faster than the pace. */
  deltaPct: number | null;
  /** Soft-clamped position for gauges: −1 (well below pace) … 0 (on pace) … +1 (well above pace). */
  gauge: number | null;
  /** Usage expected at the end of the window if the current rate continues. */
  projectedPct: number | null;
  startsAt: string | null;
  resetsAt: string | null;
  secondsLeft: number | null;
  /** When the allowance runs out at the current rate (only if before the reset). */
  exhaustsAt: string | null;
  /** Short human summary, e.g. "34% used · expected 29%" */
  summary: string;
  /** Secondary line, e.g. "resets in 2d 4h" */
  detail: string;
  /** Budgets: when the money expires, e.g. "expires in 21 days (Dec 1) · request more from Nov 16" */
  expiry?: string | null;
  /** Something that needs action now (e.g. credits about to expire). */
  alert?: string | null;
  /** Budget-only fields. */
  used?: number;
  total?: number;
  currency?: string;
  burnPerDay?: number | null;
  allowancePerDay?: number | null;
  projectedUsed?: number | null;
  dataAsOf?: string | null;
}

export interface ProviderStatus {
  id: ProviderId;
  name: string;
  short: string;
  enabled: boolean;
  /** The dashboard may offer a field to type the amount used. */
  acceptsManual: boolean;
  source: string | null;
  plan: string | null;
  status: PaceStatus;
  statusLabel: string;
  fetchedAt: string | null;
  stale: boolean;
  error: { message: string; code: string; at: string } | null;
  /** The meter that drives the main indicator: week (subscriptions) or credits (budgets). */
  primary: Meter | null;
  session: Meter | null;
  meters: Meter[];
  extras: Extra[];
  /** Action items (e.g. "credits expire in 12 days — request more"). */
  alerts: string[];
}

export interface StatusResponse {
  app: 'ai-pace';
  version: string;
  generatedAt: string;
  refreshMinutes: number;
  tolerancePct: number;
  overall: { status: PaceStatus; statusLabel: string };
  providers: ProviderStatus[];
}
