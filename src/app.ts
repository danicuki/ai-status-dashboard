import { randomBytes } from 'node:crypto';
import type { AppConfig } from './config.ts';
import type { StatusResponse } from './types.ts';
import { Store } from './store.ts';
import { Collector } from './collector.ts';
import { buildStatus } from './status.ts';
import type { Provider } from './providers/provider.ts';
import { createClaudeProvider } from './providers/claude.ts';
import { createOpenAIProvider } from './providers/openai.ts';
import { createGeminiProvider } from './providers/gemini.ts';
import { setLocale } from './format.ts';

export interface App {
  config: AppConfig;
  store: Store;
  providers: Provider[];
  collector: Collector;
  apiToken: string;
  /** true when the token was generated (not set via API_TOKEN). */
  apiTokenGenerated: boolean;
  status(now?: number): StatusResponse;
}

export async function createApp(config: AppConfig): Promise<App> {
  setLocale(config.locale);
  const store = new Store(config.dataDir);
  await store.load();

  const providers: Provider[] = [
    createClaudeProvider(config.claude),
    createOpenAIProvider(config.openai),
    createGeminiProvider(config.gemini, {
      getManual: () => store.state.manual.gemini,
      getBudgets: () => store.state.budgets ?? {},
      setBudget: (n) => {
        (store.state.budgets ??= {})[n.name] = n;
      },
    }),
  ];

  let apiToken = config.apiToken;
  const apiTokenGenerated = !apiToken;
  if (!apiToken) {
    apiToken = store.state.apiToken ?? randomBytes(18).toString('base64url');
    if (store.state.apiToken !== apiToken) {
      store.state.apiToken = apiToken;
      await store.save();
    }
  }

  return {
    config,
    store,
    providers,
    collector: new Collector(providers, store),
    apiToken,
    apiTokenGenerated,
    status: (now?: number) => buildStatus(providers, store.state, config, now),
  };
}
