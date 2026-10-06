import crypto from 'node:crypto';

// Pure entity helpers. Persistence lives in src/store/*.

export function createApiKey({ name, tokenLimit, expiresAt }) {
  const limit = Number(tokenLimit);
  return {
    id: crypto.randomUUID(),
    key: 'astra-' + crypto.randomBytes(24).toString('hex'),
    name: (name || 'Untitled key').slice(0, 80),
    status: 'active', // active | blocked
    tokenLimit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 100000,
    tokensUsed: 0,
    requests: 0,
    modelsUsed: [],
    // null = all enabled models are allowed; array = only these model ids
    allowedModels: null,
    createdAt: new Date().toISOString(),
    expiresAt: expiresAt || null,
    lastUsedAt: null,
  };
}

export function createModel({ id, upstreamId, label, systemPrompt, hideThinking, responseDelayMs, supportsVision, ensembleEnabled, ensembleMembers, ensembleStrategy }) {
  const publicId = String(id || '').trim();
  const delay = Number(responseDelayMs);
  return {
    id: publicId,
    upstreamId: String(upstreamId || publicId).trim(),
    label: String(label || publicId).trim().slice(0, 80),
    enabled: true,
    systemPrompt: systemPrompt ? String(systemPrompt) : null,
    hideThinking: Boolean(hideThinking),
    responseDelayMs: Number.isFinite(delay) && delay > 0 ? Math.min(60000, Math.floor(delay)) : 0,
    // Vision: this model's upstream accepts image input. Requests with images
    // that target a non-vision model are rerouted to a vision-capable one.
    supportsVision: Boolean(supportsVision),
    // Ensemble: combine several models behind one public id.
    ensembleEnabled: Boolean(ensembleEnabled),
    ensembleMembers: Array.isArray(ensembleMembers)
      ? [...new Set(ensembleMembers.map((m) => String(m).trim()).filter(Boolean))].slice(0, 4)
      : [],
    ensembleStrategy: ensembleStrategy === 'best' ? 'best' : 'race',
    createdAt: new Date().toISOString(),
  };
}

export function isExpired(key) {
  return Boolean(key.expiresAt) && Date.now() > new Date(key.expiresAt).getTime();
}

// Safe public view of a key (returned to the key owner on /v1/key/info).
export function keyInfo(k) {
  const expired = isExpired(k);
  return {
    name: k.name,
    status: k.status === 'active' && expired ? 'expired' : k.status,
    tokenLimit: k.tokenLimit,
    tokensUsed: k.tokensUsed,
    tokensRemaining: Math.max(0, k.tokenLimit - k.tokensUsed),
    requests: k.requests,
    modelsUsed: k.modelsUsed,
    allowedModels: k.allowedModels ?? null,
    createdAt: k.createdAt,
    expiresAt: k.expiresAt,
    lastUsedAt: k.lastUsedAt,
  };
}
