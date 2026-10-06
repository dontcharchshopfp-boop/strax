// Rough token estimate used only when the upstream does not report usage
// (can happen with streaming). ~4 chars per token is the common heuristic.
export function estimateTokens(reqBody, completionText) {
  const promptChars = JSON.stringify(reqBody?.messages || []).length;
  const completionChars = (completionText || '').length;
  return Math.ceil(promptChars / 4) + Math.ceil(completionChars / 4);
}
