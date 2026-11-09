export type ErrorCode = 'not_configured' | 'auth' | 'expired' | 'http' | 'rate_limited' | 'blocked' | 'network' | 'parse';

/** An error with a message meant for humans, shown on the dashboard. Never contains secrets. */
export class ProviderError extends Error {
  code: ErrorCode;
  retryAfterSec: number | undefined;

  constructor(message: string, code: ErrorCode, opts: { cause?: unknown; retryAfterSec?: number } = {}) {
    super(message, { cause: opts.cause });
    this.name = 'ProviderError';
    this.code = code;
    this.retryAfterSec = opts.retryAfterSec;
  }
}

export class HttpError extends Error {
  status: number;
  body: string;
  url: string;
  retryAfterSec: number | undefined;

  constructor(status: number, body: string, url: string, retryAfterSec?: number) {
    super(`HTTP ${status} from ${safeHost(url)}`);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
    this.url = url;
    this.retryAfterSec = retryAfterSec;
  }

  looksLikeHtml(): boolean {
    return /^\s*</.test(this.body);
  }
}

export function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'server';
  }
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/** Short, single-line, length-limited excerpt of a response body for error messages. */
export function snippet(text: string, max = 160): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/** Turn any failure into a ProviderError with an actionable message. */
export function toProviderError(e: unknown, providerName: string, authHint: string): ProviderError {
  if (e instanceof ProviderError) return e;
  if (e instanceof HttpError) {
    if (e.status === 429) {
      return new ProviderError(`${providerName}: too many requests (HTTP 429), will retry later.`, 'rate_limited', {
        cause: e,
        retryAfterSec: e.retryAfterSec,
      });
    }
    if (e.looksLikeHtml() && (e.status === 403 || e.status === 503)) {
      return new ProviderError(
        `${providerName}: request blocked by the provider's firewall (HTTP ${e.status}). This happens with datacenter IPs; run the server on a home network (e.g. a Raspberry Pi) or use push mode (npm run push).`,
        'blocked',
        { cause: e },
      );
    }
    if (e.status === 401 || e.status === 403) {
      return new ProviderError(`${providerName}: access denied (HTTP ${e.status}). ${authHint} Details: ${snippet(e.body)}`, 'auth', { cause: e });
    }
    return new ProviderError(`${providerName}: HTTP error ${e.status}. ${snippet(e.body)}`, 'http', { cause: e });
  }
  return new ProviderError(`${providerName}: ${errorMessage(e)}`, 'network', { cause: e });
}
