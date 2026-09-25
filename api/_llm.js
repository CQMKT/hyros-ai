/**
 * The LLM leg — one plain `fetch` to the Anthropic Messages API, no SDK
 * (this template ships zero dependencies). The key comes from the account's
 * integrations (api/_integrations.js), never from the environment, so setup
 * stays env-var-free.
 *
 *   complete({ apiKey, system, user, schema })  -> { json | text, usage, model }
 *   probeKey(apiKey)                             -> validates a key with a tiny request
 *
 * Structured output: when `schema` is given the request asks for
 * `output_config.format = { type: 'json_schema', schema }`, so the reply is
 * guaranteed to parse and match. Thinking is adaptive; `effort` trades depth
 * for cost. Errors carry `code` ∈ llm_auth | llm_rate_limited |
 * llm_bad_request | llm_unavailable | llm_refusal | llm_truncated |
 * llm_bad_json | llm_timeout so a caller can say what to do.
 *
 * LLM_API_URL overrides the endpoint (tests run against scripts/mock-llm.mjs).
 */

export const DEFAULT_MODEL = 'claude-opus-5';
export const API_URL = 'https://api.anthropic.com/v1/messages';
export const API_VERSION = '2023-06-01';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export function llmUrl() {
  return process.env.LLM_API_URL || API_URL;
}

export class LlmError extends Error {
  constructor(message, code, status = null, detail = null) {
    super(message);
    this.name = 'LlmError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

const CODE_BY_STATUS = { 401: 'llm_auth', 403: 'llm_auth', 429: 'llm_rate_limited', 400: 'llm_bad_request', 413: 'llm_bad_request', 529: 'llm_unavailable' };

async function post(body, { apiKey, timeoutMs, fallback }) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const headers = { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': API_VERSION };
  const payload = { ...body };
  if (fallback) { headers['anthropic-beta'] = FALLBACK_BETA; payload.fallbacks = 'default'; }
  let res;
  try {
    res = await fetch(llmUrl(), { method: 'POST', headers, body: JSON.stringify(payload), signal: ac.signal });
  } catch (err) {
    throw new LlmError(err.name === 'AbortError' ? `The model did not answer within ${Math.round(timeoutMs / 1000)} s.` : `Could not reach the model API: ${err.message}`, err.name === 'AbortError' ? 'llm_timeout' : 'llm_unavailable');
  } finally { clearTimeout(timer); }
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = null; }
  if (!res.ok) {
    const msg = data?.error?.message || text.slice(0, 300) || `HTTP ${res.status}`;
    const code = CODE_BY_STATUS[res.status] || (res.status >= 500 ? 'llm_unavailable' : 'llm_error');
    throw new LlmError(code === 'llm_auth' ? 'The model API rejected the key — check the Anthropic API key in Setup → Integrations.' : msg, code, res.status, msg);
  }
  if (!data) throw new LlmError('The model API answered with something that is not JSON.', 'llm_bad_json', res.status, text.slice(0, 200));
  return data;
}

/**
 * One completion. `user` is the prompt text (or an array of content blocks);
 * `schema` (JSON Schema, every object with additionalProperties:false and a
 * full `required` list) turns on structured output and makes the result
 * available as `json`.
 */
export async function complete({ apiKey, model = DEFAULT_MODEL, system = '', user, schema = null, maxTokens = 16000, effort = 'high', timeoutMs = 170000, fallback = true } = {}) {
  if (!apiKey) throw new LlmError('No model API key is connected for this account.', 'llm_auth', 401);
  const body = {
    model: model || DEFAULT_MODEL,
    max_tokens: maxTokens,
    thinking: { type: 'adaptive' },
    output_config: { effort, ...(schema ? { format: { type: 'json_schema', schema } } : {}) },
    ...(system ? { system } : {}),
    messages: [{ role: 'user', content: user }],
  };
  let data;
  try {
    data = await post(body, { apiKey, timeoutMs, fallback });
  } catch (err) {
    // The fallback beta is optional: a 400 that names it means this key or
    // endpoint does not take it — retry once without, same request otherwise.
    if (fallback && err.code === 'llm_bad_request' && /fallback/i.test(err.detail || err.message)) data = await post(body, { apiKey, timeoutMs, fallback: false });
    else throw err;
  }
  const stopReason = data.stop_reason || null;
  if (stopReason === 'refusal') throw new LlmError(`The model declined to analyze this transcript${data.stop_details?.category ? ` (${data.stop_details.category})` : ''}.`, 'llm_refusal', 200, data.stop_details?.explanation || null);
  const text = (Array.isArray(data.content) ? data.content : []).filter((c) => c.type === 'text').map((c) => c.text).join('');
  if (stopReason === 'max_tokens') throw new LlmError('The analysis was cut off (max_tokens) — the transcript is too long for one pass.', 'llm_truncated', 200);
  let json = null;
  if (schema) {
    try { json = JSON.parse(text); }
    catch { throw new LlmError('The model answered with invalid JSON.', 'llm_bad_json', 200, text.slice(0, 200)); }
  }
  return { json, text, usage: data.usage || null, model: data.model || body.model, stopReason };
}

/** Validate an API key with the cheapest possible request. Throws LlmError (llm_auth) on a bad key. */
export async function probeKey(apiKey, { model = DEFAULT_MODEL } = {}) {
  const data = await post({ model, max_tokens: 8, messages: [{ role: 'user', content: 'Reply with the single word: ok' }] }, { apiKey, timeoutMs: 30000, fallback: false });
  return { ok: true, model: data.model || model };
}
