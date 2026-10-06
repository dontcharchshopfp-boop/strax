import { isExpired } from './db.js';

// Authenticates a client by `Authorization: Bearer astra-...` or `x-api-key`
// (the latter is what Anthropic-compatible clients such as Claude Code send).
export function clientAuth(store) {
  return async (req, res, next) => {
    let key = null;
    try {
      const header = req.headers.authorization || '';
      let token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
      if (!token && req.headers['x-api-key']) token = String(req.headers['x-api-key']).trim();
      if (token) key = await store.findKeyBySecret(token);
    } catch (err) {
      return next(err);
    }
    if (!key) {
      return res.status(401).json({ error: { message: 'Invalid or missing API key', type: 'invalid_api_key' } });
    }
    req.clientKey = key;
    next();
  };
}

// Checks that the key is allowed to spend tokens right now.
// Rejected attempts are written to the per-key request log.
export function checkUsable(store) {
  const logRejection = (key, req, status, error) =>
    store
      .logRequest({
        keyId: key.id,
        model: typeof req.body?.model === 'string' ? req.body.model : null,
        status,
        tokens: 0,
        durationMs: 0,
        error,
      })
      .catch(() => {});

  return async (req, res, next) => {
    const k = req.clientKey;
    if (k.status === 'blocked') {
      await logRejection(k, req, 403, 'key blocked');
      return res.status(403).json({ error: { message: 'This API key has been blocked', type: 'key_blocked' } });
    }
    if (isExpired(k)) {
      await logRejection(k, req, 403, 'key expired');
      return res.status(403).json({ error: { message: 'This API key has expired', type: 'key_expired' } });
    }
    if (k.tokensUsed >= k.tokenLimit) {
      await logRejection(k, req, 429, 'quota exceeded');
      return res.status(429).json({
        error: { message: 'Token quota exceeded. Top up your balance to continue.', type: 'insufficient_quota' },
      });
    }
    next();
  };
}
