import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { JSONFilePreset } from 'lowdb/node';

const clone = (x) => JSON.parse(JSON.stringify(x));

// Local JSON-file driver (dev fallback when SUPABASE_DB_URL is empty).
export async function createLowdbStore(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = await JSONFilePreset(dbPath, {
    keys: [],
    models: [],
    stats: { totalRequests: 0, totalTokens: 0, startedAt: new Date().toISOString() },
  });
  db.data.keys ||= [];
  db.data.models ||= [];
  db.data.usageDays ||= [];
  db.data.requestLog ||= [];
  db.data.stats ||= { totalRequests: 0, totalTokens: 0, startedAt: new Date().toISOString() };
  await db.write();

  const findKey = (id) => db.data.keys.find((k) => k.id === id);
  const findModel = (id) => db.data.models.find((m) => m.id === id);

  return {
    driver: 'lowdb',

    async listKeys() {
      return db.data.keys.map(clone);
    },
    async findKeyBySecret(secret) {
      const k = db.data.keys.find((x) => x.key === secret);
      return k ? clone(k) : null;
    },
    async getKey(id) {
      const k = findKey(id);
      return k ? clone(k) : null;
    },
    async insertKey(k) {
      db.data.keys.push(k);
      await db.write();
    },
    async updateKey(id, patch) {
      const k = findKey(id);
      if (!k) return null;
      Object.assign(k, patch);
      await db.write();
      return clone(k);
    },
    async deleteKey(id) {
      const i = db.data.keys.findIndex((k) => k.id === id);
      if (i === -1) return;
      db.data.keys.splice(i, 1);
      await db.write();
    },
    async recordUsage(id, current, model, tokens) {
      current.lastUsedAt = new Date().toISOString();
      const k = findKey(id);
      if (k) {
        k.tokensUsed += tokens;
        k.requests += 1;
        k.lastUsedAt = current.lastUsedAt;
        if (model && !k.modelsUsed.includes(model)) k.modelsUsed.push(model);
      }
      db.data.stats.totalRequests += 1;
      db.data.stats.totalTokens += tokens;
      const day = new Date().toISOString().slice(0, 10);
      const ud = db.data.usageDays.find((d) => d.day === day);
      if (ud) {
        ud.requests += 1;
        ud.tokens += tokens;
      } else {
        db.data.usageDays.push({ day, requests: 1, tokens });
      }
      await db.write();
      Object.assign(current, {
        tokensUsed: current.tokensUsed + tokens,
        requests: current.requests + 1,
      });
    },

    async listModels() {
      return db.data.models.map(clone);
    },
    async insertModel(m) {
      db.data.models.push(m);
      await db.write();
    },
    async updateModel(id, patch) {
      const m = findModel(id);
      if (!m) return null;
      Object.assign(m, patch);
      await db.write();
      return clone(m);
    },
    async deleteModel(id) {
      const i = db.data.models.findIndex((m) => m.id === id);
      if (i === -1) return;
      db.data.models.splice(i, 1);
      await db.write();
    },

    async getStats() {
      return clone(db.data.stats);
    },

    async getUsage() {
      return db.data.usageDays.slice().sort((a, b) => b.day.localeCompare(a.day)).slice(0, 14).map(clone);
    },

    // Per-key request log (kept for 7 days, capped to the latest 3000 rows).
    async logRequest(e) {
      db.data.requestLog.push({
        id: crypto.randomUUID(),
        keyId: e.keyId,
        at: new Date().toISOString(),
        model: e.model || null,
        status: Math.floor(e.status),
        tokens: Math.floor(e.tokens || 0),
        durationMs: Math.floor(e.durationMs || 0),
        error: e.error || null,
      });
      const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
      db.data.requestLog = db.data.requestLog
        .filter((r) => new Date(r.at).getTime() >= cutoff)
        .slice(-3000);
      await db.write();
    },

    async listRequests(keyId, limit = 50) {
      return db.data.requestLog
        .filter((r) => r.keyId === keyId)
        .sort((a, b) => b.at.localeCompare(a.at))
        .slice(0, limit)
        .map(clone);
    },
  };
}
