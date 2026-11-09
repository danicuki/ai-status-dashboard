import type { Extra, ProviderSnapshot } from '../types.ts';
import { ProviderError, toProviderError } from '../lib/errors.ts';
import { getServiceAccountToken, type ServiceAccount } from '../lib/google.ts';
import { fetchJson } from '../lib/http.ts';
import { isObj, num, obj, str } from '../lib/json.ts';
import { fmtMoney } from '../format.ts';
import { PROVIDER_META, type Provider } from './provider.ts';
import { isCurrent, pullBudgetNotices, type BudgetNotice, type PubSubConfig } from './gcp-budgets.ts';

export interface BigQueryConfig {
  /** Fully qualified billing export table: project.dataset.gcp_billing_export_v1_XXXXXX_XXXXXX_XXXXXX */
  table: string;
  serviceAccount: ServiceAccount;
  /** Project that runs (and is billed for) the query job. Defaults to the service account's project. */
  jobProject: string;
  /** Only count costs from these projects (empty = whole billing account). */
  projectIds: string[];
  /** credits: sum of the promotional credits consumed; cost: gross cost (before credits). */
  measure: 'credits' | 'cost';
  creditTypes: string[];
  location: string | null;
  apiBase: string;
  tokenUrl: string | null;
}

export interface GeminiConfig {
  enabled: boolean;
  /** Credit name from the billing console, for display. */
  creditName: string | null;
  /** Alert this many days before the credits expire (time to request new ones). */
  renewDays: number;
  total: number;
  currency: string;
  periodStart: string;
  periodEnd: string;
  /** Spending that happened before the billing export was enabled (the export isn't retroactive). */
  offset: number;
  /** Manual mode starting value (GEMINI_CREDIT_USED); the dashboard can update it later. */
  initialUsed: number | null;
  bigquery: BigQueryConfig | null;
  /** Budget notifications via Pub/Sub (preferred automatic source; see scripts/setup-gcp-budget.sh). */
  pubsub: PubSubConfig | null;
  configError: string | null;
}

/** What the Gemini provider keeps in the server's state between refreshes. */
export interface GeminiState {
  getManual(): ManualValue | undefined;
  getBudgets(): Record<string, BudgetNotice>;
  setBudget(notice: BudgetNotice): void;
}

export interface ManualValue {
  used: number;
  updatedAt: string;
  /** Which credit the value belongs to (see creditKey): a value typed for an old credit never applies to a new one. */
  key?: string;
}

export function creditKey(cfg: Pick<GeminiConfig, 'periodStart' | 'periodEnd' | 'total'>): string {
  return `${cfg.periodStart}|${cfg.periodEnd}|${cfg.total}`;
}

const BQ_SCOPE = 'https://www.googleapis.com/auth/bigquery';
const AUTH_HINT = 'The service account needs the "BigQuery Data Viewer" (on the export dataset) and "BigQuery Job User" (on the project) roles.';
const PUBSUB_HINT = 'The service account needs the "Pub/Sub Subscriber" role on the subscription (scripts/setup-gcp-budget.sh grants it).';

export function createGeminiProvider(cfg: GeminiConfig, state: GeminiState): Provider {
  const meta = PROVIDER_META.gemini;

  return {
    id: 'gemini',
    name: meta.name,
    short: meta.short,
    enabled: cfg.enabled,
    acceptsManual: !cfg.bigquery && !cfg.pubsub,
    describe: () =>
      cfg.pubsub
        ? `GCP credits via Cloud Billing budget notifications (Pub/Sub) · ${cfg.pubsub.subscription}`
        : cfg.bigquery
          ? `GCP credits via the BigQuery billing export · ${cfg.bigquery.table}`
          : 'GCP credits in manual mode (update the amount used from the dashboard)',
    async fetch(): Promise<ProviderSnapshot> {
      if (cfg.configError) throw new ProviderError(cfg.configError, 'not_configured');
      const extras: Extra[] = [];
      let used: number;
      let dataAsOf: string | null = null;
      let source: string;

      if (cfg.pubsub) {
        const ps = cfg.pubsub;
        let fresh: Map<string, BudgetNotice>;
        try {
          fresh = await pullBudgetNotices(ps);
        } catch (e) {
          throw toProviderError(e, meta.name, PUBSUB_HINT);
        }
        for (const n of fresh.values()) {
          const prev = state.getBudgets()[n.name];
          if (!prev || prev.publishedAt <= n.publishedAt) state.setBudget(n);
        }
        const known = state.getBudgets();
        const pick = (name: string) => (known[name] && isCurrent(known[name], ps.since) ? known[name] : undefined);
        const gross = pick(ps.grossBudget);
        const net = pick(ps.netBudget);
        source = 'gcp-budget';
        if (!gross) {
          used = cfg.offset;
          extras.push({ id: 'waiting', label: 'Status', value: "waiting for Google's first budget update (can take a few hours)", tone: 'warn' });
        } else {
          // Promotional credits consumed since the budgets started = gross cost − cost after promotions.
          used = cfg.offset + (net ? Math.max(0, gross.cost - net.cost) : gross.cost);
          dataAsOf = [gross.publishedAt, net?.publishedAt].filter((t): t is string => !!t).sort()[0] ?? null;
          if (!net) extras.push({ id: 'net', label: 'Note', value: 'net budget not reported yet: counting the gross cost', tone: 'warn' });
          if (gross.currency && gross.currency !== cfg.currency) {
            extras.push({ id: 'currency', label: 'Warning', value: `billing is in ${gross.currency} but the total is configured in ${cfg.currency}`, tone: 'warn' });
          }
          extras.push({ id: 'gross', label: 'Total cost since setup', value: fmtMoney(gross.cost, gross.currency ?? cfg.currency), tone: 'neutral' });
        }
      } else if (cfg.bigquery) {
        let r: BillingTotals;
        try {
          r = await queryBillingExport(cfg.bigquery, cfg.periodStart, cfg.periodEnd);
        } catch (e) {
          throw toProviderError(e, meta.name, AUTH_HINT);
        }
        used = (cfg.bigquery.measure === 'credits' ? r.creditsUsed : r.grossCost) + cfg.offset;
        dataAsOf = r.lastExport;
        source = 'gcp-bigquery';
        if (r.currency && r.currency !== cfg.currency) {
          extras.push({ id: 'currency', label: 'Warning', value: `billing is in ${r.currency} but the total is configured in ${cfg.currency}`, tone: 'warn' });
        }
        if (cfg.bigquery.measure === 'credits') {
          extras.push({ id: 'gross', label: 'Gross cost in period', value: fmtMoney(r.grossCost + cfg.offset, cfg.currency), tone: 'neutral' });
        }
      } else {
        const stored = state.getManual();
        const m = stored && stored.key === creditKey(cfg) ? stored : undefined;
        const v = m?.used ?? cfg.initialUsed;
        if (v == null) {
          throw new ProviderError(
            'Enter how much of the credits has been used ("Amount used" on the dashboard, or GEMINI_CREDIT_USED), or set up the BigQuery billing export.',
            'not_configured',
          );
        }
        used = v;
        dataAsOf = m?.updatedAt ?? null;
        source = 'manual';
      }

      extras.push({ id: 'remaining', label: 'Remaining', value: fmtMoney(Math.max(0, cfg.total - used), cfg.currency), tone: 'neutral' });

      return {
        provider: 'gemini',
        fetchedAt: new Date().toISOString(),
        source,
        plan: cfg.creditName ?? 'GCP credits',
        readings: [
          {
            kind: 'budget',
            id: 'credits',
            label: 'Credits',
            role: 'credits',
            used: Math.round(used * 100) / 100,
            total: cfg.total,
            currency: cfg.currency,
            periodStart: cfg.periodStart,
            periodEnd: cfg.periodEnd,
            dataAsOf,
            name: cfg.creditName,
            renewDays: cfg.renewDays,
          },
        ],
        extras,
      };
    },
  };
}

export interface BillingTotals {
  grossCost: number;
  /** Positive amount of credits consumed in the period. */
  creditsUsed: number;
  lastExport: string | null;
  currency: string | null;
}

export function buildBillingQuery(bq: Pick<BigQueryConfig, 'table' | 'projectIds'>): string {
  if (!/^[A-Za-z0-9_.:-]+$/.test(bq.table) || bq.table.split('.').length !== 3) {
    throw new ProviderError(`Invalid GCP_BILLING_TABLE: "${bq.table}". Use project.dataset.table.`, 'not_configured');
  }
  const where = ['usage_start_time >= @start', 'usage_start_time < @end'];
  if (bq.projectIds.length) where.push('project.id IN UNNEST(@projects)');
  return [
    'SELECT',
    '  IFNULL(SUM(cost), 0) AS gross_cost,',
    '  IFNULL(SUM((SELECT IFNULL(SUM(c.amount), 0) FROM UNNEST(credits) AS c WHERE c.type IN UNNEST(@credit_types))), 0) AS credit_amount,',
    "  FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', MAX(export_time)) AS last_export,",
    '  ANY_VALUE(currency) AS currency',
    `FROM \`${bq.table}\``,
    `WHERE ${where.join('\n  AND ')}`,
  ].join('\n');
}

function bqTimestamp(iso: string): string {
  return new Date(iso).toISOString().replace('T', ' ').replace('Z', '+00:00');
}

export async function queryBillingExport(bq: BigQueryConfig, periodStart: string, periodEnd: string): Promise<BillingTotals> {
  const token = await getServiceAccountToken(bq.serviceAccount, BQ_SCOPE, bq.tokenUrl);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const stringArray = (values: string[]) => ({
    parameterType: { type: 'ARRAY', arrayType: { type: 'STRING' } },
    parameterValue: { arrayValues: values.map((value) => ({ value })) },
  });
  const params: unknown[] = [
    { name: 'start', parameterType: { type: 'TIMESTAMP' }, parameterValue: { value: bqTimestamp(periodStart) } },
    { name: 'end', parameterType: { type: 'TIMESTAMP' }, parameterValue: { value: bqTimestamp(periodEnd) } },
    { name: 'credit_types', ...stringArray(bq.creditTypes) },
  ];
  if (bq.projectIds.length) params.push({ name: 'projects', ...stringArray(bq.projectIds) });

  const base = `${bq.apiBase}/projects/${encodeURIComponent(bq.jobProject)}/queries`;
  let res = obj(
    await fetchJson(base, {
      method: 'POST',
      headers,
      timeoutMs: 60_000,
      body: JSON.stringify({
        query: buildBillingQuery(bq),
        useLegacySql: false,
        parameterMode: 'NAMED',
        queryParameters: params,
        timeoutMs: 30_000,
        ...(bq.location ? { location: bq.location } : {}),
      }),
    }),
  );

  // Large/slow jobs return jobComplete=false: poll the results a few times.
  for (let i = 0; i < 5 && res && res.jobComplete === false; i++) {
    const job = obj(res.jobReference);
    const jobId = str(job?.jobId);
    if (!jobId) break;
    const qs = new URLSearchParams({ timeoutMs: '20000' });
    const loc = str(job?.location) ?? bq.location;
    if (loc) qs.set('location', loc);
    res = obj(await fetchJson(`${base}/${encodeURIComponent(jobId)}?${qs}`, { headers, timeoutMs: 40_000 }));
  }
  if (!res || res.jobComplete === false) throw new ProviderError('The BigQuery query did not finish in time.', 'http');
  return parseBillingResult(res);
}

export function parseBillingResult(res: unknown): BillingTotals {
  const rows = isObj(res) && Array.isArray(res.rows) ? res.rows : [];
  const first = obj(rows[0]);
  const f = first && Array.isArray(first.f) ? first.f : [];
  const cell = (i: number) => (isObj(f[i]) ? (f[i] as Record<string, unknown>).v : null);
  const gross = num(cell(0)) ?? 0;
  const credit = num(cell(1)) ?? 0;
  return {
    grossCost: Math.round(gross * 100) / 100,
    // Credits are negative amounts in the export.
    creditsUsed: Math.round(Math.abs(Math.min(0, credit)) * 100) / 100,
    lastExport: str(cell(2)),
    currency: str(cell(3)),
  };
}
