import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { App } from './app.ts';
import { PROVIDER_ORDER, type ProviderSnapshot, type Reading } from './types.ts';
import { renderCompact, renderSwiftbar, renderWaybar } from './render.ts';
import { creditKey } from './providers/gemini.ts';
import { isObj, num, str } from './lib/json.ts';
import { log } from './lib/log.ts';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json; charset=utf-8',
};
const MAX_BODY = 1_000_000;

class HttpFail extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function createHttpHandler(app: App) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true, version: app.config.version });
      if (url.pathname.startsWith('/api/')) return await handleApi(app, req, res, url);
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpFail(405, 'method not allowed');
      return await serveStatic(res, url.pathname);
    } catch (e) {
      if (e instanceof HttpFail) return sendJson(res, e.status, { error: e.message });
      log.error('Request error', req.method, url.pathname, e);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
    }
  };
}

async function handleApi(app: App, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  // The API is read by widgets and scripts from anywhere; auth is by token, so CORS can be open.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }
  if (!authorized(app, req)) throw new HttpFail(401, 'invalid or missing token');

  const route = `${req.method} ${url.pathname.replace(/\/+$/, '')}`;
  switch (route) {
    case 'GET /api/v1/status':
      return sendJson(res, 200, app.status());
    case 'GET /api/v1/compact':
      return sendJson(res, 200, renderCompact(app.status()));
    case 'GET /api/v1/waybar':
      return sendJson(res, 200, renderWaybar(app.status()));
    case 'GET /api/v1/swiftbar': {
      const base = app.config.publicUrl ?? requestOrigin(req);
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(renderSwiftbar(app.status(), `${base}/`));
      return;
    }
    case 'POST /api/v1/refresh':
      await app.collector.refreshAll(true);
      return sendJson(res, 200, app.status());
    case 'POST /api/v1/ingest': {
      const body = await readJsonBody(req);
      const list = isObj(body) && Array.isArray(body.snapshots) ? body.snapshots : null;
      if (!list) throw new HttpFail(400, 'expected { "snapshots": [...] }');
      const snapshots = list.map(validateSnapshot);
      app.collector.ingest(snapshots);
      await app.store.save();
      log.info(`Received pushed data: ${snapshots.map((s) => s.provider).join(', ')}`);
      return sendJson(res, 200, app.status());
    }
    case 'PUT /api/v1/manual/gemini':
    case 'POST /api/v1/manual/gemini': {
      if (app.config.gemini.bigquery) throw new HttpFail(409, 'Gemini reads from BigQuery; manual values are not used');
      const body = await readJsonBody(req);
      const used = isObj(body) ? num(body.used) : null;
      if (used == null || used < 0) throw new HttpFail(400, 'expected { "used": <number ≥ 0> }');
      app.store.state.manual.gemini = { used, updatedAt: new Date().toISOString(), key: creditKey(app.config.gemini) };
      await app.collector.refreshProvider('gemini');
      return sendJson(res, 200, app.status());
    }
    default:
      throw new HttpFail(404, 'route not found');
  }
}

function authorized(app: App, req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  // Header only: a token in a URL ends up in logs, history and Referer headers.
  const provided = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : null;
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(app.apiToken);
  return a.length === b.length && timingSafeEqual(a, b);
}

function requestOrigin(req: IncomingMessage): string {
  const proto = String(req.headers['x-forwarded-proto'] ?? 'http').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost').split(',')[0].trim();
  return `${proto}://${host}`;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpFail(413, 'body too large');
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
  } catch {
    throw new HttpFail(400, 'invalid JSON');
  }
}

/** Snapshots pushed from outside are untrusted: rebuild them field by field. */
function validateSnapshot(raw: unknown): ProviderSnapshot {
  if (!isObj(raw)) throw new HttpFail(400, 'invalid snapshot');
  const provider = PROVIDER_ORDER.find((p) => p === raw.provider);
  if (!provider) throw new HttpFail(400, `unknown provider: ${String(raw.provider)}`);
  const fetchedAt = str(raw.fetchedAt);
  if (!fetchedAt || !Number.isFinite(Date.parse(fetchedAt))) throw new HttpFail(400, 'invalid fetchedAt');
  if (!Array.isArray(raw.readings)) throw new HttpFail(400, 'missing readings');
  const role = (v: unknown) => (['session', 'week', 'credits', 'other'].includes(String(v)) ? (v as Reading['role']) : 'other');
  const readings: Reading[] = raw.readings.slice(0, 20).map((r): Reading => {
    if (!isObj(r)) throw new HttpFail(400, 'invalid reading');
    const base = { id: (str(r.id) ?? 'x').slice(0, 64), label: (str(r.label) ?? '').slice(0, 64), role: role(r.role) };
    if (r.kind === 'budget') {
      const used = num(r.used);
      const total = num(r.total);
      if (used == null || total == null || !str(r.periodStart) || !str(r.periodEnd)) throw new HttpFail(400, 'invalid budget');
      return {
        kind: 'budget',
        ...base,
        used,
        total,
        currency: (str(r.currency) ?? 'USD').slice(0, 8),
        periodStart: str(r.periodStart)!,
        periodEnd: str(r.periodEnd)!,
        dataAsOf: str(r.dataAsOf),
      };
    }
    const windowSeconds = num(r.windowSeconds);
    if (!windowSeconds || windowSeconds <= 0) throw new HttpFail(400, 'invalid windowSeconds');
    return { kind: 'window', ...base, usedPct: num(r.usedPct), resetsAt: str(r.resetsAt), windowSeconds };
  });
  const extras = Array.isArray(raw.extras)
    ? raw.extras.slice(0, 10).filter(isObj).map((x) => ({
        id: (str(x.id) ?? 'x').slice(0, 64),
        label: (str(x.label) ?? '').slice(0, 64),
        value: (str(x.value) ?? '').slice(0, 200),
        tone: (['neutral', 'good', 'warn', 'bad'].includes(String(x.tone)) ? x.tone : 'neutral') as 'neutral',
      }))
    : [];
  return { provider, fetchedAt, source: (str(raw.source) ?? 'push').slice(0, 64), plan: str(raw.plan)?.slice(0, 64) ?? null, readings, extras };
}

async function serveStatic(res: ServerResponse, pathname: string): Promise<void> {
  let rel: string;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    throw new HttpFail(400, 'invalid path');
  }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.resolve(PUBLIC_DIR, `.${path.posix.normalize(rel)}`);
  if (!file.startsWith(PUBLIC_DIR)) throw new HttpFail(404, 'not found');
  let body: Buffer;
  try {
    body = await readFile(file);
  } catch {
    throw new HttpFail(404, 'not found');
  }
  const ext = path.extname(file);
  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}
