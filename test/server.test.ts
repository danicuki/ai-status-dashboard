/**
 * End-to-end: the real server against fake provider endpoints (no network, no real credentials).
 * Covers token refresh + write-back (dedicated), never refreshing a shared login, the BigQuery
 * service-account flow, API auth, every output format, push ingestion and manual credits.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { loadConfig } from '../src/config.ts';
import { createApp, type App } from '../src/app.ts';
import { createHttpHandler } from '../src/http.ts';
import { setQuiet } from '../src/lib/log.ts';
import type { StatusResponse } from '../src/types.ts';

setQuiet(true);
const H = 3600_000;
const now = Date.now();
const dir = mkdtempSync(path.join(tmpdir(), 'ai-pace-test-'));
const calls: string[] = [];
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

function fakeJwt(payload: object): string {
  const b = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b({ alg: 'none' })}.${b(payload)}.sig`;
}

async function body(req: IncomingMessage): Promise<string> {
  let s = '';
  for await (const c of req) s += c;
  return s;
}

let upstream: Server;
let upstreamUrl = '';
let pubsubQueue: unknown[] = [];
const acked: string[] = [];

before(async () => {
  upstream = createServer(async (req, res) => {
    const b = await body(req);
    const auth = req.headers.authorization ?? '';
    calls.push(`${req.method} ${req.url} ${auth}`);
    const json = (status: number, data: unknown) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));

    if (req.url === '/claude/token') {
      const p = JSON.parse(b);
      assert.equal(p.grant_type, 'refresh_token');
      assert.equal(p.refresh_token, 'claude-refresh-1');
      assert.equal(p.scope, 'user:inference user:profile');
      return json(200, { access_token: 'claude-access-2', refresh_token: 'claude-refresh-2', expires_in: 28800 });
    }
    if (req.url === '/claude/usage') {
      assert.equal(req.headers['anthropic-beta'], 'oauth-2025-04-20');
      if (auth !== 'Bearer claude-access-2') return json(401, { error: 'expired' });
      return json(200, {
        five_hour: { utilization: 70, resets_at: new Date(now + 2 * H).toISOString() },
        seven_day: { utilization: 20, resets_at: new Date(now + 4 * 24 * H).toISOString() },
        extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
      });
    }
    if (req.url === '/codex/usage') {
      assert.equal(req.headers['chatgpt-account-id'], 'acct-123');
      return json(200, {
        plan_type: 'plus',
        rate_limit: {
          primary_window: { used_percent: 10, limit_window_seconds: 18000, reset_after_seconds: 3 * 3600 },
          secondary_window: { used_percent: 80, limit_window_seconds: 604800, reset_after_seconds: 4 * 86400 },
        },
        credits: { has_credits: false, unlimited: false, balance: null },
      });
    }
    if (req.url === '/google/token') {
      const assertion = new URLSearchParams(b).get('assertion')!;
      const [h, p, s] = assertion.split('.');
      const ok = createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(s, 'base64url'));
      assert.ok(ok, 'service account JWT must be RS256-signed with the key');
      assert.equal(JSON.parse(Buffer.from(p, 'base64url').toString()).iss, 'sa@proj.iam.gserviceaccount.com');
      return json(200, { access_token: 'gcp-token', expires_in: 3600 });
    }
    if (req.url === '/bq/projects/job-proj/queries') {
      assert.equal(auth, 'Bearer gcp-token');
      const q = JSON.parse(b);
      assert.equal(q.parameterMode, 'NAMED');
      assert.match(q.query, /FROM `proj\.billing\.gcp_billing_export_v1_X`/);
      return json(200, { jobComplete: true, rows: [{ f: [{ v: '330.5' }, { v: '-320.25' }, { v: '2026-11-09T10:00:00Z' }, { v: 'USD' }] }] });
    }
    if (req.url === '/pubsub/projects/host-proj/subscriptions/ai-pace-budget:pull') {
      assert.equal(auth, 'Bearer gcp-token');
      const items = pubsubQueue;
      pubsubQueue = [];
      return json(200, items.length ? { receivedMessages: items } : {});
    }
    if (req.url === '/pubsub/projects/host-proj/subscriptions/ai-pace-budget:acknowledge') {
      acked.push(...JSON.parse(b).ackIds);
      return json(200, {});
    }
    json(404, { error: 'nope' });
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});

after(() => upstream.close());

async function startApp(env: Record<string, string>): Promise<{ app: App; url: string; close: () => void }> {
  const app = await createApp(loadConfig(env));
  const server = createServer(createHttpHandler(app));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { app, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}

test('full pipeline: dedicated Claude refresh, shared Codex, BigQuery credits', async () => {
  const claudeFile = path.join(dir, 'claude-dedicated.json');
  writeFileSync(
    claudeFile,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'claude-access-1',
        refreshToken: 'claude-refresh-1',
        expiresAt: now - 1000,
        scopes: ['user:inference', 'user:profile'],
        subscriptionType: 'max',
      },
      somethingElse: { keep: true },
    }),
  );
  const codexFile = path.join(dir, 'codex-auth.json');
  writeFileSync(codexFile, JSON.stringify({ tokens: { access_token: fakeJwt({ exp: now / 1000 + 3600 }), refresh_token: 'r', account_id: 'acct-123' } }));
  const saFile = path.join(dir, 'sa.json');
  writeFileSync(
    saFile,
    JSON.stringify({
      client_email: 'sa@proj.iam.gserviceaccount.com',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
      token_uri: `${upstreamUrl}/google/token`,
      project_id: 'job-proj',
    }),
  );

  const { app, url, close } = await startApp({
    DATA_DIR: path.join(dir, 'data1'),
    API_TOKEN: 'secret-token',
    CLAUDE_CREDENTIALS_FILE: claudeFile,
    CLAUDE_TOKEN_MODE: 'dedicated',
    CLAUDE_USAGE_URL: `${upstreamUrl}/claude/usage`,
    CLAUDE_TOKEN_URL: `${upstreamUrl}/claude/token`,
    CODEX_AUTH_FILE: codexFile,
    CODEX_USAGE_URL: `${upstreamUrl}/codex/usage`,
    GEMINI_CREDIT_TOTAL: '1000',
    GEMINI_CREDIT_START: new Date(now - 30 * 24 * H).toISOString(),
    GEMINI_CREDIT_MONTHS: '3',
    GCP_BILLING_TABLE: 'proj.billing.gcp_billing_export_v1_X',
    GCP_SERVICE_ACCOUNT_FILE: saFile,
    BIGQUERY_API_BASE: `${upstreamUrl}/bq`,
  });
  try {
    await app.collector.refreshAll();

    // Rotated Claude tokens were written back, other keys preserved.
    const saved = JSON.parse(readFileSync(claudeFile, 'utf8'));
    assert.equal(saved.claudeAiOauth.accessToken, 'claude-access-2');
    assert.equal(saved.claudeAiOauth.refreshToken, 'claude-refresh-2');
    assert.equal(saved.claudeAiOauth.subscriptionType, 'max');
    assert.deepEqual(saved.somethingElse, { keep: true });

    assert.equal((await fetch(`${url}/api/v1/status`)).status, 401);
    assert.equal((await fetch(`${url}/api/v1/status`, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
    assert.equal((await fetch(`${url}/api/v1/status?token=secret-token`)).status, 401, 'tokens in URLs are refused');

    const res = await fetch(`${url}/api/v1/status`, { headers: { Authorization: 'Bearer secret-token' } });
    assert.equal(res.status, 200);
    const s = (await res.json()) as StatusResponse;
    assert.deepEqual(
      s.providers.map((p) => [p.id, p.status, p.error]),
      [
        ['claude', 'under', null],
        ['openai', 'over', null],
        ['gemini', 'on_pace', null],
      ],
    );
    const claude = s.providers[0];
    assert.equal(claude.plan, 'Max');
    assert.equal(claude.session?.status, 'over'); // 70% used 3h into a 5h window
    assert.equal(claude.primary?.id, 'week');
    const gemini = s.providers[2];
    assert.equal(gemini.primary?.used, 320.25);
    assert.equal(gemini.primary?.dataAsOf, '2026-11-09T10:00:00Z');

    const H = { headers: { Authorization: 'Bearer secret-token' } };
    const swift = await (await fetch(`${url}/api/v1/swiftbar`, H)).text();
    assert.match(swift.split('\n')[0], /C▼.*O▲.*G●.* \| ansi=true$/);
    assert.match(swift, /href=http:\/\/127\.0\.0\.1:\d+\/$/m);
    assert.ok(!swift.includes('secret-token'), 'the token never appears in the menu bar output');

    const waybar = (await (await fetch(`${url}/api/v1/waybar`, H)).json()) as { text: string; class: string };
    assert.equal(waybar.class, 'over');
    assert.match(waybar.text, /<span color='#ec835a'>O▲<\/span>/);

    const compact = (await (await fetch(`${url}/api/v1/compact`, H)).json()) as { providers: { id: string; main: { used: number } }[] };
    assert.equal(compact.providers.find((p) => p.id === 'openai')?.main.used, 80);

    // Static files, and no path traversal out of public/.
    assert.equal((await fetch(`${url}/`)).headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal((await fetch(`${url}/..%2fpackage.json`)).status, 404);
    assert.equal((await fetch(`${url}/healthz`)).status, 200);
  } finally {
    close();
  }
});

test('shared login: an expired token is reported, never refreshed', async () => {
  const claudeFile = path.join(dir, 'claude-shared.json');
  const original = JSON.stringify({ claudeAiOauth: { accessToken: 'x', refreshToken: 'do-not-touch', expiresAt: now - 1000 } });
  writeFileSync(claudeFile, original);
  const before = calls.length;
  const { app, close } = await startApp({
    DATA_DIR: path.join(dir, 'data2'),
    CLAUDE_CREDENTIALS_FILE: claudeFile,
    CLAUDE_TOKEN_URL: `${upstreamUrl}/claude/token`,
    CLAUDE_USAGE_URL: `${upstreamUrl}/claude/usage`,
    OPENAI_ENABLED: 'false',
  });
  try {
    await app.collector.refreshAll();
    assert.equal(calls.length, before, 'no request may be made with an expired shared token');
    assert.equal(readFileSync(claudeFile, 'utf8'), original);
    const p = app.status().providers[0];
    assert.equal(p.error?.code, 'expired');
    assert.equal(p.status, 'unknown');
    // A token was generated and persisted because API_TOKEN wasn't set.
    assert.equal(app.apiTokenGenerated, true);
    assert.equal(app.store.state.apiToken, app.apiToken);
  } finally {
    close();
  }
});

test('push ingestion and manual credits', async () => {
  const { app, url, close } = await startApp({
    DATA_DIR: path.join(dir, 'data3'),
    API_TOKEN: 't',
    CLAUDE_ENABLED: 'false',
    OPENAI_ENABLED: 'false',
    GEMINI_CREDIT_TOTAL: '1000',
    GEMINI_CREDIT_START: new Date(now - 45 * 24 * H).toISOString(),
    GEMINI_CREDIT_END: new Date(now + 45 * 24 * H).toISOString(),
  });
  const auth = { Authorization: 'Bearer t', 'Content-Type': 'application/json' };
  try {
    await app.collector.refreshAll();
    assert.equal(app.status().providers[0].error?.code, 'not_configured');

    let r = await fetch(`${url}/api/v1/manual/gemini`, { method: 'PUT', headers: auth, body: JSON.stringify({ used: 200 }) });
    assert.equal(r.status, 200);
    let s = (await r.json()) as StatusResponse;
    assert.equal(s.providers[0].status, 'under'); // 20% used at 50% of the period
    assert.equal(s.providers[0].source, 'manual');

    r = await fetch(`${url}/api/v1/manual/gemini`, { method: 'PUT', headers: auth, body: JSON.stringify({ used: -5 }) });
    assert.equal(r.status, 400);

    r = await fetch(`${url}/api/v1/ingest`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        snapshots: [
          {
            provider: 'claude',
            fetchedAt: new Date().toISOString(),
            source: 'claude-oauth',
            plan: 'Pro',
            readings: [{ kind: 'window', id: 'week', label: 'Semana', role: 'week', usedPct: 99, resetsAt: new Date(now + H).toISOString(), windowSeconds: 604800 }],
          },
        ],
      }),
    });
    assert.equal(r.status, 200);
    s = (await r.json()) as StatusResponse;
    const claude = s.providers.find((p) => p.id === 'claude');
    assert.equal(claude?.source, 'push:claude-oauth');
    assert.equal(claude?.status, 'on_pace');

    r = await fetch(`${url}/api/v1/ingest`, { method: 'POST', headers: auth, body: JSON.stringify({ snapshots: [{ provider: 'evil' }] }) });
    assert.equal(r.status, 400);

    // State survives a restart.
    const again = await createApp(app.config);
    assert.equal(again.store.state.manual.gemini?.used, 200);
    assert.equal(again.store.state.snapshots.claude?.plan, 'Pro');
  } finally {
    close();
  }
});

test('Google Cloud credits via Cloud Billing budget notifications (Pub/Sub)', async () => {
  const saFile = path.join(dir, 'sa-pubsub.json');
  writeFileSync(
    saFile,
    JSON.stringify({
      client_email: 'sa@proj.iam.gserviceaccount.com',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
      token_uri: `${upstreamUrl}/google/token`,
    }),
  );
  const notice = (name: string, cost: number, publishTime: string, intervalStart = '2026-11-09T08:00:00Z') => ({
    ackId: `ack-${name}-${cost}`,
    message: {
      data: Buffer.from(JSON.stringify({ budgetDisplayName: name, costAmount: cost, costIntervalStart: intervalStart, budgetAmount: 3000, currencyCode: 'EUR' })).toString('base64'),
      publishTime,
    },
  });
  const { app, close } = await startApp({
    DATA_DIR: path.join(dir, 'data4'),
    API_TOKEN: 't',
    CLAUDE_ENABLED: 'false',
    OPENAI_ENABLED: 'false',
    GEMINI_CREDIT_TOTAL: '3000',
    GEMINI_CREDIT_CURRENCY: 'EUR',
    GEMINI_CREDIT_START: new Date(now - 68 * 24 * H).toISOString(),
    GEMINI_CREDIT_END: new Date(now + 22 * 24 * H).toISOString(),
    GEMINI_CREDIT_USED_OFFSET: '600.25',
    GCP_PUBSUB_SUBSCRIPTION: 'projects/host-proj/subscriptions/ai-pace-budget',
    GCP_SERVICE_ACCOUNT_FILE: saFile,
    GCP_BUDGET_SINCE: '2026-11-09',
    PUBSUB_API_BASE: `${upstreamUrl}/pubsub`,
  });
  const gemini = () => app.status().providers.find((p) => p.id === 'gemini')!;
  try {
    // Before Google's first notification: the baseline, with a clear note.
    await app.collector.refreshAll();
    assert.equal(gemini().error, null);
    assert.equal(gemini().primary?.used, 600.25);
    assert.match(gemini().extras.map((x) => x.value).join(' '), /waiting for Google's first budget update/);
    assert.equal(gemini().acceptsManual, false);

    pubsubQueue = [
      notice('AI Pace (gross)', 100, '2026-11-09T10:00:00Z'),
      notice('AI Pace (gross)', 300, '2026-11-09T16:00:00Z'),
      notice('AI Pace (net)', 20, '2026-11-09T16:00:00Z'),
      notice('AI Pace (gross)', 9999, '2026-11-10T00:00:00Z', '2026-08-01T07:00:00Z'), // previous credit's period
      { ackId: 'junk', message: { data: Buffer.from('not json').toString('base64') } },
    ];
    await app.collector.refreshAll();
    const g = gemini();
    assert.equal(g.source, 'gcp-budget');
    assert.equal(g.primary?.used, 880.25, 'baseline + (gross − net) from the newest current notices');
    assert.equal(g.primary?.dataAsOf, '2026-11-09T16:00:00Z');
    assert.deepEqual([...acked].sort(), ['ack-AI Pace (gross)-100', 'ack-AI Pace (gross)-300', 'ack-AI Pace (gross)-9999', 'ack-AI Pace (net)-20', 'junk'].sort());

    // No new messages: keep the last known values (they were acknowledged, so they live in the state).
    await app.collector.refreshAll();
    assert.equal(gemini().primary?.used, 880.25);
    const again = await createApp(app.config);
    assert.equal(again.store.state.budgets?.['AI Pace (gross)']?.cost, 300);
  } finally {
    close();
  }
});
