import { ProviderError } from './errors.ts';
import { fetchJson } from './http.ts';
import { isObj, num, str } from './json.ts';
import { signJwtRs256 } from './jwt.ts';

export interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
  project_id?: string;
}

export function parseServiceAccount(raw: string): ServiceAccount {
  let text = raw.trim();
  // Accept the JSON key as-is or base64-encoded (handy for env vars).
  if (!text.startsWith('{')) text = Buffer.from(text, 'base64').toString('utf8');
  const v: unknown = JSON.parse(text);
  if (!isObj(v) || !str(v.client_email) || !str(v.private_key)) {
    throw new Error('the service account key must contain client_email and private_key');
  }
  return {
    client_email: str(v.client_email)!,
    private_key: str(v.private_key)!,
    token_uri: str(v.token_uri) ?? undefined,
    project_id: str(v.project_id) ?? undefined,
  };
}

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

/** OAuth2 JWT-bearer flow for a service account (no google-auth-library needed). */
export async function getServiceAccountToken(sa: ServiceAccount, scope: string, tokenUrlOverride?: string | null): Promise<string> {
  const key = `${sa.client_email}|${scope}`;
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;

  const tokenUrl = tokenUrlOverride ?? sa.token_uri ?? 'https://oauth2.googleapis.com/token';
  const now = Math.floor(Date.now() / 1000);
  let assertion: string;
  try {
    assertion = signJwtRs256({ iss: sa.client_email, scope, aud: tokenUrl, iat: now, exp: now + 3600 }, sa.private_key);
  } catch (e) {
    throw new ProviderError(`Invalid service account private key: ${(e as Error).message}`, 'not_configured');
  }
  const res = await fetchJson(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
  });
  const token = isObj(res) ? str(res.access_token) : null;
  if (!token) throw new ProviderError('Google returned no access_token for the service account.', 'auth');
  tokenCache.set(key, { token, expiresAt: Date.now() + (num(isObj(res) ? res.expires_in : null) ?? 3600) * 1000 });
  return token;
}
