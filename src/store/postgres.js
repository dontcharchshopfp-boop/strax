import crypto from 'node:crypto';
import pg from 'pg';

// Relational schema. Counters (tokens_used/requests/total_*) are incremented
// atomically in SQL so parallel requests never lose usage.
const DDL = [
  `CREATE TABLE IF NOT EXISTS api_keys (
     id TEXT PRIMARY KEY,
     key_secret TEXT UNIQUE NOT NULL,
     name TEXT NOT NULL,
     status TEXT NOT NULL,
     token_limit BIGINT NOT NULL,
     tokens_used BIGINT NOT NULL DEFAULT 0,
     requests BIGINT NOT NULL DEFAULT 0,
     models_used TEXT NOT NULL DEFAULT '',
     allowed_models TEXT,
     created_at TEXT NOT NULL,
     expires_at TEXT,
     last_used_at TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS models (
     id TEXT PRIMARY KEY,
     upstream_id TEXT NOT NULL,
     label TEXT NOT NULL,
     enabled BOOLEAN NOT NULL DEFAULT true,
     system_prompt TEXT,
     hide_thinking BOOLEAN NOT NULL DEFAULT false,
     response_delay_ms INTEGER NOT NULL DEFAULT 0,
     supports_vision BOOLEAN NOT NULL DEFAULT false,
     ensemble_enabled BOOLEAN NOT NULL DEFAULT false,
     ensemble_members TEXT,
     ensemble_strategy TEXT,
     created_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS meta (
     k TEXT PRIMARY KEY,
     total_requests BIGINT NOT NULL DEFAULT 0,
     total_tokens BIGINT NOT NULL DEFAULT 0,
     started_at TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS usage_days (
     day TEXT PRIMARY KEY,
     requests BIGINT NOT NULL DEFAULT 0,
     tokens BIGINT NOT NULL DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS request_log (
     id TEXT PRIMARY KEY,
     key_id TEXT NOT NULL,
     at TEXT NOT NULL,
     model TEXT,
     status INTEGER NOT NULL,
     tokens BIGINT NOT NULL DEFAULT 0,
     duration_ms INTEGER NOT NULL DEFAULT 0,
     error TEXT
   )`,
];

function mapKey(r) {
  return {
    id: r.id,
    key: r.key_secret,
    name: r.name,
    status: r.status,
    tokenLimit: Number(r.token_limit),
    tokensUsed: Number(r.tokens_used),
    requests: Number(r.requests),
    modelsUsed: r.models_used ? r.models_used.split('|') : [],
    allowedModels: r.allowed_models == null ? null : r.allowed_models.split('|'),
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    lastUsedAt: r.last_used_at,
  };
}

function mapModel(r) {
  return {
    id: r.id,
    upstreamId: r.upstream_id,
    label: r.label,
    enabled: Boolean(r.enabled),
    systemPrompt: r.system_prompt ?? null,
    hideThinking: Boolean(r.hide_thinking),
    responseDelayMs: Number(r.response_delay_ms) || 0,
    supportsVision: Boolean(r.supports_vision),
    ensembleEnabled: Boolean(r.ensemble_enabled),
    ensembleMembers: r.ensemble_members ? r.ensemble_members.split('|').filter(Boolean) : [],
    ensembleStrategy: r.ensemble_strategy || 'race',
    createdAt: r.created_at,
  };
}

// Accepts a connection string (production) or an existing pg-compatible pool (tests).
export async function createPgStore(target) {
  const pool =
    typeof target === 'string'
      ? new pg.Pool({
          connectionString: target,
          ssl: { rejectUnauthorized: false },
        })
      : target;

  for (const sql of DDL) await pool.query(sql);
  // Migrate tables created before these columns existed (no-op on a fresh DB).
  try {
    await pool.query('ALTER TABLE models ADD COLUMN system_prompt TEXT');
  } catch {
    /* column already present */
  }
  try {
    await pool.query('ALTER TABLE api_keys ADD COLUMN allowed_models TEXT');
  } catch {
    /* column already present */
  }
  try {
    await pool.query('ALTER TABLE models ADD COLUMN hide_thinking BOOLEAN NOT NULL DEFAULT false');
  } catch {
    /* column already present */
  }
  try {
    await pool.query('ALTER TABLE models ADD COLUMN response_delay_ms INTEGER NOT NULL DEFAULT 0');
  } catch {
    /* column already present */
  }
  try {
    await pool.query('ALTER TABLE models ADD COLUMN IF NOT EXISTS ensemble_enabled BOOLEAN NOT NULL DEFAULT false');
  } catch {
    /* column already present */
  }
  try {
    await pool.query('ALTER TABLE models ADD COLUMN IF NOT EXISTS ensemble_members TEXT');
  } catch {
    /* column already present */
  }
  try {
    await pool.query('ALTER TABLE models ADD COLUMN IF NOT EXISTS ensemble_strategy TEXT');
  } catch {
    /* column already present */
  }
  try {
    await pool.query('ALTER TABLE models ADD COLUMN IF NOT EXISTS supports_vision BOOLEAN NOT NULL DEFAULT false');
  } catch {
    /* column already present */
  }
  await pool.query(
    `INSERT INTO meta (k, total_requests, total_tokens, started_at) VALUES ('stats', 0, 0, $1) ON CONFLICT (k) DO NOTHING`,
    [new Date().toISOString()]
  );

  async function getKey(id) {
    const { rows } = await pool.query('SELECT * FROM api_keys WHERE id = $1', [id]);
    return rows[0] ? mapKey(rows[0]) : null;
  }

  async function getModel(id) {
    const { rows } = await pool.query('SELECT * FROM models WHERE id = $1', [id]);
    return rows[0] ? mapModel(rows[0]) : null;
  }

  return {
    driver: 'postgres',

    async listKeys() {
      const { rows } = await pool.query('SELECT * FROM api_keys');
      return rows.map(mapKey);
    },
    async findKeyBySecret(secret) {
      const { rows } = await pool.query('SELECT * FROM api_keys WHERE key_secret = $1', [secret]);
      return rows[0] ? mapKey(rows[0]) : null;
    },
    getKey,
    async insertKey(k) {
      await pool.query(
        `INSERT INTO api_keys (id, key_secret, name, status, token_limit, tokens_used, requests, models_used, allowed_models, created_at, expires_at, last_used_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          k.id, k.key, k.name, k.status, k.tokenLimit, k.tokensUsed, k.requests,
          k.modelsUsed.join('|'), k.allowedModels == null ? null : k.allowedModels.join('|'),
          k.createdAt, k.expiresAt, k.lastUsedAt,
        ]
      );
    },
    async updateKey(id, patch) {
      const cur = await getKey(id);
      if (!cur) return null;
      const m = { ...cur, ...patch };
      await pool.query(
        `UPDATE api_keys SET name = $1, status = $2, token_limit = $3, expires_at = $4,
           tokens_used = $5, requests = $6, models_used = $7, last_used_at = $8, key_secret = $9, allowed_models = $10
         WHERE id = $11`,
        [
          m.name, m.status, m.tokenLimit, m.expiresAt,
          m.tokensUsed, m.requests, m.modelsUsed.join('|'), m.lastUsedAt, m.key,
          m.allowedModels == null ? null : (m.allowedModels || []).join('|'),
          id,
        ]
      );
      return getKey(id);
    },
    async deleteKey(id) {
      await pool.query('DELETE FROM api_keys WHERE id = $1', [id]);
    },
    async recordUsage(id, current, model, tokens) {
      current.lastUsedAt = new Date().toISOString();
      const modelsUsed = Array.from(new Set([...current.modelsUsed, ...(model ? [model] : [])]));
      await pool.query(
        `UPDATE api_keys SET tokens_used = tokens_used + $1, requests = requests + 1, models_used = $2, last_used_at = $3 WHERE id = $4`,
        [tokens, modelsUsed.join('|'), current.lastUsedAt, id]
      );
      await pool.query(
        `UPDATE meta SET total_requests = total_requests + 1, total_tokens = total_tokens + $1 WHERE k = 'stats'`,
        [tokens]
      );
      const day = new Date().toISOString().slice(0, 10);
      await pool.query(
        `INSERT INTO usage_days (day, requests, tokens) VALUES ($1, 1, $2)
         ON CONFLICT (day) DO UPDATE SET requests = usage_days.requests + 1, tokens = usage_days.tokens + $2`,
        [day, tokens]
      );
      Object.assign(current, {
        tokensUsed: current.tokensUsed + tokens,
        requests: current.requests + 1,
        modelsUsed,
      });
    },

    async listModels() {
      const { rows } = await pool.query('SELECT * FROM models');
      return rows.map(mapModel);
    },
    async insertModel(m) {
      await pool.query(
        `INSERT INTO models (id, upstream_id, label, enabled, system_prompt, hide_thinking, response_delay_ms, supports_vision, ensemble_enabled, ensemble_members, ensemble_strategy, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          m.id, m.upstreamId, m.label, m.enabled, m.systemPrompt ?? null, m.hideThinking === true,
          m.responseDelayMs || 0, m.supportsVision === true, m.ensembleEnabled === true,
          Array.isArray(m.ensembleMembers) ? m.ensembleMembers.join('|') : null,
          m.ensembleStrategy || 'race', m.createdAt,
        ]
      );
    },
    async updateModel(id, patch) {
      const cur = await getModel(id);
      if (!cur) return null;
      const m = { ...cur, ...patch };
      await pool.query(
        `UPDATE models SET upstream_id = $1, label = $2, enabled = $3, system_prompt = $4, hide_thinking = $5,
           response_delay_ms = $6, supports_vision = $7, ensemble_enabled = $8, ensemble_members = $9, ensemble_strategy = $10
         WHERE id = $11`,
        [
          m.upstreamId, m.label, m.enabled, m.systemPrompt ?? null, m.hideThinking === true,
          m.responseDelayMs || 0, m.supportsVision === true, m.ensembleEnabled === true,
          Array.isArray(m.ensembleMembers) ? m.ensembleMembers.join('|') : null,
          m.ensembleStrategy || 'race', id,
        ]
      );
      return getModel(id);
    },
    async deleteModel(id) {
      await pool.query('DELETE FROM models WHERE id = $1', [id]);
    },

    async getStats() {
      const { rows } = await pool.query(`SELECT * FROM meta WHERE k = 'stats'`);
      const r = rows[0];
      return { totalRequests: Number(r.total_requests), totalTokens: Number(r.total_tokens), startedAt: r.started_at };
    },

    async getUsage() {
      const { rows } = await pool.query(`SELECT * FROM usage_days ORDER BY day DESC LIMIT 14`);
      return rows.map((r) => ({ day: r.day, requests: Number(r.requests), tokens: Number(r.tokens) }));
    },

    // Per-key request log (best effort, pruned after 7 days).
    async logRequest(e) {
      await pool.query(
        `INSERT INTO request_log (id, key_id, at, model, status, tokens, duration_ms, error)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          crypto.randomUUID(),
          e.keyId,
          new Date().toISOString(),
          e.model || null,
          Math.floor(e.status),
          Math.floor(e.tokens || 0),
          Math.floor(e.durationMs || 0),
          e.error || null,
        ]
      );
      const cutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
      await pool.query('DELETE FROM request_log WHERE at < $1', [cutoff]);
    },

    async listRequests(keyId, limit = 50) {
      const { rows } = await pool.query(
        'SELECT * FROM request_log WHERE key_id = $1 ORDER BY at DESC LIMIT $2',
        [keyId, limit]
      );
      return rows.map((r) => ({
        id: r.id,
        at: r.at,
        model: r.model,
        status: Number(r.status),
        tokens: Number(r.tokens),
        durationMs: Number(r.duration_ms),
        error: r.error,
      }));
    },
  };
}
