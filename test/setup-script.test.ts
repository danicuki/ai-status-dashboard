/**
 * Runs scripts/setup-gcp-budget.sh against fake `gcloud` and `curl` binaries: checks the exact
 * calls and the JSON sent to the Budget API, on a first run (create) and a re-run (update).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/setup-gcp-budget.sh', import.meta.url));
const dir = mkdtempSync(path.join(tmpdir(), 'ai-pace-setup-'));
const bin = path.join(dir, 'bin');
const state = path.join(dir, 'state');
execFileSync('mkdir', ['-p', bin, state]);

writeFileSync(
  path.join(bin, 'gcloud'),
  `#!/usr/bin/env bash
echo "gcloud $*" >> "$STATE/calls.log"
case "$*" in
  "auth list"*) echo "me@example.com" ;;
  "config get-value project"*) echo "my-host-project" ;;
  "billing projects describe"*) echo "billingAccounts/ABCDEF-123456-7890AB" ;;
  "billing accounts describe"*) echo "BRL" ;;
  "services enable"*) ;;
  "pubsub topics describe"*) [ -f "$STATE/topic" ] || exit 1 ;;
  "pubsub topics create"*) touch "$STATE/topic" ;;
  "pubsub subscriptions describe"*) [ -f "$STATE/sub" ] || exit 1 ;;
  "pubsub subscriptions create"*) touch "$STATE/sub" ;;
  "iam service-accounts describe"*) [ -f "$STATE/sa" ] || exit 1 ;;
  "iam service-accounts create"*) touch "$STATE/sa" ;;
  "pubsub subscriptions add-iam-policy-binding"*) ;;
  "auth print-access-token"*) echo "ya29.FAKE-TOKEN" ;;
  "billing budgets list"*) if [ -n "$FAIL_LIST" ]; then echo "ERROR: (gcloud) PERMISSION_DENIED" >&2; exit 1; fi; if [ -f "$STATE/budgets" ]; then cat "$STATE/budgets"; fi ;;
  "iam service-accounts keys create"*) echo '{"type":"service_account"}' > "$5" ;;
  *) echo "unexpected gcloud call: $*" >&2; exit 2 ;;
esac
`,
);
writeFileSync(
  path.join(bin, 'curl'),
  `#!/usr/bin/env bash
method=GET; data=""; out=""; headers=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -X) method=$2; shift ;;
    --data) data=$2; shift ;;
    -o) out=$2; shift ;;
    -H) headers=$2; shift ;;
    -w|-sS) [ "$1" = -w ] && shift ;;
    *) url=$1 ;;
  esac
  shift
done
hfile=\${headers#@}
grep -q '^Authorization: Bearer ya29.FAKE-TOKEN$' "$hfile" || { echo "missing auth header" >&2; exit 3; }
grep -q '^x-goog-user-project: my-host-project$' "$hfile" || { echo "missing quota project" >&2; exit 3; }
printf '%s %s %s\\n' "$method" "$url" "$data" >> "$STATE/http.log"
if [ "$method" = POST ]; then
  n=$(wc -l < "$STATE/http.log" | tr -d ' ')
  name=$(printf '%s' "$data" | sed -E 's/.*"displayName":"([^"]*)".*/\\1/')
  printf 'billingAccounts/ABCDEF-123456-7890AB/budgets/b%s\\t%s\\n' "$n" "$name" >> "$STATE/budgets"
fi
echo '{}' > "$out"
printf 200
`,
);
chmodSync(path.join(bin, 'gcloud'), 0o755);
chmodSync(path.join(bin, 'curl'), 0o755);

function run(): string {
  try {
    return runScript({});
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    throw new Error(`setup script failed\n--- stdout\n${err.stdout}\n--- stderr\n${err.stderr}`);
  }
}

function runScript(extraEnv: Record<string, string>): string {
  return execFileSync('bash', [SCRIPT], {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      STATE: state,
      YES: '1',
      CREDIT_START: '2026-01-15',
      CREDIT_END: '2099-12-01',
      CREDIT_TOTAL: '3000.50',
      CREDIT_REMAINING: '2400.25',
      KEY_FILE: path.join(dir, 'key.json'),
      ...extraEnv,
    },
  });
}

function httpCalls(): { method: string; url: string; body: any }[] {
  return readFileSync(path.join(state, 'http.log'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => {
      const [method, url, ...rest] = line.split(' ');
      return { method, url, body: JSON.parse(rest.join(' ')) };
    });
}

test('setup script: first run creates everything with the right budget definitions', () => {
  const out = run();
  const today = new Date().toISOString().slice(0, 10);
  const [y, m, d] = today.split('-').map(Number);

  const calls = httpCalls();
  assert.equal(calls.length, 2);
  for (const c of calls) {
    assert.equal(c.method, 'POST');
    assert.equal(c.url, 'https://billingbudgets.googleapis.com/v1/billingAccounts/ABCDEF-123456-7890AB/budgets');
    assert.deepEqual(c.body.budgetFilter.customPeriod, { startDate: { year: y, month: m, day: d }, endDate: { year: 2099, month: 12, day: 1 } });
    assert.equal(c.body.budgetFilter.projects, undefined, 'no project filter: the whole billing account');
    assert.deepEqual(c.body.amount, { specifiedAmount: { units: '3000' } });
    assert.deepEqual(c.body.notificationsRule, {
      pubsubTopic: 'projects/my-host-project/topics/ai-pace-budget',
      schemaVersion: '1.0',
      disableDefaultIamRecipients: true,
    });
    assert.equal(c.body.thresholdRules, undefined, 'notification-only budget');
  }
  assert.equal(calls[0].body.displayName, 'AI Pace (gross)');
  assert.equal(calls[0].body.budgetFilter.creditTypesTreatment, 'EXCLUDE_ALL_CREDITS');
  assert.equal(calls[1].body.displayName, 'AI Pace (net)');
  assert.equal(calls[1].body.budgetFilter.creditTypesTreatment, 'INCLUDE_SPECIFIED_CREDITS');
  assert.deepEqual(calls[1].body.budgetFilter.creditTypes, ['PROMOTION']);

  const gcloud = readFileSync(path.join(state, 'calls.log'), 'utf8');
  assert.match(gcloud, /pubsub subscriptions add-iam-policy-binding ai-pace-budget .*serviceAccount:ai-pace-reader@my-host-project\.iam\.gserviceaccount\.com --role roles\/pubsub\.subscriber/);
  assert.doesNotMatch(gcloud, /roles\/(owner|editor|billing)/, 'the reader gets no broad role');
  assert.ok(existsSync(path.join(dir, 'key.json')));
  assert.equal(statSync(path.join(dir, 'key.json')).mode & 0o777, 0o600);
  assert.ok(!out.includes('ya29.FAKE-TOKEN'), 'the access token is never printed');

  assert.match(out, /GEMINI_CREDIT_USED_OFFSET=600\.25/);
  assert.match(out, /GEMINI_CREDIT_CURRENCY=BRL/);
  assert.match(out, /GCP_PUBSUB_SUBSCRIPTION=projects\/my-host-project\/subscriptions\/ai-pace-budget/);
  assert.match(out, new RegExp(`GCP_BUDGET_SINCE=${today}`));
});

test('setup script: re-running updates the budgets instead of duplicating them, keeps the key', () => {
  const keyBefore = readFileSync(path.join(dir, 'key.json'), 'utf8');
  writeFileSync(path.join(state, 'http.log'), '');
  run();
  const calls = readFileSync(path.join(state, 'http.log'), 'utf8').trim().split('\n');
  assert.equal(calls.length, 2);
  for (const line of calls) {
    assert.match(line, /^PATCH https:\/\/billingbudgets\.googleapis\.com\/v1\/billingAccounts\/ABCDEF-123456-7890AB\/budgets\/b\d\?updateMask=budgetFilter,amount,notificationsRule /);
  }
  assert.equal(readFileSync(path.join(dir, 'key.json'), 'utf8'), keyBefore, 'no new key on re-run');
  const creates = readFileSync(path.join(state, 'calls.log'), 'utf8').match(/topics create|subscriptions create|service-accounts create /g) ?? [];
  assert.equal(creates.length, 3, 'topic, subscription and account are created only once');
});

test('setup script: a failing gcloud call stops with an explanation, not silently', () => {
  assert.throws(
    () => runScript({ FAIL_LIST: '1' }),
    (e: { status?: number; stderr?: string }) => e.status === 1 && /PERMISSION_DENIED/.test(e.stderr ?? '') && /Could not list the budgets/.test(e.stderr ?? ''),
  );
});
