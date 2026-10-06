import { config } from './config.js';
import { createThinkFilter } from './thinking.js';

// Thin wrappers around the upstream OpenAI-compatible provider, shared by the
// OpenAI-format (/v1/chat/completions) and Anthropic-format (/v1/messages) routes.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Upstream providers apply an account-wide burst rate limit (HTTP 429
// "Request rate increased too quickly"). Clients that fire several requests
// at once (or auto-retry) trip it and appear to hang forever. Two defenses:
//  - outgoing requests are spaced at least MIN_START_GAP_MS apart;
//  - 429/5xx/network errors are retried with exponential backoff + jitter
//    (only before any bytes are streamed to the client, so it is always safe).
const MIN_START_GAP_MS = 400;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 3;

let startChain = Promise.resolve();
let lastStartAt = 0;
function reserveUpstreamSlot() {
  const run = async () => {
    const wait = Math.max(0, lastStartAt + MIN_START_GAP_MS - Date.now());
    if (wait > 0) await sleep(wait);
    lastStartAt = Date.now();
  };
  startChain = startChain.then(run, run);
  return startChain;
}

export async function fetchUpstreamChat(body, signal) {
  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (signal?.aborted) throw new Error('aborted');
    await reserveUpstreamSlot();
    let res;
    try {
      res = await fetch(`${config.upstreamBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.upstreamApiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      lastError = err;
      if (attempt < MAX_RETRIES) {
        await sleep(400 * 2 ** attempt + Math.random() * 300);
        continue;
      }
      throw err;
    }
    if (RETRYABLE_STATUSES.has(res.status) && attempt < MAX_RETRIES) {
      await res.arrayBuffer().catch(() => {});
      const retryAfterSec = Number(res.headers.get('retry-after'));
      const delay = Number.isFinite(retryAfterSec) && retryAfterSec > 0 && retryAfterSec <= 20
        ? retryAfterSec * 1000
        : 400 * 2 ** attempt + Math.random() * 300;
      await sleep(delay);
      continue;
    }
    return res;
  }
  throw lastError || new Error('upstream request failed');
}

// Resolves the ensemble member upstream ids for a catalog model.
// Returns [] when the ensemble is off, references itself, or nothing resolves.
export function resolveEnsembleMembers(model, allModels) {
  if (model.ensembleEnabled !== true || !Array.isArray(model.ensembleMembers)) return [];
  const out = [];
  for (const id of model.ensembleMembers) {
    if (id === model.id) continue; // no self-recursion
    const m = allModels.find((x) => x.id === id && x.enabled);
    if (m) out.push(m.upstreamId || m.id);
  }
  return [...new Set(out)].slice(0, 4);
}

function sumUsage(datasets) {
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  for (const d of datasets) {
    if (d?.usage) {
      usage.prompt_tokens += d.usage.prompt_tokens || 0;
      usage.completion_tokens += d.usage.completion_tokens || 0;
      usage.total_tokens += d.usage.total_tokens || 0;
    }
  }
  return usage;
}

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user' && typeof messages[i].content === 'string') return messages[i].content;
  }
  return '';
}

// Ensemble execution over several upstream models.
//  - 'race': all members answer in parallel, the first successful response wins
//    (losers are aborted). Fastest + fault-tolerant.
//  - 'best': all members answer, then a judge (the first member) picks the best
//    candidate. Higher quality, N+1 calls.
// `base` is the OpenAI-format request body WITHOUT the model field.
export async function runEnsemble({ members, base, strategy }) {
  if (!members || members.length === 0) throw new Error('no ensemble members');

  if (strategy === 'best' && members.length > 1) {
    const results = await Promise.allSettled(
      members.map((m) =>
        fetchUpstreamChat({ ...base, model: m }).then((r) =>
          r.ok ? r.json() : Promise.reject(new Error('upstream ' + r.status))
        )
      )
    );
    const ok = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    if (!ok.length) throw new Error('all ensemble members failed');
    if (ok.length === 1) return ok[0];

    let choice = 0;
    let judgeData = null;
    try {
      const judgeBody = {
        model: members[0],
        messages: [
          {
            role: 'system',
            content:
              'You are an impartial judge. Compare the candidate answers to the user request and pick the single best one — the most accurate, complete and helpful. Reply with ONLY the number of the best candidate.',
          },
          {
            role: 'user',
            content:
              'USER REQUEST:\n' +
              lastUserText(base.messages || []).slice(0, 4000) +
              '\n\n' +
              ok
                .map(
                  (d, i) =>
                    'CANDIDATE ' + (i + 1) + ':\n' + String(d.choices?.[0]?.message?.content || '').slice(0, 4000)
                )
                .join('\n\n') +
              '\n\nReply with only the number (1-' +
              ok.length +
              ').',
          },
        ],
      };
      const jr = await fetchUpstreamChat(judgeBody);
      if (jr.ok) {
        judgeData = await jr.json();
        const text = String(judgeData.choices?.[0]?.message?.content || '');
        const n = parseInt(String(text).match(/\d+/)?.[0] ?? '1', 10);
        if (n >= 1 && n <= ok.length) choice = n - 1;
      }
    } catch {
      /* judge failed — fall back to the first candidate */
    }
    const winner = ok[choice] || ok[0];
    const usage = sumUsage(judgeData ? [...ok, judgeData] : ok);
    return { ...winner, usage };
  }

  // 'race' (also the fallback for single-member 'best')
  const controllers = members.map(() => new AbortController());
  const attempts = members.map((m, i) =>
    fetchUpstreamChat({ ...base, model: m }, controllers[i].signal).then((r) =>
      r.ok ? r.json() : Promise.reject(new Error('upstream ' + r.status))
    )
  );
  try {
    const winner = await Promise.any(attempts);
    controllers.forEach((c) => {
      try {
        c.abort();
      } catch {
        /* already settled */
      }
    });
    return winner;
  } catch {
    throw new Error('all ensemble members failed');
  }
}

// Yields raw SSE events ("data: {...}") from a fetch Response body stream.
export async function* sseEvents(webStream) {
  const reader = webStream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      yield buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
    }
  }
  if (buffer.trim()) yield buffer;
}

// Extracts parsed JSON payloads from one raw SSE event ([DONE] is skipped).
export function parseSseData(rawEvent) {
  const out = [];
  for (const line of rawEvent.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try {
      out.push(JSON.parse(data));
    } catch {
      /* non-JSON event, ignore */
    }
  }
  return out;
}

// Streams an upstream OpenAI-format response to a client: rewrites the model
// back to its public id, optionally filters thinking output, taps usage.
// Returns { usage, completionLen, aborted }.
export async function pipeOpenAIStream({ upstream, res, publicModel, hideThinking, publicPromptTokens }) {
  const thinkFilter = hideThinking ? createThinkFilter() : null;
  let usage = null;
  let completionLen = 0;
  let aborted = false;

  const onClose = () => {
    aborted = true;
  };
  res.on('close', onClose);

  const flushChunk = (chunk) => {
    if (chunk.usage) usage = chunk.usage;
    chunk.model = publicModel;
    if (chunk.usage && Number.isFinite(Number(publicPromptTokens))) {
      const completionTokens = Number(chunk.usage.completion_tokens) || 0;
      chunk.usage = {
        ...chunk.usage,
        prompt_tokens: Number(publicPromptTokens),
        total_tokens: Number(publicPromptTokens) + completionTokens,
      };
    }
    const delta = chunk.choices?.[0]?.delta;
    if (thinkFilter && delta) {
      if (delta.reasoning_content !== undefined) delete delta.reasoning_content;
      if (delta.reasoning !== undefined) delete delta.reasoning;
      if (typeof delta.content === 'string' && delta.content.length) {
        const filtered = thinkFilter(delta.content);
        completionLen += filtered.length;
        if (filtered) delta.content = filtered;
        else delete delta.content;
      }
    } else if (typeof delta?.content === 'string') {
      completionLen += delta.content.length;
    }
    res.write('data: ' + JSON.stringify(chunk) + '\n\n');
  };

  try {
    for await (const raw of sseEvents(upstream.body)) {
      if (aborted) break;
      for (const chunk of parseSseData(raw)) flushChunk(chunk);
    }
  } catch (err) {
    console.error('Stream pipe error:', err.message);
  }

  if (thinkFilter && !aborted) {
    const tail = thinkFilter.flush();
    if (tail) {
      res.write(
        'data: ' +
          JSON.stringify({
            id: 'strax-tail',
            object: 'chat.completion.chunk',
            created: 1,
            model: publicModel,
            choices: [{ index: 0, delta: { content: tail }, finish_reason: null }],
          }) +
          '\n\n'
      );
    }
  }
  if (!aborted) res.write('data: [DONE]\n\n');
  res.end();
  res.off('close', onClose);

  return { usage, completionLen, aborted };
}
