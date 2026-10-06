// Smoke test for the Postgres store driver against an in-memory emulator (pg-mem).
// Run: npm run test:store
import assert from 'node:assert/strict';
import { newDb } from 'pg-mem';
import { createPgStore } from '../src/store/postgres.js';
import { createApiKey, createModel } from '../src/db.js';

const mem = newDb();
const { Pool } = mem.adapters.createPg();
const store = await createPgStore(new Pool());

assert.equal(store.driver, 'postgres');

// models
await store.insertModel(createModel({ id: 'kimi-k3', upstreamId: 'kimi-k3', label: 'Kimi K3' }));
await store.insertModel(createModel({ id: 'gpt-6-astra', upstreamId: 'kimi-k3', label: 'GPT 6 ASTRA' }));
let models = await store.listModels();
assert.equal(models.length, 2);
models = await store.updateModel('gpt-6-astra', { enabled: false });
const withPrompt = await store.updateModel('kimi-k3', { systemPrompt: 'persona text' });
assert.equal(withPrompt.systemPrompt, 'persona text');
assert.equal((await store.updateModel('kimi-k3', { systemPrompt: null })).systemPrompt, null);
assert.deepEqual(
  (await store.listModels()).filter((m) => m.enabled).map((m) => m.id),
  ['kimi-k3']
);

// keys + usage accounting
const key = createApiKey({ name: 'smoke', tokenLimit: 100 });
await store.insertKey(key);
let loaded = await store.findKeyBySecret(key.key);
assert.equal(loaded.name, 'smoke');
assert.equal(loaded.tokensUsed, 0);

loaded.lastUsedAt = new Date().toISOString();
await store.recordUsage(loaded.id, loaded, 'kimi-k3', 40);
loaded.lastUsedAt = new Date().toISOString();
await store.recordUsage(loaded.id, loaded, 'gpt-6-astra', 15);

let after = await store.getKey(key.id);
assert.equal(after.tokensUsed, 55);
assert.equal(after.requests, 2);
assert.deepEqual(after.modelsUsed, ['kimi-k3', 'gpt-6-astra']);

// quota/limit mutation must not clobber counters
after = await store.updateKey(key.id, { status: 'blocked', tokenLimit: 999 });
assert.equal(after.status, 'blocked');
assert.equal(after.tokenLimit, 999);
assert.equal(after.tokensUsed, 55);

// regeneration + usage reset
const regen = await store.updateKey(key.id, { tokensUsed: 0, key: 'astra-regenerated-secret' });
assert.equal(regen.tokensUsed, 0);
assert.equal(regen.key, 'astra-regenerated-secret');
assert.equal(await store.findKeyBySecret(key.key), null);
assert.ok(await store.findKeyBySecret('astra-regenerated-secret'));

// per-key model allowlist
const withAllow = await store.updateKey(key.id, { allowedModels: ['kimi-k3', 'gpt-6-astra'] });
assert.deepEqual(withAllow.allowedModels, ['kimi-k3', 'gpt-6-astra']);
const noAllow = await store.updateKey(key.id, { allowedModels: null });
assert.equal(noAllow.allowedModels, null);

// stats
const stats = await store.getStats();
assert.equal(stats.totalRequests, 2);
assert.equal(stats.totalTokens, 55);

// daily usage aggregation
const usage = await store.getUsage();
assert.equal(usage.length, 1);
assert.equal(usage[0].day, new Date().toISOString().slice(0, 10));
assert.equal(usage[0].requests, 2);
assert.equal(usage[0].tokens, 55);

// per-key request log
await store.logRequest({ keyId: 'k-log', model: 'kimi-k3', status: 200, tokens: 15, durationMs: 42, error: null });
await store.logRequest({ keyId: 'k-log', model: 'glm-5.2', status: 403, tokens: 0, durationMs: 3, error: 'model not allowed' });
const logs = await store.listRequests('k-log');
assert.equal(logs.length, 2);
assert.equal(logs[0].status, 403); // newest first
assert.equal(logs[1].tokens, 15);
assert.equal((await store.listRequests('missing')).length, 0);

// deletes
await store.deleteKey(key.id);
assert.equal(await store.getKey(key.id), null);
await store.deleteModel('gpt-6-astra');
assert.equal((await store.listModels()).length, 1);

console.log('pg store smoke: all assertions passed');
