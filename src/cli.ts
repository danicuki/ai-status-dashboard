import { parseArgs } from 'node:util';
import { loadConfig } from './config.ts';
import { createApp } from './app.ts';
import { buildStatus } from './status.ts';
import { STATUS_GLYPH } from './render.ts';
import { fmtSigned } from './format.ts';
import { errorMessage } from './lib/errors.ts';
import { setQuiet } from './lib/log.ts';
import type { PaceStatus, ProviderSnapshot } from './types.ts';
import type { State } from './store.ts';

const HELP = `AI Pace — command line

  npm run check            fetch data from every configured provider now and print the pace
  npm run push -- --url https://your-server --token TOKEN
                           fetch data on this machine and send it to a remote server
                           (or set AIPACE_URL and AIPACE_TOKEN)
  npm run token            print this server's API token
`;

const tty = process.stdout.isTTY;
const COLOR: Record<PaceStatus, string> = { over: '33', limit: '31', on_pace: '32', under: '34', idle: '90', ended: '90', unknown: '90' };
const paint = (s: PaceStatus, t: string) => (tty ? `\u001b[${COLOR[s]}m${t}\u001b[0m` : t);
const dim = (t: string) => (tty ? `\u001b[2m${t}\u001b[0m` : t);
const bold = (t: string) => (tty ? `\u001b[1m${t}\u001b[0m` : t);

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { url: { type: 'string' }, token: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
});
const command = positionals[0] ?? 'check';
if (values.help || command === 'help') {
  console.log(HELP);
  process.exit(0);
}

setQuiet(true);
const config = loadConfig();
const app = await createApp(config);

if (command === 'token') {
  console.log(app.apiToken);
  process.exit(0);
}
if (command !== 'check' && command !== 'push') {
  console.error(`Unknown command: ${command}\n\n${HELP}`);
  process.exit(2);
}

const enabled = app.providers.filter((p) => p.enabled);
if (!enabled.length) {
  console.error('No provider configured. See .env.example and the README.');
  process.exit(1);
}

const results = await Promise.all(
  enabled.map(async (p) => {
    try {
      return { p, snap: await p.fetch(), error: null as string | null };
    } catch (e) {
      return { p, snap: null, error: errorMessage(e) };
    }
  }),
);

if (command === 'check') {
  const state: State = { version: 1, snapshots: {}, errors: {}, manual: {} };
  for (const r of results) if (r.snap) state.snapshots[r.p.id] = r.snap;
  const status = buildStatus(app.providers, state, config);
  console.log(bold(`AI Pace — check (tolerance ±${config.tolerancePct} pts)\n`));
  for (const r of results) {
    console.log(`${bold(r.p.name)} ${dim(`— ${r.p.describe()}`)}`);
    if (r.error) {
      console.log(`  ${paint('limit', '✗')} ${r.error}\n`);
      continue;
    }
    const ps = status.providers.find((x) => x.id === r.p.id)!;
    if (ps.plan) console.log(`  plan: ${ps.plan}`);
    const width = Math.max(...ps.meters.map((m) => m.label.length));
    for (const m of ps.meters) {
      const delta = m.deltaPct == null ? '' : ` (${fmtSigned(m.deltaPct)})`;
      console.log(`  ${paint(m.status, STATUS_GLYPH[m.status])} ${m.label.padEnd(width)}  ${m.summary}${delta}  ${paint(m.status, m.statusLabel)}`);
      if (m.detail) console.log(`    ${' '.repeat(width)}${dim(m.detail)}`);
      if (m.expiry) console.log(`    ${' '.repeat(width)}${dim(m.expiry)}`);
    }
    for (const a of ps.alerts) console.log(`  ${paint('over', '⚠')} ${a}`);
    for (const x of ps.extras) console.log(`  ${x.label}: ${x.value}`);
    console.log('');
  }
  process.exit(results.some((r) => r.error) ? 1 : 0);
}

// push
const url = (values.url ?? process.env.AIPACE_URL ?? '').replace(/\/+$/, '');
const token = values.token ?? process.env.AIPACE_TOKEN ?? '';
if (!url || !token) {
  console.error('Pass --url and --token (or set AIPACE_URL and AIPACE_TOKEN).');
  process.exit(2);
}
for (const r of results) if (r.error) console.error(`${r.p.name}: ${r.error}`);
const snapshots = results.map((r) => r.snap).filter((s): s is ProviderSnapshot => s !== null);
if (!snapshots.length) process.exit(1);
const res = await fetch(`${url}/api/v1/ingest`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ snapshots }),
  signal: AbortSignal.timeout(20_000),
}).catch((e: unknown) => {
  console.error(`Failed to send to ${url}: ${errorMessage(e)}`);
  process.exit(1);
});
if (!res.ok) {
  console.error(`The server answered HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  process.exit(1);
}
console.log(`Sent: ${snapshots.map((s) => s.provider).join(', ')}`);
process.exit(results.some((r) => r.error) ? 1 : 0);
