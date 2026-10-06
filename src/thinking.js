// Strips chain-of-thought output from model responses: the `reasoning_content`
// field (DeepSeek/Kimi style) and `<think>...</think>` blocks (Qwen style),
// both in complete responses and in streaming deltas.

const OPEN = '<think>';
const CLOSE = '</think>';

export function stripThinkTags(text) {
  if (typeof text !== 'string' || !text.includes('<')) return text;
  return text
    .replace(new RegExp(`${OPEN}[\\s\\S]*?${CLOSE}`, 'g'), '')
    .replace(new RegExp(`${OPEN}[\\s\\S]*$`, ''), '') // unterminated tail (truncated response)
    .trim();
}

export function stripThinkingFromResponse(data) {
  for (const choice of data?.choices || []) {
    const msg = choice.message;
    if (!msg) continue;
    if (msg.reasoning_content !== undefined) delete msg.reasoning_content;
    if (typeof msg.content === 'string') msg.content = stripThinkTags(msg.content);
    if (msg.reasoning !== undefined) delete msg.reasoning;
  }
  if (data && data.reasoning_content !== undefined) delete data.reasoning_content;
  return data;
}

// Stateful filter for streamed text deltas: buffers a small tail so tags split
// across chunks are still detected. Leading whitespace before the first
// visible character is dropped (parity with the trimmed complete response).
export function createThinkFilter() {
  let inThink = false;
  let carry = '';
  let started = false;

  const lstrip = (text) => {
    if (started) return text;
    const stripped = text.replace(/^\s+/, '');
    if (stripped) started = true;
    return stripped;
  };

  const push = (text) => {
    carry += text;
    let out = '';
    for (;;) {
      if (!inThink) {
        const i = carry.indexOf(OPEN);
        if (i !== -1) {
          out += carry.slice(0, i);
          carry = carry.slice(i + OPEN.length);
          inThink = true;
          continue;
        }
        // Emit everything except a tail that might be a partial opening tag.
        const keep = Math.min(OPEN.length - 1, carry.length);
        if (carry.length > keep) {
          out += carry.slice(0, carry.length - keep);
          carry = carry.slice(carry.length - keep);
        }
        break;
      }
      const j = carry.indexOf(CLOSE);
      if (j !== -1) {
        carry = carry.slice(j + CLOSE.length);
        inThink = false;
        continue;
      }
      // Discard thinking text but keep a tail that might be a partial closing tag.
      const keep = Math.min(CLOSE.length - 1, carry.length);
      carry = carry.slice(carry.length - keep);
      break;
    }
    return lstrip(out);
  };

  push.flush = () => {
    const rest = inThink ? '' : carry;
    carry = '';
    return lstrip(rest);
  };

  return push;
}
