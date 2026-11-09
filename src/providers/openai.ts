import type { Extra, MeterRole, ProviderSnapshot, WindowReading } from '../types.ts';
import { HttpError, ProviderError, toProviderError } from '../lib/errors.ts';
import { fetchJson } from '../lib/http.ts';
import { isObj, num, obj, readJsonFile, str, writeJsonFileAtomic, type Obj } from '../lib/json.ts';
import { decodeJwtPayload } from '../lib/jwt.ts';
import { fmtDuration } from '../format.ts';
import { PROVIDER_META, ROLE_ORDER, singleFlight, type Provider, type TokenMode } from './provider.ts';

/** Same endpoint the Codex CLI's /status reads (ChatGPT plan limits for Codex). */
export const CODEX_DEFAULTS = {
  usageUrl: 'https://chatgpt.com/backend-api/wham/usage',
  tokenUrl: 'https://auth.openai.com/oauth/token',
  clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
};

export interface OpenAIConfig {
  enabled: boolean;
  /** ~/.codex/auth.json (or $CODEX_HOME/auth.json for a dedicated login). */
  authFile: string;
  mode: TokenMode;
  usageUrl: string;
  tokenUrl: string;
  clientId: string;
  userAgent: string;
}

interface CodexTokens {
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
  account_id?: string;
}

interface CodexAuthFile {
  tokens?: CodexTokens | null;
  last_refresh?: string;
  [k: string]: unknown;
}

const AUTH_HINT = 'Check the Codex login ("codex login status"); it must be a ChatGPT account login, not an API key.';

export function createOpenAIProvider(cfg: OpenAIConfig): Provider {
  const meta = PROVIDER_META.openai;
  let lastRefreshAt = 0;

  async function readTokens(): Promise<CodexTokens> {
    let file: CodexAuthFile | null;
    try {
      file = await readJsonFile(cfg.authFile);
    } catch (e) {
      throw new ProviderError(`Could not read ${cfg.authFile}: ${(e as Error).message}`, 'not_configured');
    }
    if (!file) throw new ProviderError(`Codex login file not found: ${cfg.authFile}. Run "codex login".`, 'not_configured');
    if (!file.tokens?.access_token) {
      throw new ProviderError(`Codex at ${cfg.authFile} is not logged in with a ChatGPT account (API key only). Run "codex login".`, 'not_configured');
    }
    return file.tokens;
  }

  const refresh = singleFlight(async (): Promise<CodexTokens> => {
    const current = await readTokens();
    if (Date.now() - lastRefreshAt < 30_000 && !isExpired(current)) return current;
    if (!current.refresh_token) throw new ProviderError('The Codex login has no refresh token. Redo the dedicated login.', 'auth');
    let res: unknown;
    try {
      res = await fetchJson(cfg.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': cfg.userAgent },
        body: JSON.stringify({
          client_id: cfg.clientId,
          grant_type: 'refresh_token',
          refresh_token: current.refresh_token,
          scope: 'openid profile email',
        }),
      });
    } catch (e) {
      if (e instanceof HttpError && (e.status === 400 || e.status === 401)) {
        throw new ProviderError('OpenAI rejected the refresh token. Redo the dedicated Codex login (see the README).', 'auth', { cause: e });
      }
      throw toProviderError(e, meta.name, AUTH_HINT);
    }
    const r = obj(res);
    const accessToken = str(r?.access_token);
    if (!r || !accessToken) throw new ProviderError('OpenAI token refresh returned no access_token.', 'parse');
    const next: CodexTokens = {
      ...current,
      access_token: accessToken,
      id_token: str(r.id_token) ?? current.id_token,
      refresh_token: str(r.refresh_token) ?? current.refresh_token,
    };
    const file = (await readJsonFile<CodexAuthFile>(cfg.authFile)) ?? {};
    file.tokens = next;
    file.last_refresh = new Date().toISOString();
    await writeJsonFileAtomic(cfg.authFile, file);
    lastRefreshAt = Date.now();
    return next;
  });

  function getUsage(t: CodexTokens): Promise<unknown> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${t.access_token}`,
      Accept: 'application/json',
      'User-Agent': cfg.userAgent,
    };
    const accountId = t.account_id ?? accountIdFromIdToken(t.id_token);
    if (accountId) headers['ChatGPT-Account-Id'] = accountId;
    return fetchJson(cfg.usageUrl, { headers });
  }

  return {
    id: 'openai',
    name: meta.name,
    short: meta.short,
    enabled: cfg.enabled,
    describe: () =>
      `Codex limits on the ChatGPT plan (${cfg.mode === 'dedicated' ? 'dedicated login, refreshed by the server' : 'shared with the Codex CLI, read-only'}) · ${cfg.authFile}`,
    async fetch(): Promise<ProviderSnapshot> {
      try {
        let tokens = await readTokens();
        if (isExpired(tokens)) {
          if (cfg.mode !== 'dedicated') {
            throw new ProviderError(
              'The Codex token expired. The Codex CLI refreshes it while you use it; to stay up to date 24/7 use a dedicated login (CODEX_TOKEN_MODE=dedicated, see the README).',
              'expired',
            );
          }
          tokens = await refresh();
        }
        let json: unknown;
        try {
          json = await getUsage(tokens);
        } catch (e) {
          if (!(e instanceof HttpError && e.status === 401 && cfg.mode === 'dedicated')) throw e;
          tokens = await refresh();
          json = await getUsage(tokens);
        }
        return parseCodexUsage(json);
      } catch (e) {
        throw toProviderError(e, meta.name, AUTH_HINT);
      }
    },
  };
}

function isExpired(t: CodexTokens): boolean {
  const exp = num(decodeJwtPayload(t.access_token ?? '')?.exp);
  return exp != null && exp * 1000 - 60_000 <= Date.now();
}

function accountIdFromIdToken(idToken: string | undefined): string | null {
  if (!idToken) return null;
  const claims = obj(decodeJwtPayload(idToken)?.['https://api.openai.com/auth']);
  return str(claims?.chatgpt_account_id);
}

interface ParsedWindow {
  usedPct: number | null;
  resetsAt: string | null;
  windowSeconds: number;
}

function parseWindow(w: Obj, now: number): ParsedWindow | null {
  const secs = num(w.limit_window_seconds) ?? (num(w.window_minutes) != null ? num(w.window_minutes)! * 60 : null);
  if (!secs || secs <= 0) return null;
  let resetMs: number | null = null;
  const resetAt = num(w.reset_at) ?? num(w.resets_at);
  const resetAfter = num(w.reset_after_seconds);
  if (resetAt != null) resetMs = resetAt < 1e12 ? resetAt * 1000 : resetAt;
  else if (resetAfter != null) resetMs = now + resetAfter * 1000;
  return {
    usedPct: num(w.used_percent),
    resetsAt: resetMs == null ? null : new Date(resetMs).toISOString(),
    windowSeconds: secs,
  };
}

function windowLabel(secs: number): string {
  if (secs >= 6 * 86400 && secs <= 8 * 86400) return 'Week';
  return `${fmtDuration(secs)} window`;
}

/**
 * Parses GET /backend-api/wham/usage:
 * { plan_type, rate_limit: { primary_window, secondary_window }, credits: { has_credits, unlimited, balance },
 *   additional_rate_limits: [{ limit_name, metered_feature, rate_limit }] }
 * Each window: { used_percent, limit_window_seconds, reset_after_seconds, reset_at (unix seconds) }.
 */
export function parseCodexUsage(json: unknown, now = Date.now()): ProviderSnapshot {
  if (!isObj(json)) throw new ProviderError('Unexpected OpenAI usage response.', 'parse');
  const rl = obj(json.rate_limit);
  if (!rl) throw new ProviderError('The OpenAI response has no rate limits. Does the account have a ChatGPT plan with Codex?', 'parse');

  const readings: WindowReading[] = [];
  const roleTaken = new Set<MeterRole>();
  const windows = [rl.primary_window, rl.secondary_window]
    .map((w) => (isObj(w) ? parseWindow(w, now) : null))
    .filter((w): w is ParsedWindow => w !== null)
    .sort((a, b) => a.windowSeconds - b.windowSeconds);

  for (const w of windows) {
    let role: MeterRole = w.windowSeconds <= 6 * 3600 ? 'session' : w.windowSeconds >= 6 * 86400 ? 'week' : 'other';
    if (roleTaken.has(role)) role = 'other';
    roleTaken.add(role);
    const label = role === 'session' ? `Session (${fmtDuration(w.windowSeconds)})` : windowLabel(w.windowSeconds);
    const id = role === 'other' ? `window-${Math.round(w.windowSeconds / 60)}m` : role;
    readings.push({ kind: 'window', id, label, role, ...w });
  }

  if (Array.isArray(json.additional_rate_limits)) {
    for (const extra of json.additional_rate_limits) {
      if (!isObj(extra)) continue;
      const name = str(extra.limit_name) ?? str(extra.metered_feature) ?? 'Extra';
      const xrl = obj(extra.rate_limit);
      for (const key of ['primary_window', 'secondary_window']) {
        const raw = obj(xrl?.[key]);
        const w = raw ? parseWindow(raw, now) : null;
        if (!w || w.usedPct == null) continue;
        readings.push({
          kind: 'window',
          id: `${name}-${key}`.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
          label: `${name} · ${windowLabel(w.windowSeconds)}`,
          role: 'other',
          ...w,
        });
      }
    }
  }

  if (!roleTaken.has('session')) {
    // Codex omits the short window when it isn't running: show an idle session instead of nothing.
    readings.push({ kind: 'window', id: 'session', label: 'Session (5h)', role: 'session', usedPct: 0, resetsAt: null, windowSeconds: 5 * 3600 });
  }
  readings.sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role]);

  const extras: Extra[] = [];
  const credits = obj(json.credits);
  if (credits) {
    let value = 'none';
    if (credits.unlimited === true) value = 'unlimited';
    else if (credits.has_credits === true) value = str(credits.balance) ?? String(num(credits.balance) ?? 'available');
    extras.push({ id: 'credits', label: 'Credits', value, tone: 'neutral' });
  }
  if (rl.limit_reached === true || rl.allowed === false) {
    extras.push({ id: 'limit', label: 'Status', value: 'limit reached', tone: 'bad' });
  }

  const plan = str(json.plan_type);
  return {
    provider: 'openai',
    fetchedAt: new Date(now).toISOString(),
    source: 'codex-oauth',
    plan: plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : null,
    readings,
    extras,
  };
}
