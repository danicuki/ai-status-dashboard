import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { CLAUDE_DEFAULTS, type ClaudeConfig } from './providers/claude.ts';
import { CODEX_DEFAULTS, type OpenAIConfig } from './providers/openai.ts';
import type { BigQueryConfig, GeminiConfig } from './providers/gemini.ts';
import type { PubSubConfig } from './providers/gcp-budgets.ts';
import { parseServiceAccount, type ServiceAccount } from './lib/google.ts';
import type { TokenMode } from './providers/provider.ts';
import pkg from '../package.json' with { type: 'json' };

export interface AppConfig {
  version: string;
  port: number;
  host: string;
  dataDir: string;
  refreshMinutes: number;
  tolerancePct: number;
  /** Token required by the API. null = generate one on first start and keep it in DATA_DIR. */
  apiToken: string | null;
  /** Public base URL used in links (SwiftBar "open dashboard"). null = derive from the request. */
  publicUrl: string | null;
  /** Locale for numbers, money and dates in server-generated text. */
  locale: string;
  claude: ClaudeConfig;
  openai: OpenAIConfig;
  gemini: GeminiConfig;
}

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env = process.env): AppConfig {
  const get = (k: string): string | undefined => {
    const v = env[k];
    return v === undefined || v.trim() === '' ? undefined : v.trim();
  };
  const numOr = (k: string, def: number): number => {
    const v = get(k);
    if (v === undefined) return def;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`${k} must be a number (got "${v}")`);
    return n;
  };
  const tri = (k: string): 'auto' | boolean => {
    const v = (get(k) ?? 'auto').toLowerCase();
    if (v === 'auto') return 'auto';
    return ['1', 'true', 'yes', 'sim', 'on'].includes(v);
  };
  const mode = (k: string): TokenMode => {
    const v = (get(k) ?? 'shared').toLowerCase();
    if (v !== 'shared' && v !== 'dedicated') throw new Error(`${k} must be "shared" or "dedicated"`);
    return v;
  };
  const userAgent = `ai-pace/${pkg.version}`;

  const claudeFile = expandHome(get('CLAUDE_CREDENTIALS_FILE') ?? path.join(get('CLAUDE_CONFIG_DIR') ?? '~/.claude', '.credentials.json'));
  const claudeEnabled = tri('CLAUDE_ENABLED');
  const codexFile = expandHome(get('CODEX_AUTH_FILE') ?? path.join(get('CODEX_HOME') ?? '~/.codex', 'auth.json'));
  const openaiEnabled = tri('OPENAI_ENABLED');

  return {
    version: pkg.version,
    port: numOr('PORT', 8787),
    host: get('HOST') ?? '0.0.0.0',
    dataDir: path.resolve(expandHome(get('DATA_DIR') ?? './data')),
    refreshMinutes: Math.max(1, numOr('REFRESH_MINUTES', 15)),
    tolerancePct: Math.max(0, numOr('PACE_TOLERANCE', 5)),
    apiToken: get('API_TOKEN') ?? null,
    publicUrl: get('PUBLIC_URL')?.replace(/\/+$/, '') ?? null,
    locale: get('LOCALE') ?? 'en-US',
    claude: {
      enabled: claudeEnabled === 'auto' ? existsSync(claudeFile) : claudeEnabled,
      credentialsFile: claudeFile,
      mode: mode('CLAUDE_TOKEN_MODE'),
      usageUrl: get('CLAUDE_USAGE_URL') ?? CLAUDE_DEFAULTS.usageUrl,
      tokenUrl: get('CLAUDE_TOKEN_URL') ?? CLAUDE_DEFAULTS.tokenUrl,
      clientId: get('CLAUDE_CLIENT_ID') ?? CLAUDE_DEFAULTS.clientId,
      userAgent: get('CLAUDE_USER_AGENT') ?? userAgent,
    },
    openai: {
      enabled: openaiEnabled === 'auto' ? existsSync(codexFile) : openaiEnabled,
      authFile: codexFile,
      mode: mode('CODEX_TOKEN_MODE'),
      usageUrl: get('CODEX_USAGE_URL') ?? CODEX_DEFAULTS.usageUrl,
      tokenUrl: get('CODEX_TOKEN_URL') ?? CODEX_DEFAULTS.tokenUrl,
      clientId: get('CODEX_CLIENT_ID') ?? CODEX_DEFAULTS.clientId,
      userAgent: get('CODEX_USER_AGENT') ?? userAgent,
    },
    gemini: loadGemini(get, numOr, tri),
  };
}

function loadGemini(
  get: (k: string) => string | undefined,
  numOr: (k: string, def: number) => number,
  tri: (k: string) => 'auto' | boolean,
): GeminiConfig {
  const enabledFlag = tri('GEMINI_ENABLED');
  const totalRaw = get('GEMINI_CREDIT_TOTAL');
  const enabled = enabledFlag === 'auto' ? totalRaw !== undefined : enabledFlag;
  const errors: string[] = [];

  const total = numOr('GEMINI_CREDIT_TOTAL', 0);
  if (enabled && !(total > 0)) errors.push('set GEMINI_CREDIT_TOTAL (e.g. 1000)');

  let periodStart = '';
  let periodEnd = '';
  const start = parseDate(get('GEMINI_CREDIT_START'));
  if (enabled && !start) errors.push('set GEMINI_CREDIT_START (the date the credits started, e.g. 2026-10-01)');
  if (start) {
    periodStart = start.toISOString();
    const end = parseDate(get('GEMINI_CREDIT_END'));
    if (end) periodEnd = end.toISOString();
    else {
      const e = new Date(start);
      e.setMonth(e.getMonth() + numOr('GEMINI_CREDIT_MONTHS', 3));
      periodEnd = e.toISOString();
    }
  }

  // Service account key, shared by the BigQuery and Pub/Sub sources.
  let saCache: ServiceAccount | null | undefined;
  const serviceAccount = (needs: string): ServiceAccount | null => {
    if (saCache !== undefined) return saCache;
    saCache = null;
    try {
      const file = get('GCP_SERVICE_ACCOUNT_FILE');
      const inline = get('GCP_SERVICE_ACCOUNT_JSON');
      if (file) saCache = parseServiceAccount(readFileSync(expandHome(file), 'utf8'));
      else if (inline) saCache = parseServiceAccount(inline);
      else errors.push(`${needs} requires GCP_SERVICE_ACCOUNT_FILE or GCP_SERVICE_ACCOUNT_JSON`);
    } catch (e) {
      errors.push(`invalid service account key: ${(e as Error).message}`);
    }
    return saCache;
  };

  let pubsub: PubSubConfig | null = null;
  const subscription = get('GCP_PUBSUB_SUBSCRIPTION');
  if (subscription) {
    const sa = serviceAccount('GCP_PUBSUB_SUBSCRIPTION');
    if (sa) {
      const since = get('GCP_BUDGET_SINCE') ?? null;
      if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) errors.push('GCP_BUDGET_SINCE must be a date (YYYY-MM-DD)');
      pubsub = {
        subscription,
        serviceAccount: sa,
        apiBase: (get('PUBSUB_API_BASE') ?? 'https://pubsub.googleapis.com/v1').replace(/\/+$/, ''),
        tokenUrl: get('GCP_TOKEN_URL') ?? null,
        grossBudget: get('GCP_BUDGET_GROSS') ?? 'AI Pace (gross)',
        netBudget: get('GCP_BUDGET_NET') ?? 'AI Pace (net)',
        since,
      };
    }
  }

  let bigquery: BigQueryConfig | null = null;
  const table = get('GCP_BILLING_TABLE');
  if (table && !pubsub) {
    const sa = serviceAccount('GCP_BILLING_TABLE');
    if (sa) {
      const jobProject = get('GCP_JOB_PROJECT') ?? sa.project_id ?? table.split('.')[0];
      const measure = (get('GCP_CREDIT_MEASURE') ?? 'credits').toLowerCase();
      bigquery = {
        table,
        serviceAccount: sa,
        jobProject,
        projectIds: list(get('GCP_BILLING_PROJECTS')),
        measure: measure === 'cost' ? 'cost' : 'credits',
        creditTypes: list(get('GCP_CREDIT_TYPES') ?? 'PROMOTION').map((s) => s.toUpperCase()),
        location: get('GCP_BIGQUERY_LOCATION') ?? null,
        apiBase: (get('BIGQUERY_API_BASE') ?? 'https://bigquery.googleapis.com/bigquery/v2').replace(/\/+$/, ''),
        tokenUrl: get('GCP_TOKEN_URL') ?? null,
      };
    }
  }

  const usedRaw = get('GEMINI_CREDIT_USED');
  return {
    enabled,
    creditName: get('GEMINI_CREDIT_NAME') ?? null,
    renewDays: Math.max(0, numOr('GEMINI_RENEW_DAYS', 15)),
    total,
    currency: (get('GEMINI_CREDIT_CURRENCY') ?? 'USD').toUpperCase(),
    periodStart,
    periodEnd,
    offset: numOr('GEMINI_CREDIT_USED_OFFSET', 0),
    initialUsed: usedRaw === undefined ? null : numOr('GEMINI_CREDIT_USED', 0),
    bigquery,
    pubsub,
    configError: errors.length ? `Incomplete Gemini configuration: ${errors.join('; ')}.` : null,
  };
}

/** "2026-10-01" → local midnight; full ISO strings are kept as-is. */
function parseDate(v: string | undefined): Date | null {
  if (!v) return null;
  const d = /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00`) : new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
}

function list(v: string | undefined): string[] {
  return (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return path.join(homedir(), p.slice(2));
  return p;
}
