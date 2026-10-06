import { Router } from 'express';
import { config } from '../config.js';
import { clientAuth, checkUsable } from '../auth.js';
import { keyInfo } from '../db.js';
import { estimateTokens } from '../usage.js';
import { fetchUpstreamChat, pipeOpenAIStream, resolveEnsembleMembers, runEnsemble } from '../upstream.js';
import { stripThinkingFromResponse } from '../thinking.js';


// Public usage must not expose the configured server-side system prompt.
// Keep the real upstream usage internally for quota/accounting, but report
// prompt_tokens based only on the original client request body.
function publicUsage(usage, publicPromptTokens) {
  if (!usage || typeof usage !== 'object') return usage;
  const completionTokens = Number(usage.completion_tokens) || 0;
  return {
    ...usage,
    prompt_tokens: publicPromptTokens,
    total_tokens: publicPromptTokens + completionTokens,
  };
}

export function createProxyRouter(store) {
  const router = Router();

  router.use(clientAuth(store));

  // Public model list — enabled models this key is allowed to use.
  router.get('/models', async (req, res) => {
    const models = await store.listModels();
    const allow = req.clientKey.allowedModels;
    res.json({
      object: 'list',
      data: models
        .filter((m) => m.enabled && (!allow || allow.includes(m.id)))
        .map((m) => ({ id: m.id, object: 'model', created: 1725000000, owned_by: 'strax' })),
    });
  });

  // Self-service key info: a key owner can check their own balance/usage.
  router.get('/key/info', async (req, res) => {
    const models = await store.listModels();
    const allow = req.clientKey.allowedModels;
    res.json({
      ...keyInfo(req.clientKey),
      availableModels: models
        .filter((m) => m.enabled && (!allow || allow.includes(m.id)))
        .map((m) => ({ id: m.id, label: m.label })),
    });
  });

  router.post('/chat/completions', checkUsable(store), async (req, res) => {
    const started = Date.now();
    const log = (status, model, tokens, error) =>
      store
        .logRequest({
          keyId: req.clientKey.id,
          model,
          status,
          tokens,
          durationMs: Date.now() - started,
          error,
        })
        .catch(() => {});

    if (!config.upstreamBaseUrl || !config.upstreamApiKey) {
      return res
        .status(500)
        .json({ error: { message: 'Upstream provider is not configured', type: 'server_error' } });
    }

    const publicModel = req.body?.model;
    const models = await store.listModels();
    const model = models.find((m) => m.id === publicModel && m.enabled);
    if (!model) {
      const available = models.filter((m) => m.enabled).map((m) => m.id);
      await log(400, publicModel || null, 0, 'unknown model');
      return res.status(400).json({
        error: {
          message: `Unknown model: "${publicModel}". Available: ${available.join(', ') || 'none'}`,
          type: 'invalid_request_error',
        },
      });
    }
    const allow = req.clientKey.allowedModels;
    if (allow && !allow.includes(publicModel)) {
      await log(403, publicModel, 0, 'model not allowed for key');
      return res.status(403).json({
        error: {
          message: `Model "${publicModel}" is not available for this API key.`,
          type: 'model_not_allowed',
        },
      });
    }

    // Reject empty input before it reaches the upstream (its own error is cryptic).
    const hasInput = (Array.isArray(req.body?.messages) ? req.body.messages : []).some(
      (m) =>
        (typeof m.content === 'string' && m.content.trim().length > 0) ||
        (Array.isArray(m.content) && m.content.length > 0)
    );
    if (!hasInput) {
      await log(400, publicModel, 0, 'empty input');
      return res.status(400).json({
        error: {
          message: 'messages must contain at least one non-empty message.',
          type: 'invalid_request_error',
        },
      });
    }
    const hasImages = (Array.isArray(req.body?.messages) ? req.body.messages : []).some(
      (m) =>
        Array.isArray(m?.content) &&
        m.content.some((p) => p?.type === 'image_url' || p?.type === 'image')
    );
    let upstreamModel = model.upstreamId || model.id;
    // Vision rerouting: image requests aimed at a non-vision model are sent to
    // the first enabled vision-capable model instead, so every public id
    // "sees" photos as long as one upstream model supports vision.
    const visionTarget =
      hasImages && model.supportsVision !== true
        ? models.find((m) => m.enabled && m.supportsVision === true)
        : null;
    if (visionTarget) upstreamModel = visionTarget.upstreamId || visionTarget.id;
    // Per-model option: hide chain-of-thought output from clients.
    const hideThinking = model.hideThinking === true;
    // Per-model artificial response delay (0 = disabled).
    const delayMs = Math.min(60000, Math.max(0, Number(model.responseDelayMs) || 0));
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));

    const body = { ...req.body, model: upstreamModel };
    // Public prompt usage is estimated from client user messages only. The
    // server-side system prompt is injected afterwards and is never included.
    const publicPromptTokens = estimateTokens(
      { messages: (Array.isArray(req.body?.messages) ? req.body.messages : []).filter((m) => m?.role === 'user') },
      ''
    );
    // Ensemble: several models behind one public id (skipped when rerouted for vision).
    // Tool-calling requests must stay on the direct upstream path so structured
    // tool_calls/finish_reason values reach OpenCode unchanged. The ensemble
    // path is text-oriented and intentionally bypassed only for requests that
    // actually declare tools. Everything else keeps the existing behavior.
    const ensembleMembers = resolveEnsembleMembers(model, models);
    const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
    const useEnsemble = !visionTarget && !hasTools && ensembleMembers.length > 1;
    if (useEnsemble) body.model = ensembleMembers[0];
    // Strict providers (Kimi models on DashScope) reject sampling params like
    // temperature=0.7 that chat UIs send by default. Drop them for kimi so the
    // model's own defaults apply instead of failing the whole request.
    if (/^kimi/i.test(upstreamModel)) {
      for (const p of ['temperature', 'top_p', 'presence_penalty', 'frequency_penalty']) delete body[p];
    }
    // Per-model persona: prepend the configured system prompt (admin panel).
    if (model.systemPrompt && Array.isArray(body.messages) && body.messages.length > 0) {
      body.messages = [{ role: 'system', content: model.systemPrompt }, ...body.messages];
    }
    const wantStream = body.stream === true;
    if (wantStream) {
      // Ask the upstream to include a usage chunk so token accounting stays exact.
      body.stream_options = { ...(body.stream_options || {}), include_usage: true };
    }

    let upstream;
    try {
      if (useEnsemble) {
        // The ensemble completes on its own; upstream is not a fetch Response here.
        const { ...bodyWithoutStreamOptions } = body;
        delete bodyWithoutStreamOptions.stream;
        delete bodyWithoutStreamOptions.stream_options;
        let data;
        try {
          data = await runEnsemble({ members: ensembleMembers, base: bodyWithoutStreamOptions, strategy: model.ensembleStrategy });
        } catch (err) {
          log(502, publicModel, 0, 'ensemble failed: ' + err.message);
          return res.status(502).json({ error: { message: 'All ensemble members failed', type: 'upstream_error' } });
        }
        data.model = publicModel;
        if (hideThinking) stripThinkingFromResponse(data);
        const tokens =
          data?.usage?.total_tokens ?? estimateTokens(req.body, data?.choices?.[0]?.message?.content || '');
        await store.recordUsage(req.clientKey.id, req.clientKey, publicModel, tokens);
        await log(200, publicModel, tokens, null);

        if (!wantStream) {
          // Hide only the server-side system-prompt tokens from public usage.
          const publicData = data?.usage
            ? { ...data, usage: publicUsage(data.usage, publicPromptTokens) }
            : data;
          // Send the exact UTF-8 bytes and let Node/Render frame the response.
          // Do not force Content-Length here: a stale/miscomputed length can
          // make the proxy truncate an otherwise valid JSON body.
          const payload = Buffer.from(JSON.stringify(publicData), 'utf8');
          res.status(200);
          res.removeHeader('Content-Length');
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          return res.end(payload);
        }

        // Streaming ensemble: emit the final answer as SSE chunks.
        res.status(200);
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders?.();
        const content = data.choices?.[0]?.message?.content || '';
        const chunkSize = 32;
        for (let i = 0; i < content.length; i += chunkSize) {
          res.write(
            'data: ' +
              JSON.stringify({
                id: 'strax-ensemble',
                object: 'chat.completion.chunk',
                created: 1,
                model: publicModel,
                choices: [{ index: 0, delta: { content: content.slice(i, i + chunkSize) }, finish_reason: null }],
              }) +
              '\n\n'
          );
        }
        res.write(
          'data: ' +
            JSON.stringify({
              id: 'strax-ensemble',
              object: 'chat.completion.chunk',
              created: 1,
              model: publicModel,
              choices: [{ index: 0, delta: {}, finish_reason: data.choices?.[0]?.finish_reason || 'stop' }],
            }) +
            '\n\n'
        );
        res.write('data: ' + JSON.stringify({ id: 'strax-ensemble', object: 'chat.completion.chunk', created: 1, model: publicModel, choices: [], usage: publicUsage(data.usage, publicPromptTokens) }) + '\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      upstream = await fetchUpstreamChat(body);
    } catch (err) {
      console.error('Upstream connection error:', err.message);
      await log(502, publicModel, 0, 'upstream unreachable');
      return res.status(502).json({ error: { message: 'Upstream request failed', type: 'upstream_error' } });
    }

    if (!upstream.ok) {
      const text = await upstream.text();
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { error: { message: 'Upstream error', type: 'upstream_error' } };
      }
      await log(upstream.status, publicModel, 0, 'upstream error');
      return res.status(upstream.status).json(payload);
    }

    if (!wantStream) {
      const data = await upstream.json();
      // Report the public model name back to the client.
      if (data && typeof data === 'object') data.model = publicModel;
      if (hideThinking) stripThinkingFromResponse(data);
      const tokens =
        data?.usage?.total_tokens ?? estimateTokens(req.body, data?.choices?.[0]?.message?.content || '');
      await store.recordUsage(req.clientKey.id, req.clientKey, publicModel, tokens);
      await log(200, publicModel, tokens, null);
      // Hide only the server-side system-prompt tokens from public usage.
      const publicData = data?.usage
        ? { ...data, usage: publicUsage(data.usage, publicPromptTokens) }
        : data;
      // Send the exact UTF-8 bytes and let Node/Render frame the response.
      // Do not force Content-Length: a stale/miscomputed length can make the
      // proxy truncate an otherwise valid JSON body.
      const payload = Buffer.from(JSON.stringify(publicData), 'utf8');
      res.status(200);
      res.removeHeader('Content-Length');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.end(payload);
    }

    // --- Streaming (text/event-stream) ---
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const { usage, completionLen, aborted } = await pipeOpenAIStream({
      upstream,
      res,
      publicModel,
      hideThinking,
      publicPromptTokens,
    });

    const tokens = usage?.total_tokens ?? estimateTokens(req.body, 'x'.repeat(completionLen));
    await store.recordUsage(req.clientKey.id, req.clientKey, publicModel, tokens);
    log(aborted ? 499 : 200, publicModel, tokens, aborted ? 'client aborted' : null);
  });

  return router;
}
