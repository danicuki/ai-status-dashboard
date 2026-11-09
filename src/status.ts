import { PROVIDER_ORDER, type Meter, type PaceStatus, type ProviderStatus, type StatusResponse } from './types.ts';
import type { Provider } from './providers/provider.ts';
import { PROVIDER_META } from './providers/provider.ts';
import type { State } from './store.ts';
import { computeMeter } from './pace.ts';
import { STATUS_LABEL, worstStatus } from './format.ts';

export interface StatusOptions {
  version: string;
  refreshMinutes: number;
  tolerancePct: number;
}

/** Pace is computed at read time, so "expected usage" keeps moving between data refreshes. */
export function buildStatus(providers: Provider[], state: State, opts: StatusOptions, now = Date.now()): StatusResponse {
  const staleAfterMs = Math.max(opts.refreshMinutes * 2.5, 45) * 60_000;
  const byId = new Map(providers.map((p) => [p.id, p]));

  const list: ProviderStatus[] = [];
  for (const id of PROVIDER_ORDER) {
    const p = byId.get(id);
    const snap = state.snapshots[id];
    const err = state.errors[id];
    // Show configured providers, plus any provider whose data was pushed from elsewhere.
    if (!p?.enabled && !snap) continue;

    const meters: Meter[] = snap ? snap.readings.map((r) => computeMeter(r, now, opts)) : [];
    const primary = meters.find((m) => m.role === 'week') ?? meters.find((m) => m.role === 'credits') ?? meters.find((m) => m.role !== 'session') ?? null;
    const session = meters.find((m) => m.role === 'session') ?? null;
    const main = [primary, session].filter((m): m is Meter => m !== null);

    let status: PaceStatus = 'unknown';
    if (main.some((m) => m.status === 'limit')) status = 'limit';
    else if (primary) status = primary.status;
    else if (session) status = session.status;

    const fetchedAt = snap?.fetchedAt ?? null;
    list.push({
      id,
      name: p?.name ?? PROVIDER_META[id].name,
      short: p?.short ?? PROVIDER_META[id].short,
      enabled: p?.enabled ?? false,
      acceptsManual: p?.enabled === true && p.acceptsManual === true,
      source: snap?.source ?? null,
      plan: snap?.plan ?? null,
      status,
      statusLabel: STATUS_LABEL[status],
      fetchedAt,
      stale: !fetchedAt || now - Date.parse(fetchedAt) > staleAfterMs,
      error: err && (!fetchedAt || Date.parse(err.at) >= Date.parse(fetchedAt)) ? err : null,
      primary,
      session,
      meters,
      extras: snap?.extras ?? [],
      alerts: meters.map((m) => m.alert).filter((a): a is string => !!a),
    });
  }

  const overall = worstStatus(list.map((p) => p.status));
  return {
    app: 'ai-pace',
    version: opts.version,
    generatedAt: new Date(now).toISOString(),
    refreshMinutes: opts.refreshMinutes,
    tolerancePct: opts.tolerancePct,
    overall: { status: overall, statusLabel: STATUS_LABEL[overall] },
    providers: list,
  };
}
