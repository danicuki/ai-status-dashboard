import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseClaudeUsage } from '../src/providers/claude.ts';
import { parseCodexUsage } from '../src/providers/openai.ts';
import { buildBillingQuery, parseBillingResult } from '../src/providers/gemini.ts';
import { ProviderError } from '../src/lib/errors.ts';

const NOW = Date.parse('2026-11-10T12:00:00Z');

test('Claude: legacy shape (five_hour / seven_day / per-model / extra_usage in cents)', () => {
  const snap = parseClaudeUsage(
    {
      five_hour: { utilization: 12.0, resets_at: '2026-11-10T15:00:00.000000+00:00' },
      seven_day: { utilization: 34.0, resets_at: '2026-11-15T04:00:00+00:00' },
      seven_day_oauth_apps: null,
      seven_day_opus: { utilization: 0.0, resets_at: null },
      seven_day_sonnet: { utilization: 3.0, resets_at: '2026-11-15T04:00:00+00:00' },
      extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 1230, utilization: 24.6, currency: 'USD' },
    },
    { plan: 'max', now: NOW },
  );
  assert.equal(snap.plan, 'Max');
  assert.deepEqual(
    snap.readings.map((r) => r.id),
    ['session', 'week', 'week-sonnet'],
  );
  const session = snap.readings[0];
  assert.equal(session.kind === 'window' && session.usedPct, 12);
  assert.equal(snap.extras?.[0].value, '$12.30 of $50.00');
});

test('Claude: newer limits[] shape wins and maps scoped weeks', () => {
  const snap = parseClaudeUsage({
    limits: [
      { kind: 'session', group: 'session', percent: 40, resets_at: '2026-11-10T14:00:00Z', severity: 'normal' },
      { kind: 'weekly_all', group: 'weekly', percent: 55, resets_at: '2026-11-14T00:00:00Z' },
      { kind: 'weekly_scoped', group: 'weekly', percent: 70, resets_at: '2026-11-14T00:00:00Z', scope: { model: { display_name: 'Opus' } } },
    ],
    five_hour: { utilization: 1, resets_at: null },
    seven_day_opus: { utilization: 70, resets_at: '2026-11-14T00:00:00Z' },
    extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
  });
  assert.deepEqual(
    snap.readings.map((r) => [r.id, r.kind === 'window' ? r.usedPct : null]),
    [
      ['session', 40],
      ['week', 55],
      ['week-opus', 70],
    ],
  );
  assert.equal(snap.extras?.[0].value, 'off');
});

test('Claude: no active session still yields an idle session row', () => {
  const snap = parseClaudeUsage({ five_hour: null, seven_day: { utilization: 5, resets_at: '2026-11-15T00:00:00Z' } });
  const s = snap.readings.find((r) => r.id === 'session');
  assert.ok(s && s.kind === 'window' && s.resetsAt === null && s.usedPct === 0);
});

test('Claude: unexpected payload is a parse error', () => {
  assert.throws(() => parseClaudeUsage({ hello: 1 }), (e: unknown) => e instanceof ProviderError && e.code === 'parse');
  assert.throws(() => parseClaudeUsage([]), ProviderError);
});

test('Codex: primary (5h) / secondary (week) windows, credits and plan', () => {
  const snap = parseCodexUsage(
    {
      plan_type: 'pro',
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: { used_percent: 22, limit_window_seconds: 18000, reset_after_seconds: 7200, reset_at: NOW / 1000 + 7200 },
        secondary_window: { used_percent: 61, limit_window_seconds: 604800, reset_after_seconds: 3 * 86400, reset_at: NOW / 1000 + 3 * 86400 },
      },
      credits: { has_credits: true, unlimited: false, balance: '125' },
      additional_rate_limits: [
        { limit_name: 'GPT-5 Codex Max', metered_feature: 'x', rate_limit: { primary_window: { used_percent: 5, limit_window_seconds: 604800, reset_at: NOW / 1000 + 86400 } } },
      ],
    },
    NOW,
  );
  assert.equal(snap.plan, 'Pro');
  const [session, week, extra] = snap.readings;
  assert.equal(session.role, 'session');
  assert.equal(session.label, 'Session (5h)');
  assert.equal(week.role, 'week');
  assert.equal(week.kind === 'window' && week.resetsAt, new Date(NOW + 3 * 86400_000).toISOString());
  assert.equal(extra.label, 'GPT-5 Codex Max · Week');
  assert.deepEqual(snap.extras?.[0], { id: 'credits', label: 'Credits', value: '125', tone: 'neutral' });
});

test('Codex: only reset_after_seconds, missing primary window → idle session', () => {
  const snap = parseCodexUsage({ rate_limit: { secondary_window: { used_percent: 10, limit_window_seconds: 604800, reset_after_seconds: 3600 } } }, NOW);
  const week = snap.readings.find((r) => r.id === 'week');
  assert.equal(week?.kind === 'window' && week.resetsAt, new Date(NOW + 3600_000).toISOString());
  assert.equal(snap.readings.find((r) => r.id === 'session')?.role, 'session');
  assert.throws(() => parseCodexUsage({ plan_type: 'free' }), ProviderError);
});

test('BigQuery: query is parameterized and table name is validated', () => {
  const q = buildBillingQuery({ table: 'my-proj.billing.gcp_billing_export_v1_0123', projectIds: ['gemini-proj'] });
  assert.match(q, /FROM `my-proj\.billing\.gcp_billing_export_v1_0123`/);
  assert.match(q, /project\.id IN UNNEST\(@projects\)/);
  assert.match(q, /c\.type IN UNNEST\(@credit_types\)/);
  assert.throws(() => buildBillingQuery({ table: 'x`; DROP TABLE y; --', projectIds: [] }), ProviderError);
  assert.throws(() => buildBillingQuery({ table: 'only.two', projectIds: [] }), ProviderError);
});

test('BigQuery: credits are negative in the export', () => {
  const r = parseBillingResult({ jobComplete: true, rows: [{ f: [{ v: '412.3456' }, { v: '-398.111' }, { v: '2026-11-10T06:00:00Z' }, { v: 'USD' }] }] });
  assert.deepEqual(r, { grossCost: 412.35, creditsUsed: 398.11, lastExport: '2026-11-10T06:00:00Z', currency: 'USD' });
  assert.deepEqual(parseBillingResult({ jobComplete: true }), { grossCost: 0, creditsUsed: 0, lastExport: null, currency: null });
});
