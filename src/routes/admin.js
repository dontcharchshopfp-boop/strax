import { Router } from 'express';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { createApiKey, createModel, keyInfo, isExpired } from '../db.js';
import { login, logout, adminAuth } from '../adminAuth.js';
import { fetchUpstreamChat, pipeOpenAIStream, resolveEnsembleMembers, runEnsemble } from '../upstream.js';
import { stripThinkingFromResponse } from '../thinking.js';
import { estimateTokens } from '../usage.js';

export function createAdminRouter(store) {
  const router = Router();

  router.post('/login', (req, res) => {
    if (!config.adminPassword) {
      return res.status(503).json({ error: { message: 'Admin password is not configured on the server' } });
    }
    const { password } = req.body || {};
    if (!login(res, String(password || '').trim())) {
      return res.status(401).json({ error: { message: 'Wrong password' } });
    }
    res.json({ ok: true });
  });

  router.post('/logout', (req, res) => {
    logout(req, res);
    res.json({ ok: true });
  });

  // Everything below requires an admin session.
  router.use(adminAuth);

  router.get('/stats', async (req, res) => {
    const [stats, keys, models] = await Promise.all([store.getStats(), store.listKeys(), store.listModels()]);
    res.json({
      status: 'operational',
      uptimeSec: Math.floor(process.uptime()),
      startedAt: stats.startedAt,
      totalKeys: keys.length,
      activeKeys: keys.filter((k) => k.status === 'active' && !isExpired(k)).length,
      blockedKeys: keys.filter((k) => k.status === 'blocked').length,
      totalRequests: stats.totalRequests,
      totalTokens: stats.totalTokens,
      models: models.filter((m) => m.enabled).map((m) => m.id),
    });
  });

  router.get('/usage', async (req, res) => {
    res.json({ usage: await store.getUsage() });
  });

    // ── Client keys ────────────────────────────────────────

  router.get('/keys', async (req, res) => {
    const keys = (await store.listKeys())
      .map((k) => ({ id: k.id, key: k.key, ...keyInfo(k) }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    res.json({ keys });
  });

  router.post('/keys', async (req, res) => {
    const { name, tokenLimit, expiresAt } = req.body || {};

    let expiresIso = null;
    if (expiresAt) {
      const t = new Date(expiresAt);
      if (Number.isNaN(t.getTime())) {
        return res.status(400).json({ error: { message: 'Invalid expiresAt date' } });
      }
      expiresIso = t.toISOString();
    }

    const key = createApiKey({ name: String(name || ''), tokenLimit: Number(tokenLimit), expiresAt: expiresIso });
    await store.insertKey(key);
    res.status(201).json({ id: key.id, key: key.key, ...keyInfo(key) });
  });

  // Bulk key generation: N keys with the same quota, copyable in one click.
  router.post('/keys/bulk', async (req, res) => {
    const { count, tokenLimit, namePrefix, expiresAt } = req.body || {};
    const n = Number(count);
    if (!Number.isInteger(n) || n < 1 || n > 100) {
      return res.status(400).json({ error: { message: 'count must be an integer between 1 and 100' } });
    }

    let expiresIso = null;
    if (expiresAt) {
      const t = new Date(expiresAt);
      if (Number.isNaN(t.getTime())) {
        return res.status(400).json({ error: { message: 'Invalid expiresAt date' } });
      }
      expiresIso = t.toISOString();
    }

    const prefix = String(namePrefix || '').trim().slice(0, 40) || 'key';
    const created = [];
    for (let i = 0; i < n; i++) {
      const key = createApiKey({
        name: `${prefix}-${String(i + 1).padStart(2, '0')}`,
        tokenLimit: Number(tokenLimit),
        expiresAt: expiresIso,
      });
      await store.insertKey(key);
      created.push({ id: key.id, key: key.key, name: key.name, tokenLimit: key.tokenLimit });
    }
    res.status(201).json({ keys: created });
  });

  // Bulk operations on existing keys: block / unblock / reset-usage / delete.
  router.post('/keys/bulk-ops', async (req, res) => {
    const { ids, op } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 500) {
      return res.status(400).json({ error: { message: 'ids must be a non-empty array of key ids (max 500)' } });
    }
    if (!['block', 'unblock', 'reset-usage', 'delete'].includes(op)) {
      return res.status(400).json({ error: { message: 'op must be "block", "unblock", "reset-usage" or "delete"' } });
    }
    const patch =
      op === 'block' ? { status: 'blocked' } :
      op === 'unblock' ? { status: 'active' } :
      op === 'reset-usage' ? { tokensUsed: 0 } :
      null;
    let affected = 0;
    for (const id of ids) {
      const existing = await store.getKey(String(id));
      if (!existing) continue;
      if (patch) await store.updateKey(String(id), patch);
      else await store.deleteKey(String(id));
      affected++;
    }
    res.json({ ok: true, affected });
  });

  router.get('/keys/:id', async (req, res) => {
    const k = await store.getKey(req.params.id);
    if (!k) return res.status(404).json({ error: { message: 'Key not found' } });
    res.json({ id: k.id, key: k.key, ...keyInfo(k) });
  });

  router.get('/keys/:id/requests', async (req, res) => {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    res.json({ requests: await store.listRequests(req.params.id, limit) });
  });

  router.patch('/keys/:id', async (req, res) => {
    const existing = await store.getKey(req.params.id);
    if (!existing) return res.status(404).json({ error: { message: 'Key not found' } });

    const { name, status, tokenLimit, expiresAt, addTokens, resetUsage, regenerate, allowedModels } = req.body || {};
    const patch = {};

    if (name !== undefined) {
      const n = String(name).trim().slice(0, 80);
      if (n) patch.name = n;
    }
    if (status !== undefined) {
      if (!['active', 'blocked'].includes(status)) {
        return res.status(400).json({ error: { message: 'status must be "active" or "blocked"' } });
      }
      patch.status = status;
    }
    if (tokenLimit !== undefined) {
      const n = Number(tokenLimit);
      if (!Number.isFinite(n) || n <= 0) {
        return res.status(400).json({ error: { message: 'tokenLimit must be a positive number' } });
      }
      patch.tokenLimit = Math.floor(n);
    }
    if (addTokens !== undefined) {
      const n = Number(addTokens);
      if (!Number.isFinite(n) || n <= 0) {
        return res.status(400).json({ error: { message: 'addTokens must be a positive number' } });
      }
      patch.tokenLimit = (patch.tokenLimit ?? existing.tokenLimit) + Math.floor(n);
    }
    if (resetUsage) patch.tokensUsed = 0;
    if (regenerate) patch.key = 'astra-' + crypto.randomBytes(24).toString('hex');
    if (allowedModels !== undefined) {
      if (allowedModels === null) {
        patch.allowedModels = null;
      } else if (Array.isArray(allowedModels) && allowedModels.every((x) => typeof x === 'string' && x.trim())) {
        patch.allowedModels = [...new Set(allowedModels.map((x) => x.trim()))];
      } else {
        return res.status(400).json({ error: { message: 'allowedModels must be null or an array of model ids' } });
      }
    }
    if (expiresAt !== undefined) {
      if (expiresAt === null || expiresAt === '') {
        patch.expiresAt = null;
      } else {
        const t = new Date(expiresAt);
        if (Number.isNaN(t.getTime())) {
          return res.status(400).json({ error: { message: 'Invalid expiresAt date' } });
        }
        patch.expiresAt = t.toISOString();
      }
    }

    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: { message: 'No fields to update' } });
    }

    const updated = await store.updateKey(req.params.id, patch);
    res.json({ id: updated.id, key: updated.key, ...keyInfo(updated) });
  });

  router.delete('/keys/:id', async (req, res) => {
    await store.deleteKey(req.params.id);
    res.json({ ok: true });
  });

  // ── Model catalog ──────────────────────────────────────

  router.get('/models', async (req, res) => {
    res.json({ models: await store.listModels() });
  });

  router.post('/models', async (req, res) => {
    const { id, upstreamId, label, systemPrompt, hideThinking, responseDelayMs, supportsVision, ensembleEnabled, ensembleMembers, ensembleStrategy } = req.body || {};
    const publicId = String(id || '').trim();
    if (!publicId) return res.status(400).json({ error: { message: 'Model id is required' } });
    if (ensembleMembers !== undefined && !Array.isArray(ensembleMembers)) {
      return res.status(400).json({ error: { message: 'ensembleMembers must be an array of model ids' } });
    }
    if (Array.isArray(ensembleMembers) && ensembleMembers.filter((m) => String(m).trim()).length > 4) {
      return res.status(400).json({ error: { message: 'ensembleMembers: at most 4 models' } });
    }
    if (ensembleStrategy !== undefined && !['race', 'best'].includes(ensembleStrategy)) {
      return res.status(400).json({ error: { message: 'ensembleStrategy must be "race" or "best"' } });
    }
    const models = await store.listModels();
    if (models.some((m) => m.id === publicId)) {
      return res.status(409).json({ error: { message: `Model "${publicId}" already exists` } });
    }
    const model = createModel({ id: publicId, upstreamId, label, systemPrompt, hideThinking, responseDelayMs, supportsVision, ensembleEnabled, ensembleMembers, ensembleStrategy });
    await store.insertModel(model);
    res.status(201).json(model);
  });

  router.patch('/models/:id', async (req, res) => {
    const { label, upstreamId, enabled, systemPrompt, hideThinking, responseDelayMs, supportsVision, ensembleEnabled, ensembleMembers, ensembleStrategy } = req.body || {};
    const patch = {};
    if (label !== undefined) {
      const v = String(label).trim().slice(0, 80);
      if (v) patch.label = v;
    }
    if (upstreamId !== undefined) {
      const v = String(upstreamId).trim();
      if (v) patch.upstreamId = v;
    }
    if (enabled !== undefined) patch.enabled = Boolean(enabled);
    if (hideThinking !== undefined) patch.hideThinking = Boolean(hideThinking);
    if (supportsVision !== undefined) patch.supportsVision = Boolean(supportsVision);
    if (ensembleEnabled !== undefined) patch.ensembleEnabled = Boolean(ensembleEnabled);
    if (ensembleMembers !== undefined) {
      if (!Array.isArray(ensembleMembers)) {
        return res.status(400).json({ error: { message: 'ensembleMembers must be an array of model ids' } });
      }
      const ids = [...new Set(ensembleMembers.map((m) => String(m).trim()).filter(Boolean))];
      if (ids.length > 4) {
        return res.status(400).json({ error: { message: 'ensembleMembers: at most 4 models' } });
      }
      if (ids.includes(req.params.id)) {
        return res.status(400).json({ error: { message: 'a model can not be a member of its own ensemble' } });
      }
      patch.ensembleMembers = ids;
    }
    if (ensembleStrategy !== undefined) {
      if (!['race', 'best'].includes(ensembleStrategy)) {
        return res.status(400).json({ error: { message: 'ensembleStrategy must be "race" or "best"' } });
      }
      patch.ensembleStrategy = ensembleStrategy;
    }
    if (responseDelayMs !== undefined) {
      const n = Number(responseDelayMs);
      if (!Number.isFinite(n) || n < 0 || n > 60000) {
        return res.status(400).json({ error: { message: 'responseDelayMs must be 0–60000' } });
      }
      patch.responseDelayMs = Math.floor(n);
    }
    if (systemPrompt !== undefined) {
      patch.systemPrompt =
        systemPrompt === null || String(systemPrompt).trim() === ''
          ? null
          : String(systemPrompt).trim();
    }
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: { message: 'No fields to update' } });
    }
    const updated = await store.updateModel(req.params.id, patch);
    if (!updated) return res.status(404).json({ error: { message: 'Model not found' } });
    res.json(updated);
  });

  router.delete('/models/:id', async (req, res) => {
    const models = await store.listModels();
    const i = models.findIndex((m) => m.id === req.params.id);
    if (i === -1) return res.status(404).json({ error: { message: 'Model not found' } });
    await store.deleteModel(req.params.id);
    res.json({ ok: true });
  });

  // ── Playground: run a prompt through a model without spending client keys ──

  router.post('/playground', async (req, res) => {
    const started = Date.now();
    if (!config.upstreamBaseUrl || !config.upstreamApiKey) {
      return res.status(500).json({ error: { message: 'Upstream provider is not configured' } });
    }

    const { model: modelId, messages, stream } = req.body || {};
    const models = await store.listModels();
    const model = models.find((m) => m.id === modelId && m.enabled);
    if (!model) {
      return res.status(400).json({ error: { message: `Unknown or disabled model: "${modelId}"` } });
    }

    const clean = (Array.isArray(messages) ? messages : [])
      .filter((m) => m && typeof m.content === 'string' && m.content.trim())
      .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));

    const ensembleMembers = resolveEnsembleMembers(model, models);
    const body = {
      model: ensembleMembers.length ? ensembleMembers[0] : (model.upstreamId || model.id),
      messages: clean.length ? clean : [{ role: 'user', content: 'Hello!' }],
    };
    // Kimi models reject sampling params — keep the same guard as the proxy.
    if (/^kimi/i.test(body.model)) {
      for (const p of ['temperature', 'top_p', 'presence_penalty', 'frequency_penalty']) delete body[p];
    }
    if (model.systemPrompt) {
      body.messages = [{ role: 'system', content: model.systemPrompt }, ...body.messages];
    }
    if (stream === true) {
      body.stream = true;
      body.stream_options = { include_usage: true };
    }

    // Non-streaming ensemble: fan out to all members and merge here.
    if (stream !== true && ensembleMembers.length > 1) {
      let data;
      try {
        data = await runEnsemble({ members: ensembleMembers, base: body, strategy: model.ensembleStrategy });
      } catch {
        return res.status(502).json({ error: { message: 'All ensemble members failed' } });
      }
      if (model.hideThinking) stripThinkingFromResponse(data);
      const message = data?.choices?.[0]?.message || {};
      const rawReasoning = message.reasoning_content ?? null;
      const tokens = data?.usage?.total_tokens ?? estimateTokens(body, message.content || '');
      return res.json({
        model: model.id,
        upstreamModel: ensembleMembers.join(' + '),
        content: message.content ?? '',
        reasoning: model.hideThinking ? null : rawReasoning,
        persona: model.systemPrompt || null,
        reasoningHidden: Boolean(model.hideThinking && rawReasoning),
        tokens,
        ms: Date.now() - started,
        ensemble: model.ensembleStrategy,
      });
    }

    let upstream;
    try {
      upstream = await fetchUpstreamChat(body);
    } catch {
      return res.status(502).json({ error: { message: 'Upstream request failed' } });
    }

    if (!upstream.ok) {
      const text = await upstream.text();
      let payload = null;
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
      return res
        .status(upstream.status)
        .json(payload || { error: { message: 'Upstream error ' + upstream.status } });
    }

    if (stream !== true) {
      const data = await upstream.json();
      const message = data?.choices?.[0]?.message || {};
      const rawReasoning = message.reasoning_content ?? null;
      const tokens = data?.usage?.total_tokens ?? estimateTokens(body, message.content || '');
      if (model.hideThinking) stripThinkingFromResponse(data);
      return res.json({
        model: model.id,
        upstreamModel: model.upstreamId || model.id,
        content: data?.choices?.[0]?.message?.content ?? '',
        reasoning: model.hideThinking ? null : rawReasoning,
        persona: model.systemPrompt || null,
        reasoningHidden: Boolean(model.hideThinking && rawReasoning),
        tokens,
        ms: Date.now() - started,
      });
    }

    // Streaming mode: same pipe as the public proxy (SSE).
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    await pipeOpenAIStream({
      upstream,
      res,
      publicModel: model.id,
      hideThinking: model.hideThinking === true,
    });
  });

  // Fetch the real model list from the upstream provider (admin-only).
  router.post('/models/discover', async (req, res) => {
    if (!config.upstreamBaseUrl || !config.upstreamApiKey) {
      return res.status(500).json({ error: { message: 'Upstream provider is not configured' } });
    }
    try {
      const upstream = await fetch(`${config.upstreamBaseUrl}/models`, {
        headers: { Authorization: `Bearer ${config.upstreamApiKey}` },
      });
      const data = await upstream.json().catch(() => ({}));
      if (!upstream.ok) return res.status(upstream.status).json(data);
      const knownUpstream = new Set((await store.listModels()).map((m) => m.upstreamId));
      res.json({
        models: (data.data || []).map((m) => ({
          id: m.id,
          ownedBy: m.owned_by || null,
          added: knownUpstream.has(m.id),
        })),
      });
    } catch {
      res.status(502).json({ error: { message: 'Upstream request failed', type: 'upstream_error' } });
    }
  });

  return router;
}
