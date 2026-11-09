import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, computeBudgetMeter, computeWindowMeter, gaugeFor } from '../src/pace.ts';
import type { BudgetReading, WindowReading } from '../src/types.ts';

const H = 3600_000;
const D = 24 * H;
const opts = { tolerancePct: 5 };
const NOW = Date.parse('2026-11-10T12:00:00Z'); // a Tuesday

function week(usedPct: number | null, resetsInMs: number | null): WindowReading {
  return {
    kind: 'window',
    id: 'week',
    label: 'Week',
    role: 'week',
    usedPct,
    resetsAt: resetsInMs == null ? null : new Date(NOW + resetsInMs).toISOString(),
    windowSeconds: 7 * 86400,
  };
}

test('classify: linear pace with tolerance', () => {
  assert.equal(classify(30, 28.6, 5), 'on_pace');
  assert.equal(classify(40, 28.6, 5), 'over');
  assert.equal(classify(10, 28.6, 5), 'under');
  assert.equal(classify(100, 50, 5), 'limit');
});

test('the user example: on day 2 of 7, using more than 2/7 means over pace', () => {
  // 2 days elapsed of a 7-day window → expected 28.6%.
  const m = computeWindowMeter(week(45, 5 * D), NOW, opts);
  assert.equal(m.elapsedPct, 28.6);
  assert.equal(m.status, 'over');
  assert.equal(m.deltaPct, 16.4);
  assert.ok(m.gauge! > 0.5 && m.gauge! < 1);
  // 45% in 2 days → 157% by the reset; runs out at 2d * 100/45 ≈ 4.44 days into the window.
  assert.equal(m.projectedPct, 158);
  assert.ok(m.exhaustsAt);
  const exhaustInDays = (Date.parse(m.exhaustsAt!) - (NOW - 2 * D)) / D;
  assert.ok(Math.abs(exhaustInDays - 200 / 45) < 0.01);
  assert.match(m.detail, /at this pace runs out in 2d 10h/);
});

test('under pace has negative delta and no exhaustion', () => {
  const m = computeWindowMeter(week(10, 5 * D), NOW, opts);
  assert.equal(m.status, 'under');
  assert.ok(m.deltaPct! < 0 && m.gauge! < 0);
  assert.equal(m.exhaustsAt, null);
  assert.equal(m.detail, 'resets in 5d');
  assert.equal(m.summary, '10% used · expected 29%');
});

test('no active window → idle; window already reset → idle at 0%', () => {
  const session: WindowReading = { ...week(0, null), id: 'session', role: 'session', windowSeconds: 5 * 3600 };
  assert.equal(computeWindowMeter(session, NOW, opts).status, 'idle');
  const rolled = computeWindowMeter(week(80, -H), NOW, opts);
  assert.equal(rolled.status, 'idle');
  assert.equal(rolled.usedPct, 0);
  assert.equal(computeWindowMeter(week(null, D), NOW, opts).status, 'unknown');
});

test('no projection at the very start of a window', () => {
  const m = computeWindowMeter(week(3, 7 * D - H), NOW, opts);
  assert.equal(m.projectedPct, null);
  assert.equal(m.status, 'on_pace');
});

test('gauge is a soft clamp in (−1, 1)', () => {
  assert.equal(gaugeFor(0), 0);
  assert.ok(gaugeFor(100) < 1 && gaugeFor(100) > 0.99);
  assert.equal(gaugeFor(-10), -gaugeFor(10));
});

function credits(used: number, start: string, end: string): BudgetReading {
  return { kind: 'budget', id: 'credits', label: 'Credits', role: 'credits', used, total: 1000, currency: 'USD', periodStart: start, periodEnd: end };
}

test('budget: US$ 1000 over 3 months, a third through', () => {
  const start = new Date(NOW - 30 * D).toISOString();
  const end = new Date(NOW + 60 * D).toISOString();
  const slow = computeBudgetMeter(credits(150, start, end), NOW, opts);
  assert.equal(slow.status, 'under');
  assert.equal(slow.burnPerDay, 5);
  assert.equal(slow.allowancePerDay, 14.17);
  assert.equal(slow.projectedUsed, 450);
  assert.equal(slow.summary, '$150 of $1,000 · expected $333');
  assert.equal(slow.detail, 'at this pace ~$550 goes unused · spending $5.00/day, budget allows $14.17/day');
  assert.match(slow.expiry!, /^expires in 60 days \(Jan 9\)$/);

  const fast = computeBudgetMeter(credits(600, start, end), NOW, opts);
  assert.equal(fast.status, 'over');
  assert.ok(fast.exhaustsAt);

  assert.equal(computeBudgetMeter(credits(1000, start, end), NOW, opts).status, 'limit');
});

test('budget: before start and after end', () => {
  const future = computeBudgetMeter(credits(0, new Date(NOW + D).toISOString(), new Date(NOW + 90 * D).toISOString()), NOW, opts);
  assert.equal(future.status, 'idle');
  const past = computeBudgetMeter(credits(700, new Date(NOW - 91 * D).toISOString(), new Date(NOW - D).toISOString()), NOW, opts);
  assert.equal(past.status, 'ended');
  assert.match(past.detail, /left unused/);
});

test('budget: renewal alert N days before the credits expire', () => {
  const withRenew = (endInDays: number): BudgetReading => ({
    ...credits(300, new Date(NOW - 80 * D).toISOString(), new Date(NOW + endInDays * D).toISOString()),
    renewDays: 15,
  });
  const early = computeBudgetMeter(withRenew(30), NOW, opts);
  assert.equal(early.alert, null);
  assert.match(early.expiry!, /^expires in 30 days \(Dec 10\) · request more from Nov 25$/);

  const due = computeBudgetMeter(withRenew(10.5), NOW, opts);
  assert.equal(due.alert, 'credits expire in 10 days — request more');

  const expired = computeBudgetMeter(withRenew(-1), NOW, opts);
  assert.equal(expired.status, 'ended');
  assert.equal(expired.alert, 'credits expired — set up the new credit');

  // No renewDays → never alerts.
  const plain = computeBudgetMeter(credits(300, new Date(NOW - 80 * D).toISOString(), new Date(NOW + 3 * D).toISOString()), NOW, opts);
  assert.equal(plain.alert, null);
});
