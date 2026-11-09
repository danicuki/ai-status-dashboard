import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWidget } from './scriptable-harness.ts';
import { buildStatus } from '../src/status.ts';
import { demoSnapshots } from '../src/demo.ts';
import type { State } from '../src/store.ts';

function demoStatus() {
  const state: State = { version: 1, snapshots: {}, errors: {}, manual: {} };
  for (const s of demoSnapshots()) state.snapshots[s.provider] = s;
  return buildStatus([], state, { version: 'test', refreshMinutes: 15, tolerancePct: 5 });
}

const FAMILIES = ['small', 'medium', 'large', 'accessoryRectangular', 'accessoryCircular', 'accessoryInline'];

for (const family of FAMILIES) {
  test(`iOS widget renders: ${family}`, async () => {
    const r = await runWidget({ family, status: demoStatus() });
    assert.ok(r.widget, 'Script.setWidget was called');
    assert.equal(r.requests[0].url, 'https://pi.example/api/v1/status');
    assert.equal(r.requests[0].headers.Authorization, 'Bearer tok');
    assert.equal(r.widget.url, 'https://pi.example/', 'tapping the widget never puts the token in a URL');
    assert.ok(r.widget.refreshAfterDate instanceof Date);
    assert.ok(r.html.length > 100);
  });
}

test('iOS widget: inline text and circular provider parameter', async () => {
  const inline = await runWidget({ family: 'accessoryInline', status: demoStatus() });
  assert.equal(inline.widget!.children[0].text, 'C▲+9  O●+2  G▼−24⚠');
  const circ = await runWidget({ family: 'accessoryCircular', status: demoStatus(), param: 'gemini' });
  assert.match(circ.html, />G▼ −24⚠</);
  const worst = await runWidget({ family: 'accessoryCircular', status: demoStatus() });
  assert.match(worst.html, />C▲ \+9</, 'without a parameter the circular widget shows the worst provider');
});

test('iOS widget: offline uses the cached response', async () => {
  const files = new Map<string, string>();
  await runWidget({ family: 'small', status: demoStatus(), files });
  const offline = await runWidget({ family: 'small', status: demoStatus(), httpStatus: 0, files });
  assert.match(offline.html, /offline · \d/);
  assert.match(offline.html, /<ellipse/, 'chart still drawn from the cached data');
  const noCache = await runWidget({ family: 'small', status: demoStatus(), httpStatus: 0 });
  assert.match(noCache.html, /⚠ The Internet connection appears to be offline/);
});

test('iOS widget: no settings → asks to configure; app mode presents a preview', async () => {
  const none = await runWidget({ family: 'small', status: demoStatus(), keychain: {} });
  assert.match(none.html, /open the Scriptable app/);
  const app = await runWidget({ family: 'medium', status: demoStatus(), runsInApp: true, alertChoices: [1] });
  assert.equal(app.presented, 'presentMedium');
  const setup = await runWidget({ family: 'small', status: demoStatus(), runsInApp: true, keychain: {}, alertChoices: [0, -1] });
  assert.equal(setup.requests.length, 0, 'empty fields are not saved');
});

test('iOS widget: 401 shows a clear message', async () => {
  const r = await runWidget({ family: 'small', status: demoStatus(), httpStatus: 401 });
  assert.match(r.html, /invalid token/);
});

test('iOS widget security: http:// server is refused and nothing is sent', async () => {
  const r = await runWidget({ family: 'small', status: demoStatus(), keychain: { 'ai-pace.server': 'http://192.168.0.5:8787', 'ai-pace.token': 'tok' } });
  assert.equal(r.requests.length, 0, 'the token must not travel over plain http');
  assert.match(r.html, /must use https/);
});

test('iOS widget security: hostile server response is reduced to safe, bounded data', async () => {
  const evil = {
    providers: Array.from({ length: 50 }, (_, i) => ({
      id: { $: 1 },
      name: i % 2 ? { toString: 'x' } : 'N'.repeat(500),
      short: 'CCCCCC',
      status: 'constructor',
      fetchedAt: 'not a date',
      primary: { status: '__proto__', gauge: 1e9, usedPct: 'NaN', elapsedPct: -5, deltaPct: Infinity, summary: 'S'.repeat(1000) },
      session: 'nope',
    })),
    extra: '<script>alert(1)</script>',
  };
  const r = await runWidget({ family: 'large', status: evil });
  assert.ok(r.widget, 'still renders');
  const dots = (r.html.match(/<ellipse/g) || []).length;
  assert.ok(dots > 0 && dots <= 5, `at most 5 providers are drawn (got ${dots})`);
  assert.ok(!r.html.includes('NNNNNNNNNNNNNNNNNNNNN'), 'long strings are truncated');
  assert.ok(!r.html.includes('[object Object]'), 'non-string fields are dropped');
});

test('iOS widget security: an invalid 200 response is not cached and falls back to the last good data', async () => {
  const files = new Map<string, string>();
  await runWidget({ family: 'small', status: demoStatus(), files });
  const cachedBefore = [...files.values()][0];
  const bad = await runWidget({ family: 'small', status: { hello: 'world' }, files });
  assert.equal([...files.values()][0], cachedBefore, 'cache untouched');
  assert.match(bad.html, /offline/);
  files.set([...files.keys()][0], '{corrupt');
  const corrupt = await runWidget({ family: 'small', status: { nope: 1 }, files });
  assert.match(corrupt.html, /invalid server response/, 'a corrupt cache never crashes the widget');
});

test('iOS widget security: invisible and bidi characters from the server are stripped', async () => {
  const status = demoStatus();
  (status.providers[0] as any).name = 'Cla\u202eude\u200b\u0007\u2028\u00ad\u0085\u2063\u061c';
  const r = await runWidget({ family: 'medium', status });
  assert.ok(r.html.includes('>Claude<'), 'name rendered without hidden characters');
  assert.ok(!/[\u202e\u200b\u0007\u2028\u00ad\u0085\u2063\u061c]/.test(r.html));
});
