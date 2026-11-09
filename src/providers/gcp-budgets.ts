import { ProviderError } from '../lib/errors.ts';
import { getServiceAccountToken, type ServiceAccount } from '../lib/google.ts';
import { fetchJson } from '../lib/http.ts';
import { isObj, num, obj, str } from '../lib/json.ts';

/**
 * Google Cloud has no public API for "how much have I spent" or "credits remaining". The only official,
 * near-real-time signal is a budget's Pub/Sub notifications: Cloud Billing publishes the budget's current
 * spend several times a day. scripts/setup-gcp-budget.sh creates two budgets over the whole billing account:
 *   gross: credits excluded  → total cost
 *   net:   PROMOTION credits subtracted
 * so gross − net = promotional credits consumed since the budgets' start date.
 */
export interface PubSubConfig {
  /** projects/<project>/subscriptions/<subscription> */
  subscription: string;
  serviceAccount: ServiceAccount;
  apiBase: string;
  tokenUrl: string | null;
  grossBudget: string;
  netBudget: string;
  /** Budgets' start date (YYYY-MM-DD): notices for an older period (a previous credit) are ignored. */
  since: string | null;
}

/** Latest known state of one budget. */
export interface BudgetNotice {
  name: string;
  cost: number;
  currency: string | null;
  intervalStart: string | null;
  publishedAt: string;
}

const PUBSUB_SCOPE = 'https://www.googleapis.com/auth/pubsub';
const MAX_ROUNDS = 5;
const BATCH = 100;

export function isValidSubscription(name: string): boolean {
  return /^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/subscriptions\/[A-Za-z][A-Za-z0-9._~%+-]{2,254}$/.test(name);
}

/** Decodes one Pub/Sub message from Cloud Billing ({ data: base64 JSON, publishTime }). */
export function parseBudgetMessage(message: unknown): BudgetNotice | null {
  const m = obj(message);
  const b64 = str(m?.data);
  if (!m || !b64) return null;
  let data: unknown;
  try {
    data = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  } catch {
    return null;
  }
  if (!isObj(data)) return null;
  const name = str(data.budgetDisplayName);
  const cost = num(data.costAmount);
  if (!name || cost == null || cost < 0) return null;
  return {
    name,
    cost,
    currency: str(data.currencyCode),
    intervalStart: str(data.costIntervalStart),
    publishedAt: str(m.publishTime) ?? new Date().toISOString(),
  };
}

/** True when the notice belongs to the current budget period (not to a previous credit). */
export function isCurrent(n: BudgetNotice, since: string | null): boolean {
  if (!since || !n.intervalStart) return true;
  return n.intervalStart.slice(0, 10) >= since;
}

/** Pulls every pending notification, acknowledges it, and returns the newest notice per budget name. */
export async function pullBudgetNotices(cfg: PubSubConfig): Promise<Map<string, BudgetNotice>> {
  if (!isValidSubscription(cfg.subscription)) {
    throw new ProviderError(`Invalid GCP_PUBSUB_SUBSCRIPTION "${cfg.subscription}". Use projects/<project>/subscriptions/<name>.`, 'not_configured');
  }
  const token = await getServiceAccountToken(cfg.serviceAccount, PUBSUB_SCOPE, cfg.tokenUrl);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const latest = new Map<string, BudgetNotice>();

  for (let round = 0; round < MAX_ROUNDS; round++) {
    let res: unknown;
    try {
      res = await fetchJson(`${cfg.apiBase}/${cfg.subscription}:pull`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ maxMessages: BATCH }),
        timeoutMs: 25_000,
      });
    } catch (e) {
      // A pull with nothing to deliver may wait until the deadline: that just means "no new messages".
      if (e instanceof ProviderError && e.code === 'network' && /abort|timeout/i.test(e.message)) break;
      throw e;
    }
    const received = isObj(res) && Array.isArray(res.receivedMessages) ? res.receivedMessages : [];
    if (!received.length) break;

    const ackIds: string[] = [];
    for (const r of received) {
      const item = obj(r);
      const ackId = str(item?.ackId);
      if (ackId) ackIds.push(ackId);
      const n = parseBudgetMessage(item?.message);
      if (!n || !isCurrent(n, cfg.since)) continue;
      const prev = latest.get(n.name);
      if (!prev || prev.publishedAt <= n.publishedAt) latest.set(n.name, n);
    }
    if (ackIds.length) {
      await fetchJson(`${cfg.apiBase}/${cfg.subscription}:acknowledge`, { method: 'POST', headers, body: JSON.stringify({ ackIds }) });
    }
    if (received.length < BATCH) break;
  }
  return latest;
}
