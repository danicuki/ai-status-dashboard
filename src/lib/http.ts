import { HttpError, ProviderError, errorMessage, safeHost, snippet } from './errors.ts';

export interface FetchJsonInit extends RequestInit {
  timeoutMs?: number;
}

export async function fetchJson(url: string, init: FetchJsonInit = {}): Promise<unknown> {
  const { timeoutMs = 20_000, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new ProviderError(`Network error reaching ${safeHost(url)}: ${errorMessage(e)}`, 'network', { cause: e });
  }
  const text = await res.text();
  if (!res.ok) throw new HttpError(res.status, text, url, parseRetryAfter(res.headers.get('retry-after')));
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError(`Unexpected non-JSON response from ${safeHost(url)}: ${snippet(text)}`, 'parse');
  }
}

function parseRetryAfter(v: string | null): number | undefined {
  if (!v) return undefined;
  const n = Number(v);
  if (Number.isFinite(n)) return n;
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, Math.round((t - Date.now()) / 1000)) : undefined;
}
