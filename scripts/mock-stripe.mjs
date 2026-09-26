/**
 * A mock of the Stripe endpoints Payment Links use (STRIPE_API_URL points
 * api/_stripe.js here): products, prices, payment_links (+ line_items),
 * checkout/sessions/{id}, webhook_endpoints. Form bodies are decoded into
 * nested objects; every request is recorded in `requests`; `mock.sessions`
 * holds the Checkout Sessions the mock can answer; `mock.failNext` injects
 * one failure. Key `sk_test_mock` works; `sk_test_dead` is refused.
 */
import { createServer } from 'node:http';

export const requests = [];
export const mock = {
  sessions: {},       // id → Checkout Session object
  links: [],          // existing payment links (for import)
  failNext: null,     // { status, message }
  reset() { this.sessions = {}; this.links = []; this.failNext = null; requests.length = 0; counter = 0; },
};
let counter = 0;
const nextId = (prefix) => `${prefix}_${String(++counter).padStart(4, '0')}`;

/** `a[b][0][c]=v` → nested object/arrays. */
export function decodeForm(body) {
  const out = {};
  for (const pair of String(body || '').split('&').filter(Boolean)) {
    const [k, v] = pair.split('=').map((s) => decodeURIComponent(s.replace(/\+/g, ' ')));
    const keys = k.replace(/\]/g, '').split('[');
    let cur = out;
    keys.forEach((key, i) => {
      const last = i === keys.length - 1;
      const nextIsIndex = !last && /^\d*$/.test(keys[i + 1]);
      if (last) { if (Array.isArray(cur)) cur.push(v); else cur[key] = v; return; }
      const slot = Array.isArray(cur) ? Number(key) : key;
      if (cur[slot] === undefined) cur[slot] = nextIsIndex ? [] : {};
      cur = cur[slot];
    });
  }
  return out;
}

export function checkoutSession(over = {}) {
  return {
    id: over.id || `cs_test_${nextId('s')}`, object: 'checkout.session', livemode: false, mode: 'payment', status: 'complete', payment_status: 'paid',
    amount_total: 100, amount_subtotal: 100, currency: 'usd', created: Math.floor(Date.now() / 1000),
    customer_details: { email: 'buyer@example.test', name: 'Buyer One', phone: null }, customer_email: null, customer: 'cus_mock', payment_intent: 'pi_mock', subscription: null,
    payment_link: 'plink_mock', metadata: {}, line_items: { data: [{ description: 'Vincent test product', quantity: 1, amount_total: 100, price: { unit_amount: 100, currency: 'usd', recurring: null } }] },
    ...over,
  };
}

export function startMockStripe(port = 4327) {
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    const url = new URL(req.url, 'http://x');
    const body = req.method === 'GET' ? Object.fromEntries(url.searchParams) : decodeForm(raw);
    requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, auth: req.headers.authorization || null });
    const reply = (status, payload) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); };
    const auth = String(req.headers.authorization || '');
    if (auth !== 'Bearer sk_test_mock') return reply(401, { error: { type: 'invalid_request_error', message: 'Invalid API Key provided' } });
    if (mock.failNext) { const f = mock.failNext; mock.failNext = null; return reply(f.status || 500, { error: { message: f.message || `injected ${f.status}` } }); }
    const p = url.pathname;
    if (req.method === 'GET' && p === '/v1/payment_links') return reply(200, { object: 'list', data: mock.links, has_more: false });
    if (req.method === 'POST' && p === '/v1/products') return reply(200, { id: nextId('prod'), object: 'product', name: body.name, metadata: body.metadata || {} });
    if (req.method === 'POST' && p === '/v1/prices') return reply(200, { id: nextId('price'), object: 'price', unit_amount: Number(body.unit_amount), currency: body.currency, product: body.product, recurring: body.recurring || null });
    if (req.method === 'POST' && p === '/v1/payment_links') {
      const link = { id: nextId('plink'), object: 'payment_link', url: `https://buy.stripe.com/test_${nextId('u')}`, active: true, after_completion: body.after_completion || { type: 'hosted_confirmation' }, metadata: body.metadata || {}, line_items_input: body.line_items };
      mock.links.push(link);
      return reply(200, link);
    }
    let m = p.match(/^\/v1\/payment_links\/([^/]+)\/line_items$/);
    if (req.method === 'GET' && m) {
      const link = mock.links.find((l) => l.id === m[1]);
      if (!link) return reply(404, { error: { message: `No such payment_link: ${m[1]}` } });
      return reply(200, { object: 'list', data: link.line_items || [{ description: 'Imported product', quantity: 1, amount_total: 4900, currency: 'usd', price: { unit_amount: 4900, currency: 'usd', recurring: null } }] });
    }
    m = p.match(/^\/v1\/payment_links\/([^/]+)$/);
    if (req.method === 'POST' && m) {
      const link = mock.links.find((l) => l.id === m[1]);
      if (!link) return reply(404, { error: { message: `No such payment_link: ${m[1]}` } });
      if (body.after_completion) link.after_completion = body.after_completion;
      if (body.active !== undefined) link.active = body.active === 'true';
      return reply(200, link);
    }
    m = p.match(/^\/v1\/checkout\/sessions\/([^/]+)$/);
    if (req.method === 'GET' && m) {
      const s = mock.sessions[m[1]];
      if (!s) return reply(404, { error: { type: 'invalid_request_error', message: `No such checkout.session: '${m[1]}'` } });
      return reply(200, url.searchParams.getAll('expand[0]').includes('line_items') || raw.includes('line_items') || url.search.includes('line_items') ? s : { ...s, line_items: undefined });
    }
    if (req.method === 'POST' && p === '/v1/webhook_endpoints') return reply(200, { id: nextId('we'), object: 'webhook_endpoint', url: body.url, enabled_events: body.enabled_events, secret: `whsec_mock_${nextId('k')}` });
    m = p.match(/^\/v1\/webhook_endpoints\/([^/]+)$/);
    if (req.method === 'DELETE' && m) return reply(200, { id: m[1], deleted: true });
    reply(404, { error: { message: `mock: no route ${req.method} ${p}` } });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startMockStripe().then(() => console.log('mock Stripe on http://127.0.0.1:4327/'));
}
