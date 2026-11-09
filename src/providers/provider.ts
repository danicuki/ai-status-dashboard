import type { ProviderId, ProviderSnapshot } from '../types.ts';

export interface Provider {
  id: ProviderId;
  name: string;
  /** One-letter label for tiny displays (menu bar, lock screen, LEDs). */
  short: string;
  /** false = not configured on this server (it can still show data pushed by a remote collector). */
  enabled: boolean;
  /** Accepts a hand-typed "amount used" (Gemini credits without BigQuery). */
  acceptsManual?: boolean;
  /** Human description of where the data comes from, for logs and `npm run check`. */
  describe(): string;
  fetch(): Promise<ProviderSnapshot>;
}

export type TokenMode = 'shared' | 'dedicated';

export const PROVIDER_META: Record<ProviderId, { name: string; short: string }> = {
  claude: { name: 'Claude', short: 'C' },
  openai: { name: 'OpenAI', short: 'O' },
  gemini: { name: 'Gemini', short: 'G' },
};

/**
 * Serializes token refreshes: OAuth refresh tokens rotate, so two concurrent refreshes with the
 * same token would make one of them fail (or even revoke the session).
 */
export function singleFlight<T>(fn: () => Promise<T>): () => Promise<T> {
  let inflight: Promise<T> | null = null;
  return () => {
    inflight ??= fn().finally(() => {
      inflight = null;
    });
    return inflight;
  };
}

export const ROLE_ORDER = { session: 0, week: 1, credits: 2, other: 3 } as const;
