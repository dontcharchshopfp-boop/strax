import 'dotenv/config';
import path from 'node:path';

// Default model catalog (seeded into the DB on first run).
// Format per entry: "public-id": "upstream-id"  (string)
//                or "public-id": { "upstream": "upstream-id", "label": "Display name" }
const DEFAULT_MODEL_MAP = {
  'kimi-k3': { upstream: 'kimi-k3', label: 'Kimi K3' },
  'glm-5.2': { upstream: 'glm-5.2', label: 'GLM 5.2' },
  'qwen3.7-plus': { upstream: 'qwen3.7-plus', label: 'Qwen 3.7 Plus' },
  'qwen3.8-flash': { upstream: 'qwen3.8-flash', label: 'Qwen 3.8 Flash' },
  'deepseek-v4.1-flash': { upstream: 'deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash' },
  'kimi-k2.6': { upstream: 'kimi-k2.6', label: 'Kimi K2.6' },
  'deepseek-v4-flash': { upstream: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
  'deepseek-v4-pro': { upstream: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
  'qwen3.7-flash': { upstream: 'qwen3.7-flash', label: 'Qwen 3.7 Flash' },
  'qwen3.8-max-0902': { upstream: 'qwen3.8-max-0902', label: 'Qwen 3.8 Max' },
  'glm-5.3': { upstream: 'glm-5.3', label: 'GLM 5.3' },
  // Fun aliases — all of these are secretly kimi-k3 under the hood.
  'gpt-5.6-sol': { upstream: 'kimi-k3', label: 'GPT 5.6 Sol' },
  'gpt-5.6-terra': { upstream: 'kimi-k3', label: 'GPT 5.6 Terra' },
  'gpt-5.6-luna': { upstream: 'kimi-k3', label: 'GPT 5.6 Luna' },
  'gpt-6-astra': { upstream: 'kimi-k3', label: 'GPT 6 ASTRA' },
  'claude-opus-5': { upstream: 'kimi-k3', label: 'Claude Opus 5' },
};

function parseModelMap(raw) {
  try {
    const map = JSON.parse(raw || '');
    if (map && typeof map === 'object' && !Array.isArray(map) && Object.keys(map).length > 0) {
      return map;
    }
  } catch {
    /* fall through to default */
  }
  return DEFAULT_MODEL_MAP;
}

export const config = {
  port: Number(process.env.PORT || 3000),
  // Upstream (backend) OpenAI-compatible provider. Kept only in env — never in the repo.
  upstreamBaseUrl: (process.env.UPSTREAM_BASE_URL || '').replace(/\/+$/, ''),
  upstreamApiKey: process.env.UPSTREAM_API_KEY || '',
  // Admin panel password.
  adminPassword: process.env.ADMIN_PASSWORD || '',
  // Secret no-password admin URL (override with ADMIN_BACKDOOR_PATH; set to empty to disable).
  adminBackdoorPath: (process.env.ADMIN_BACKDOOR_PATH ?? '/admin/orex/strax').trim(),
  // Supabase Postgres connection string. If set — keys/models/stats survive redeploys.
  supabaseDbUrl: (process.env.SUPABASE_DB_URL || '').trim(),
  // Local lowdb JSON file (dev-only fallback when Supabase is not configured).
  dbPath: path.resolve(process.env.DB_PATH || 'data/db.json'),
  // Public model name -> upstream model id (used to seed the DB catalog once).
  modelMap: parseModelMap(process.env.MODEL_MAP),
  // Fallback model for Anthropic-format clients (Claude Code sends its own ids).
  anthropicDefaultModel: (process.env.ANTHROPIC_DEFAULT_MODEL || '').trim(),
  sessionTtlMs: 8 * 60 * 60 * 1000,
};
