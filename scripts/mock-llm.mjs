/**
 * A mock of the model API for tests (LLM_API_URL points api/_llm.js here).
 * Answers every structured request with a document GENERATED FROM THE
 * SCHEMA IT WAS SENT (enum → first value, integer → 7, string → "mock",
 * array → one item, anyOf → the first non-null branch), overlaid with
 * `mock.answer` so a test can pin specific fields. Unstructured requests
 * get "ok". `x-api-key: dead-llm-key` is refused with 401; `mock.failNext`
 * injects one HTTP failure. Every request is recorded in `requests`.
 */
import { createServer } from 'node:http';

export const requests = [];
export const mock = {
  answer: null,        // object merged over the generated document (deep, by key)
  failNext: null,      // { status, body }
  refuseNext: false,   // reply with stop_reason: refusal once
  truncateNext: false, // reply with stop_reason: max_tokens once
  reset() { this.answer = null; this.failNext = null; this.refuseNext = false; this.truncateNext = false; requests.length = 0; },
};

export function sample(schema, path = '') {
  if (!schema || typeof schema !== 'object') return null;
  if (Array.isArray(schema.anyOf)) return sample(schema.anyOf.find((s) => s.type !== 'null') || schema.anyOf[0], path);
  if (Array.isArray(schema.enum)) return schema.enum[0];
  switch (schema.type) {
    case 'object': return Object.fromEntries(Object.entries(schema.properties || {}).map(([k, v]) => [k, sample(v, `${path}.${k}`)]));
    case 'array': return [sample(schema.items, `${path}[]`)];
    case 'integer': case 'number': return 7;
    case 'boolean': return true;
    case 'null': return null;
    default: return `mock ${path.split('.').pop() || 'text'}`;
  }
}

function overlay(base, over) {
  if (over === undefined || over === null) return base;
  if (Array.isArray(over) || base === null || typeof base !== 'object' || typeof over !== 'object' || over === null) return over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = overlay(base[k], v);
  return out;
}

export function startMockLlm(port = 4323) {
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}');
    requests.push({ headers: req.headers, body });
    const reply = (status, payload) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); };
    if (req.headers['x-api-key'] === 'dead-llm-key') return reply(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
    if (mock.failNext) { const f = mock.failNext; mock.failNext = null; return reply(f.status, f.body ?? { type: 'error', error: { type: 'api_error', message: `injected ${f.status}` } }); }
    const schema = body.output_config?.format?.schema;
    if (mock.refuseNext) { mock.refuseNext = false; return reply(200, { id: 'msg_mock', model: body.model, stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'test' }, content: [], usage: { input_tokens: 10, output_tokens: 0 } }); }
    if (mock.truncateNext) { mock.truncateNext = false; return reply(200, { id: 'msg_mock', model: body.model, stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"partial":' }], usage: { input_tokens: 10, output_tokens: 5 } }); }
    const text = schema ? JSON.stringify(overlay(sample(schema), mock.answer)) : 'ok';
    const input = Math.ceil(JSON.stringify(body.messages).length / 4);
    return reply(200, { id: 'msg_mock', model: body.model, stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: input, output_tokens: Math.ceil(text.length / 4) } });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startMockLlm().then(() => console.log('mock LLM on http://127.0.0.1:4323/'));
}
