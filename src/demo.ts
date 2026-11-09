/**
 * Demo server with fake data: try the dashboard, the iPhone widget and the menu bar plugins
 * without any credentials. `npm run demo` → http://localhost:8788/#token=demo
 */
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.ts';
import { createApp } from './app.ts';
import { createHttpHandler } from './http.ts';
import { log } from './lib/log.ts';
import type { ProviderSnapshot } from './types.ts';

const H = 3600_000;
const D = 24 * H;

export function demoSnapshots(now = Date.now()): ProviderSnapshot[] {
  const at = (ms: number) => new Date(now + ms).toISOString();
  const fetchedAt = at(-4 * 60_000);
  return [
    {
      provider: 'claude',
      fetchedAt,
      source: 'claude-oauth',
      plan: 'Max',
      readings: [
        { kind: 'window', id: 'session', label: 'Session (5h)', role: 'session', usedPct: 18, resetsAt: at(2 * H), windowSeconds: 5 * 3600 },
        { kind: 'window', id: 'week', label: 'Week', role: 'week', usedPct: 52, resetsAt: at(4 * D), windowSeconds: 7 * 86400 },
        { kind: 'window', id: 'week-opus', label: 'Week · Opus', role: 'other', usedPct: 30, resetsAt: at(4 * D), windowSeconds: 7 * 86400 },
      ],
      extras: [{ id: 'extra_usage', label: 'Extra usage', value: 'off', tone: 'neutral' }],
    },
    {
      provider: 'openai',
      fetchedAt,
      source: 'codex-oauth',
      plan: 'Pro',
      readings: [
        { kind: 'window', id: 'session', label: 'Session (5h)', role: 'session', usedPct: 0, resetsAt: null, windowSeconds: 5 * 3600 },
        { kind: 'window', id: 'week', label: 'Week', role: 'week', usedPct: 31, resetsAt: at(5 * D), windowSeconds: 7 * 86400 },
      ],
      extras: [{ id: 'credits', label: 'Credits', value: 'none', tone: 'neutral' }],
    },
    {
      provider: 'gemini',
      fetchedAt,
      source: 'gcp-bigquery',
      plan: 'Startup credits',
      readings: [
        {
          kind: 'budget',
          id: 'credits',
          label: 'Credits',
          role: 'credits',
          used: 610.4,
          total: 1000,
          currency: 'USD',
          periodStart: at(-70 * D),
          periodEnd: at(12 * D),
          dataAsOf: at(-5 * H),
          renewDays: 15,
        },
      ],
      extras: [{ id: 'remaining', label: 'Remaining', value: '$389.60', tone: 'neutral' }],
    },
  ];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = loadConfig({
    PORT: process.env.PORT ?? '8788',
    API_TOKEN: 'demo',
    DATA_DIR: mkdtempSync(path.join(tmpdir(), 'ai-pace-demo-')),
    CLAUDE_ENABLED: 'false',
    OPENAI_ENABLED: 'false',
    GEMINI_ENABLED: 'false',
  });
  const app = await createApp(config);
  const seed = () => {
    for (const snap of demoSnapshots()) app.store.state.snapshots[snap.provider] = snap;
  };
  seed();
  // Keep "fetched 4 min ago" fresh so the demo never looks stale.
  setInterval(seed, 5 * 60_000);
  createServer(createHttpHandler(app)).listen(config.port, config.host, () => {
    log.info(`Demo at http://localhost:${config.port}/#token=demo (fake data)`);
  });
}
