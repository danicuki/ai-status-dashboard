import type { Extra, MeterRole, ProviderSnapshot, WindowReading } from '../types.ts';
import { HttpError, ProviderError, toProviderError } from '../lib/errors.ts';
import { fetchJson } from '../lib/http.ts';
import { isObj, num, obj, readJsonFile, str, writeJsonFileAtomic } from '../lib/json.ts';
import { currencyDigits, fmtMoney } from '../format.ts';
import { PROVIDER_META, ROLE_ORDER, singleFlight, type Provider, type TokenMode } from './provider.ts';

/** Same endpoint Claude Code's /usage screen reads (plan limits for Pro/Max subscriptions). */
export const CLAUDE_DEFAULTS = {
  usageUrl: 'https://api.anthropic.com/api/oauth/usage',
  tokenUrl: 'https://platform.claude.com/v1/oauth/token',
  clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  betaHeader: 'oauth-2025-04-20',
};

export interface ClaudeConfig {
  enabled: boolean;
  credentialsFile: string;
  /**
   * shared: the file belongs to your everyday Claude Code login. We only read it and never refresh
   *   the token (refresh tokens rotate; refreshing here would log Claude Code out).
   * dedicated: a separate login made just for this server. We refresh it and write it back.
   */
  mode: TokenMode;
  usageUrl: string;
  tokenUrl: string;
  clientId: string;
  userAgent: string;
}

interface ClaudeOAuth {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  scopes?: string[];
  subscriptionType?: string | null;
  [k: string]: unknown;
}

const FIVE_HOURS = 5 * 3600;
const SEVEN_DAYS = 7 * 86400;
const AUTH_HINT =
  'Check the login ("claude auth status"). Tokens created with "claude setup-token" do not work: they lack the user:profile scope.';

export function createClaudeProvider(cfg: ClaudeConfig): Provider {
  const meta = PROVIDER_META.claude;

  async function readCreds(): Promise<ClaudeOAuth> {
    let file: { claudeAiOauth?: ClaudeOAuth } | null;
    try {
      file = await readJsonFile(cfg.credentialsFile);
    } catch (e) {
      throw new ProviderError(`Could not read ${cfg.credentialsFile}: ${(e as Error).message}`, 'not_configured');
    }
    if (!file) throw new ProviderError(`Credentials file not found: ${cfg.credentialsFile}. Log in with "claude auth login".`, 'not_configured');
    const c = file.claudeAiOauth;
    if (!c?.accessToken) throw new ProviderError(`No Claude subscription login in ${cfg.credentialsFile}. Run "claude auth login".`, 'not_configured');
    return c;
  }

  let lastRefreshAt = 0;
  const isExpired = (c: ClaudeOAuth) => typeof c.expiresAt === 'number' && c.expiresAt - 60_000 <= Date.now();

  const refresh = singleFlight(async (): Promise<ClaudeOAuth> => {
    // Re-read inside the lock; if we just refreshed (e.g. a 401 race), reuse that token.
    const current = await readCreds();
    if (Date.now() - lastRefreshAt < 30_000 && !isExpired(current)) return current;
    if (!current.refreshToken) throw new ProviderError('The Claude login has no refresh token. Redo the dedicated login.', 'auth');
    const body: Record<string, string> = {
      grant_type: 'refresh_token',
      refresh_token: current.refreshToken,
      client_id: cfg.clientId,
    };
    if (Array.isArray(current.scopes) && current.scopes.length) body.scope = current.scopes.join(' ');
    let res: unknown;
    try {
      res = await fetchJson(cfg.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': cfg.userAgent },
        body: JSON.stringify(body),
      });
    } catch (e) {
      if (e instanceof HttpError && (e.status === 400 || e.status === 401)) {
        throw new ProviderError('Claude rejected the refresh token. Redo the dedicated login (see the README).', 'auth', { cause: e });
      }
      throw toProviderError(e, meta.name, AUTH_HINT);
    }
    const r = obj(res);
    const accessToken = str(r?.access_token);
    if (!r || !accessToken) throw new ProviderError('Claude token refresh returned no access_token.', 'parse');
    const next: ClaudeOAuth = {
      ...current,
      accessToken,
      refreshToken: str(r.refresh_token) ?? current.refreshToken,
      expiresAt: Date.now() + (num(r.expires_in) ?? 3600) * 1000,
    };
    if (typeof r.scope === 'string' && r.scope.trim()) next.scopes = r.scope.trim().split(/\s+/);
    const file = (await readJsonFile<Record<string, unknown>>(cfg.credentialsFile)) ?? {};
    file.claudeAiOauth = next;
    await writeJsonFileAtomic(cfg.credentialsFile, file);
    lastRefreshAt = Date.now();
    return next;
  });

  function getUsage(token: string): Promise<unknown> {
    return fetchJson(cfg.usageUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': CLAUDE_DEFAULTS.betaHeader,
        Accept: 'application/json',
        'User-Agent': cfg.userAgent,
      },
    });
  }

  return {
    id: 'claude',
    name: meta.name,
    short: meta.short,
    enabled: cfg.enabled,
    describe: () =>
      `Claude subscription via OAuth (${cfg.mode === 'dedicated' ? 'dedicated login, refreshed by the server' : 'shared with Claude Code, read-only'}) · ${cfg.credentialsFile}`,
    async fetch(): Promise<ProviderSnapshot> {
      try {
        let creds = await readCreds();
        if (isExpired(creds)) {
          if (cfg.mode !== 'dedicated') {
            throw new ProviderError(
              'The Claude token expired. Claude Code refreshes it while you use it; to stay up to date 24/7 use a dedicated login (CLAUDE_TOKEN_MODE=dedicated, see the README).',
              'expired',
            );
          }
          creds = await refresh();
        }
        let json: unknown;
        try {
          json = await getUsage(creds.accessToken!);
        } catch (e) {
          if (!(e instanceof HttpError && e.status === 401 && cfg.mode === 'dedicated')) throw e;
          creds = await refresh();
          json = await getUsage(creds.accessToken!);
        }
        return parseClaudeUsage(json, { plan: creds.subscriptionType ?? null });
      } catch (e) {
        throw toProviderError(e, meta.name, AUTH_HINT);
      }
    },
  };
}

/**
 * Parses GET /api/oauth/usage. Two shapes exist and both are handled:
 *  - legacy keys: five_hour / seven_day / seven_day_opus / seven_day_sonnet → { utilization, resets_at }
 *  - newer `limits[]`: { kind: 'session' | 'weekly_all' | 'weekly_scoped', group, percent, resets_at, scope }
 */
export function parseClaudeUsage(json: unknown, ctx: { plan?: string | null; now?: number } = {}): ProviderSnapshot {
  if (!isObj(json)) throw new ProviderError('Unexpected Claude usage response.', 'parse');
  const readings: WindowReading[] = [];
  const has = (id: string) => readings.some((r) => r.id === id);
  const add = (id: string, label: string, role: MeterRole, usedPct: number | null, resetsAt: string | null, windowSeconds: number) => {
    if (!has(id)) readings.push({ kind: 'window', id, label, role, usedPct, resetsAt, windowSeconds });
  };

  if (Array.isArray(json.limits)) {
    for (const raw of json.limits) {
      if (!isObj(raw)) continue;
      const kind = str(raw.kind) ?? '';
      const group = str(raw.group) ?? '';
      const pct = num(raw.percent ?? raw.utilization);
      const resetsAt = str(raw.resets_at);
      const scope = obj(raw.scope);
      const scopeName = str(obj(scope?.model)?.display_name) ?? str(obj(scope?.surface)?.display_name);
      const isSession = kind === 'session' || group === 'session';
      if (kind === 'session') add('session', 'Session (5h)', 'session', pct, resetsAt, FIVE_HOURS);
      else if (kind === 'weekly_all') add('week', 'Week', 'week', pct, resetsAt, SEVEN_DAYS);
      else if (scopeName) add(`${isSession ? 'session' : 'week'}-${slug(scopeName)}`, `${isSession ? 'Session' : 'Week'} · ${scopeName}`, 'other', pct, resetsAt, isSession ? FIVE_HOURS : SEVEN_DAYS);
      else if (kind || group) add(slug(kind || group), humanize(kind || group), 'other', pct, resetsAt, isSession ? FIVE_HOURS : SEVEN_DAYS);
    }
  }

  const legacy: Array<[string, string, string, MeterRole, number]> = [
    ['five_hour', 'session', 'Session (5h)', 'session', FIVE_HOURS],
    ['seven_day', 'week', 'Week', 'week', SEVEN_DAYS],
    ['seven_day_opus', 'week-opus', 'Week · Opus', 'other', SEVEN_DAYS],
    ['seven_day_sonnet', 'week-sonnet', 'Week · Sonnet', 'other', SEVEN_DAYS],
  ];
  for (const [key, id, label, role, secs] of legacy) {
    const w = obj(json[key]);
    if (!w) continue;
    const pct = num(w.utilization);
    const resetsAt = str(w.resets_at);
    // Per-model rows are only interesting once they have usage or an active window.
    if (role === 'other' && (pct == null || (pct === 0 && !resetsAt))) continue;
    add(id, label, role, pct, resetsAt, secs);
  }

  if (!has('session') && !has('week')) {
    throw new ProviderError('The Claude usage response has neither session nor weekly limits.', 'parse');
  }
  // No active 5h session is reported as a missing/null window: show it as idle rather than hiding it.
  add('session', 'Session (5h)', 'session', 0, null, FIVE_HOURS);
  readings.sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role]);

  return {
    provider: 'claude',
    fetchedAt: new Date(ctx.now ?? Date.now()).toISOString(),
    source: 'claude-oauth',
    plan: ctx.plan ? capitalize(ctx.plan) : null,
    readings,
    extras: claudeExtras(json),
  };
}

function claudeExtras(json: Record<string, unknown>): Extra[] {
  const xu = obj(json.extra_usage);
  if (!xu) return [];
  // Amounts come in minor units of `currency` (cents for USD).
  const currency = str(xu.currency) ?? 'USD';
  const div = 10 ** currencyDigits(currency);
  const limit = num(xu.monthly_limit);
  const used = num(xu.used_credits);
  const money = (v: number) => fmtMoney(v / div, currency);
  if (limit != null && limit > 0) {
    const exhausted = (used ?? 0) >= limit;
    return [
      {
        id: 'extra_usage',
        label: 'Extra usage (month)',
        value: `${money(used ?? 0)} of ${money(limit)}${exhausted ? ' · used up' : ''}`,
        tone: exhausted ? 'bad' : xu.is_enabled === true ? 'neutral' : 'warn',
      },
    ];
  }
  if (xu.is_enabled === true) {
    return [{ id: 'extra_usage', label: 'Extra usage', value: used != null ? `${money(used)} used` : 'on', tone: 'neutral' }];
  }
  return [{ id: 'extra_usage', label: 'Extra usage', value: 'off', tone: 'neutral' }];
}

function slug(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function humanize(s: string): string {
  return capitalize(s.replace(/[_-]+/g, ' '));
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
