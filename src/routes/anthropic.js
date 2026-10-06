import crypto from 'node:crypto';
import { Router } from 'express';
import { config } from '../config.js';
import { isExpired } from '../db.js';
import { estimateTokens } from '../usage.js';
import { fetchUpstreamChat, sseEvents, parseSseData, resolveEnsembleMembers } from '../upstream.js';
import { stripThinkingFromResponse, createThinkFilter } from '../thinking.js';

// Anthropic-compatible /v1/messages endpoint, so clients such as Claude Code can
// talk to the gateway. Requests are translated to the OpenAI format upstream and
// the responses (including streaming and tool calls) back to Anthropic events.

const errBody = (type, message) => ({ type: 'error', error: { type, message } });

function anthropicAuth(store) {
  return async (req, res, next) => {
    let key = null;
    try {
      let token = '';
      const header = req.headers.authorization || '';
      if (header.startsWith('Bearer ')) token = header.slice(7).trim();
      if (!token && req.headers['x-api-key']) token = String(req.headers['x-api-key']).trim();
      if (token) key = await store.findKeyBySecret(token);
    } catch (err) {
      return next(err);
    }
    if (!key) return res.status(401).json(errBody('authentication_error', 'Invalid or missing API key'));
    req.clientKey = key;
    next();
  };
}

function anthropicGate(store) {
  const log = (key, req, status, error) =>
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
      await log(k, req, 403, 'key blocked');
      return res.status(403).json(errBody('permission_error', 'This API key has been blocked'));
    }
    if (isExpired(k)) {
      await log(k, req, 403, 'key expired');
      return res.status(403).json(errBody('permission_error', 'This API key has expired'));
    }
    if (k.tokensUsed >= k.tokenLimit) {
      await log(k, req, 429, 'quota exceeded');
      return res.status(429).json(errBody('rate_limit_error', 'Token quota exceeded. Top up your balance to continue.'));
    }
    next();
  };
}

function systemToText(system) {
  if (typeof system === 'string') return system.trim();
  if (Array.isArray(system)) {
    return system.filter((b) => b?.type === 'text').map((b) => b.text || '').join('\n').trim();
  }
  return '';
}

function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((c) => c?.type === 'text').map((c) => c.text || '').join('\n');
  if (content == null) return '';
  return JSON.stringify(content);
}

function imagePart(source) {
  if (!source || typeof source !== 'object') return null;
  if (source.type === 'base64' && source.media_type && source.data) {
    return { type: 'image_url', image_url: { url: `data:${source.media_type};base64,${source.data}` } };
  }
  if (source.type === 'url' && source.url) {
    return { type: 'image_url', image_url: { url: source.url } };
  }
  return null;
}

function toOpenAIMessages(body) {
  const out = [];
  const sys = systemToText(body.system);
  if (sys) out.push({ role: 'system', content: sys });

  for (const msg of Array.isArray(body.messages) ? body.messages : []) {
    const role = msg.role === 'assistant' ? 'assistant' : 'user';
    if (typeof msg.content === 'string') {
      out.push({ role, content: msg.content });
      continue;
    }
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    if (role === 'assistant') {
      let text = '';
      const toolCalls = [];
      for (const b of blocks) {
        if (b?.type === 'text') text += b.text || '';
        else if (b?.type === 'tool_use') {
          toolCalls.push({
            id: b.id,
            type: 'function',
            function: { name: b.name, arguments: JSON.stringify(b.input || {}) },
          });
        }
      }
      const m = { role: 'assistant', content: text || null };
      if (toolCalls.length) m.tool_calls = toolCalls;
      out.push(m);
    } else {
      const texts = [];
      const images = [];
      for (const b of blocks) {
        if (b?.type === 'text') texts.push(b.text || '');
        else if (b?.type === 'image') {
          const part = imagePart(b.source);
          if (part) images.push(part);
        } else if (b?.type === 'tool_result') {
          out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: toolResultText(b.content) });
        }
      }
      if (images.length) {
        // Multimodal message: text parts + image parts in OpenAI format.
        const parts = texts.filter((t) => t.trim()).map((t) => ({ type: 'text', text: t }));
        out.push({ role: 'user', content: [...parts, ...images] });
      } else if (texts.length) {
        out.push({ role: 'user', content: texts.join('\n') });
      }
    }
  }
  return out;
}

function hasImageBlocks(body) {
  return (Array.isArray(body?.messages) ? body.messages : []).some(
    (m) => Array.isArray(m?.content) && m.content.some((b) => b?.type === 'image')
  );
}

function toolsToOpenAI(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const mapped = tools.filter((t) => t?.name).map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description || '',
      parameters: t.input_schema || { type: 'object', properties: {} },
    },
  }));
  return mapped.length ? mapped : undefined;
}

function stopReasonFromFinish(finish) {
  if (finish === 'tool_calls') return 'tool_use';
  if (finish === 'length') return 'max_tokens';
  return 'end_turn';
}

function toAnthropicResponse(data, publicModel) {
  const choice = data?.choices?.[0] || {};
  const msg = choice.message || {};
  const content = [];
  if (typeof msg.content === 'string' && msg.content) content.push({ type: 'text', text: msg.content });
  for (const call of msg.tool_calls || []) {
    let input = {};
    try {
      input = JSON.parse(call.function?.arguments || '{}');
    } catch {
      input = {};
    }
    content.push({
      type: 'tool_use',
      id: call.id || 'toolu_' + crypto.randomBytes(8).toString('hex'),
      name: call.function?.name || '',
      input,
    });
  }
  if (!content.length) content.push({ type: 'text', text: '' });
  return {
    id: data?.id || 'msg_' + crypto.randomBytes(10).toString('hex'),
    type: 'message',
    role: 'assistant',
    model: publicModel,
    content,
    stop_reason: stopReasonFromFinish(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: data?.usage?.prompt_tokens ?? 0,
      output_tokens: data?.usage?.completion_tokens ?? 0,
    },
  };
}

export function createAnthropicRouter(store) {
  const router = Router();

  router.use(anthropicAuth(store));

  router.post('/messages', anthropicGate(store), async (req, res) => {
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
      return res.status(500).json(errBody('api_error', 'Upstream provider is not configured'));
    }

    const models = await store.listModels();
    const allow = req.clientKey.allowedModels;
    const usable = models.filter((m) => m.enabled && (!allow || allow.includes(m.id)));
    if (!usable.length) {
      await log(400, null, 0, 'no models available');
      return res.status(400).json(errBody('invalid_request_error', 'No models are available for this API key'));
    }

    const requested = String(req.body?.model || '');
    const model =
      usable.find((m) => m.id === requested) ||
      (config.anthropicDefaultModel ? usable.find((m) => m.id === config.anthropicDefaultModel) : null) ||
      usable[0];

    // Ensemble models on the Anthropic endpoint run through their first member
    // (the full fan-out is only implemented for the OpenAI-format route).
    const ensembleMembers = resolveEnsembleMembers(model, models);
    let anthropicUpstream = ensembleMembers.length ? ensembleMembers[0] : (model.upstreamId || model.id);
    // Vision rerouting, same as the OpenAI route.
    if (hasImageBlocks(req.body) && model.supportsVision !== true) {
      const visionTarget = models.find((m) => m.enabled && m.supportsVision === true);
      if (visionTarget) anthropicUpstream = visionTarget.upstreamId || visionTarget.id;
    }

    // Per-model artificial response delay (0 = disabled).
    const delayMs = Math.min(60000, Math.max(0, Number(model.responseDelayMs) || 0));
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));

    const body = {
      model: anthropicUpstream,
      messages: toOpenAIMessages(req.body || {}),
      stream: req.body?.stream === true,
    };
    // Reject empty input before it reaches the upstream (its own error is cryptic).
    const hasInput = body.messages.some(
      (m) =>
        (typeof m.content === 'string' && m.content.trim().length > 0) ||
        (Array.isArray(m.content) && m.content.length > 0)
    );
    if (!hasInput) {
      await log(400, model.id, 0, 'empty input');
      return res.status(400).json(errBody('invalid_request_error', 'messages must contain at least one non-empty message.'));
    }
    if (typeof req.body?.max_tokens === 'number') body.max_tokens = req.body.max_tokens;
    if (Array.isArray(req.body?.stop_sequences) && req.body.stop_sequences.length) body.stop = req.body.stop_sequences;
    if (req.body?.temperature !== undefined) body.temperature = req.body.temperature;
    if (req.body?.top_p !== undefined) body.top_p = req.body.top_p;

    const tools = toolsToOpenAI(req.body?.tools);
    if (tools) body.tools = tools;
    if (req.body?.tool_choice) {
      const tc = req.body.tool_choice;
      if (tc?.type === 'tool' && tc.name) body.tool_choice = { type: 'function', function: { name: tc.name } };
      else if (tc?.type === 'auto') body.tool_choice = 'auto';
      else if (tc?.type === 'any') body.tool_choice = 'required';
    }

    // Kimi models reject sampling params — same guard as the OpenAI route.
    if (/^kimi/i.test(body.model)) {
      for (const p of ['temperature', 'top_p', 'presence_penalty', 'frequency_penalty']) delete body[p];
    }
    if (model.systemPrompt && body.messages.length) {
      body.messages = [{ role: 'system', content: model.systemPrompt }, ...body.messages];
    }
    if (body.stream) body.stream_options = { include_usage: true };

    let upstream;
    try {
      upstream = await fetchUpstreamChat(body);
    } catch {
      await log(502, model.id, 0, 'upstream unreachable');
      return res.status(502).json(errBody('api_error', 'Upstream request failed'));
    }

    if (!upstream.ok) {
      const text = await upstream.text();
      await log(upstream.status, model.id, 0, 'upstream error');
      let payload = null;
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
      return res.status(upstream.status).json(payload || errBody('api_error', 'Upstream error'));
    }

    if (!body.stream) {
      const data = await upstream.json();
      if (model.hideThinking === true) stripThinkingFromResponse(data);
      const tokens =
        data?.usage?.total_tokens ?? estimateTokens(req.body, data?.choices?.[0]?.message?.content || '');
      await store.recordUsage(req.clientKey.id, req.clientKey, model.id, tokens);
      await log(200, model.id, tokens, null);
      return res.json(toAnthropicResponse(data, model.id));
    }

    // ── Streaming: translate OpenAI chunks into Anthropic SSE events ──
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const messageId = 'msg_' + crypto.randomBytes(10).toString('hex');
    const writeEvent = (type, payload) => res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);

    let textBlockOpen = false;
    let index = 0;
    let usage = null;
    let completionLen = 0;
    let finish = null;
    const toolBlocks = new Map();
    const thinkFilter = model.hideThinking === true ? createThinkFilter() : null;

    writeEvent('message_start', {
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        model: model.id,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: estimateTokens(req.body, ''), output_tokens: 0 },
      },
    });

    try {
      for await (const raw of sseEvents(upstream.body)) {
        for (const chunk of parseSseData(raw)) {
          if (chunk.usage) usage = chunk.usage;
          const choice = chunk.choices?.[0];
          if (!choice) continue;
          const delta = choice.delta || {};

          if (typeof delta.content === 'string' && delta.content.length) {
            const text = thinkFilter ? thinkFilter(delta.content) : delta.content;
            if (text.length) {
              completionLen += text.length;
              if (!textBlockOpen) {
                writeEvent('content_block_start', { index, content_block: { type: 'text', text: '' } });
                textBlockOpen = true;
              }
              writeEvent('content_block_delta', { index, delta: { type: 'text_delta', text } });
            }
          }

          for (const call of delta.tool_calls || []) {
            const key = call.index ?? 0;
            if (!toolBlocks.has(key)) {
              if (textBlockOpen) {
                writeEvent('content_block_stop', { index });
                textBlockOpen = false;
                index += 1;
              }
              const blockIndex = index;
              toolBlocks.set(key, blockIndex);
              writeEvent('content_block_start', {
                index: blockIndex,
                content_block: {
                  type: 'tool_use',
                  id: call.id || 'toolu_' + crypto.randomBytes(6).toString('hex'),
                  name: call.function?.name || '',
                  input: {},
                },
              });
              index += 1;
            }
            if (typeof call.function?.arguments === 'string' && call.function.arguments.length) {
              writeEvent('content_block_delta', {
                index: toolBlocks.get(key),
                delta: { type: 'input_json_delta', partial_json: call.function.arguments },
              });
            }
          }

          if (choice.finish_reason) finish = choice.finish_reason;
        }
      }
    } catch (err) {
      console.error('Anthropic stream error:', err.message);
    }

    if (textBlockOpen) writeEvent('content_block_stop', { index });
    for (const blockIndex of toolBlocks.values()) writeEvent('content_block_stop', { index: blockIndex });
    if (thinkFilter) {
      const tail = thinkFilter.flush();
      if (tail) {
        if (!textBlockOpen) {
          writeEvent('content_block_start', { index, content_block: { type: 'text', text: '' } });
          textBlockOpen = true;
        }
        writeEvent('content_block_delta', { index, delta: { type: 'text_delta', text: tail } });
      }
    }
    writeEvent('message_delta', {
      delta: { stop_reason: stopReasonFromFinish(finish), stop_sequence: null },
      usage: { output_tokens: usage?.completion_tokens ?? Math.ceil(completionLen / 4) },
    });
    writeEvent('message_stop', {});
    res.end();

    const tokens = usage?.total_tokens ?? estimateTokens(req.body, 'x'.repeat(completionLen));
    await store.recordUsage(req.clientKey.id, req.clientKey, model.id, tokens);
    log(200, model.id, tokens, null);
  });

  return router;
}
