import path from 'node:path';
import type { ProviderId, ProviderSnapshot } from './types.ts';
import type { BudgetNotice } from './providers/gcp-budgets.ts';
import { readJsonFile, writeJsonFileAtomic } from './lib/json.ts';
import { log } from './lib/log.ts';

export interface StoredError {
  message: string;
  code: string;
  at: string;
}

export interface State {
  version: 1;
  /** Generated when API_TOKEN isn't set, so the API is never open by accident. */
  apiToken?: string;
  snapshots: Partial<Record<ProviderId, ProviderSnapshot>>;
  errors: Partial<Record<ProviderId, StoredError>>;
  manual: Partial<Record<ProviderId, { used: number; updatedAt: string; key?: string }>>;
  /** Latest Cloud Billing budget notifications (Pub/Sub messages are acknowledged, so they live here). */
  budgets?: Record<string, BudgetNotice>;
}

const emptyState = (): State => ({ version: 1, snapshots: {}, errors: {}, manual: {} });

/** Tiny JSON-file persistence: survives restarts, no database needed (works on a Raspberry Pi). */
export class Store {
  readonly file: string;
  state: State = emptyState();
  private writing: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'state.json');
  }

  async load(): Promise<void> {
    try {
      const s = await readJsonFile<State>(this.file);
      if (s && s.version === 1) this.state = { ...emptyState(), ...s };
    } catch (e) {
      log.warn(`Ignoring corrupt ${this.file}: ${(e as Error).message}`);
    }
  }

  save(): Promise<void> {
    const snapshot = structuredClone(this.state);
    this.writing = this.writing.then(() => writeJsonFileAtomic(this.file, snapshot)).catch((e) => log.error('Failed to save state:', e));
    return this.writing;
  }
}
