import { createServer } from 'node:http';
import { hostname } from 'node:os';
import { loadConfig } from './config.ts';
import { createApp } from './app.ts';
import { createHttpHandler } from './http.ts';
import { log } from './lib/log.ts';

const config = loadConfig();
const app = await createApp(config);
const server = createServer(createHttpHandler(app));

server.listen(config.port, config.host, () => {
  log.info(`AI Pace ${config.version} listening on http://${config.host}:${config.port} (refreshing every ${config.refreshMinutes} min)`);
  for (const p of app.providers) {
    log.info(`  ${p.enabled ? '✓' : '·'} ${p.name}: ${p.enabled ? p.describe() : 'not configured'}`);
  }
  const where = app.apiTokenGenerated ? `generated and saved in ${app.store.file}` : 'set via API_TOKEN';
  log.info(`Dashboard: ${config.publicUrl ?? `http://${hostname()}:${config.port}`}/  (token ${where}; show it with "npm run token")`);
});

app.collector.start(config.refreshMinutes);

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log.info(`${signal} received, shutting down…`);
  app.collector.stop();
  server.close();
  await app.store.save();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
