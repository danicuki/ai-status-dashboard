import type { ProviderId, ProviderSnapshot } from './types.ts';
import type { Provider } from './providers/provider.ts';
import type { Store } from './store.ts';
import { ProviderError, errorMessage } from './lib/errors.ts';
import { log } from './lib/log.ts';

/** Polls every configured provider on a fixed interval and stores the latest snapshot (or error). */
export class Collector {
  private providers: Provider[];
  private store: Store;
  private running: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  /** Backoff after HTTP 429. */
  private notBefore = new Map<ProviderId, number>();

  constructor(providers: Provider[], store: Store) {
    this.providers = providers;
    this.store = store;
  }

  start(intervalMinutes: number): void {
    void this.refreshAll();
    this.timer = setInterval(() => void this.refreshAll(), intervalMinutes * 60_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Concurrent callers share the same run. `force` ignores rate-limit backoff (manual "refresh" button). */
  refreshAll(force = false): Promise<void> {
    this.running ??= (async () => {
      const due = this.providers.filter((p) => p.enabled && (force || (this.notBefore.get(p.id) ?? 0) <= Date.now()));
      await Promise.all(due.map((p) => this.refreshOne(p)));
      await this.store.save();
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  async refreshProvider(id: ProviderId): Promise<void> {
    const p = this.providers.find((x) => x.id === id && x.enabled);
    if (!p) return;
    await this.refreshOne(p);
    await this.store.save();
  }

  private async refreshOne(p: Provider): Promise<void> {
    const started = Date.now();
    try {
      const snap = await p.fetch();
      this.store.state.snapshots[p.id] = snap;
      delete this.store.state.errors[p.id];
      this.notBefore.delete(p.id);
      log.info(`${p.name}: ok in ${Date.now() - started}ms (${summarize(snap)})`);
    } catch (e) {
      const code = e instanceof ProviderError ? e.code : 'network';
      this.store.state.errors[p.id] = { message: errorMessage(e), code, at: new Date().toISOString() };
      if (e instanceof ProviderError && e.code === 'rate_limited') {
        this.notBefore.set(p.id, Date.now() + Math.max(e.retryAfterSec ?? 0, 30 * 60) * 1000);
      }
      log.warn(`${p.name}: ${errorMessage(e)}`);
    }
  }

  /** Data pushed by a remote collector (`npm run push`). */
  ingest(snapshots: ProviderSnapshot[]): void {
    for (const s of snapshots) {
      this.store.state.snapshots[s.provider] = { ...s, source: `push:${s.source}` };
      delete this.store.state.errors[s.provider];
    }
  }
}

function summarize(s: ProviderSnapshot): string {
  return s.readings
    .map((r) => (r.kind === 'window' ? `${r.label} ${r.usedPct ?? '?'}%` : `${r.label} ${r.used}/${r.total}`))
    .join(', ');
}
