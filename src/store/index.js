import { config } from '../config.js';
import { createLowdbStore } from './lowdb.js';
import { createPgStore } from './postgres.js';

// Picks the storage driver:
//  - SUPABASE_DB_URL set -> Supabase Postgres — survives redeploys
//  - SUPABASE_DB_URL empty -> local lowdb JSON file (dev / fallback)
// After creation, if the model catalog is empty it is seeded from MODEL_MAP.
export async function createStore() {
  const store = config.supabaseDbUrl
    ? await createPgStore(config.supabaseDbUrl)
    : await createLowdbStore(config.dbPath);

  if ((await store.listModels()).length === 0) {
    for (const [id, value] of Object.entries(config.modelMap)) {
      await store.insertModel({
        id,
        upstreamId: typeof value === 'string' ? value : String(value?.upstream || id),
        label: value && typeof value === 'object' && value.label ? String(value.label) : id,
        enabled: true,
        systemPrompt: null,
        hideThinking: value && typeof value === 'object' && value.hideThinking === true,
        createdAt: new Date().toISOString(),
      });
    }
  }

  return store;
}
