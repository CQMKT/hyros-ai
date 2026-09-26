/**
 * Whop over plain `fetch` — connect, read one payment, verify a webhook.
 * Whop's hosted checkout does not document what it appends to a redirect,
 * so the thank-you page treats Whop as experimental: it reads `payment_id`
 * when present, and the webhook (`payment.succeeded`) is the reliable path
 * for the transaction log. WHOP_API_URL overrides the host for tests.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const whopUrl = () => process.env.WHOP_API_URL || 'https://api.whop.com/api/v1';
const fail = (message, status, code) => Object.assign(new Error(message), { status, code });

export async function whop(apiKey, method, path, body = null, { timeoutMs = 20000 } = {}) {
  if (!apiKey) throw fail('Whop is not connected.', 409, 'not_connected');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${whopUrl()}${path}`, { method, headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: ac.signal });
    const text = await res.text();
    let data = null; try { data = JSON.parse(text); } catch { data = null; }
    if (!res.ok) {
      const msg = data?.message || data?.error?.message || data?.error || text.slice(0, 200) || `HTTP ${res.status}`;
      if (res.status === 401 || res.status === 403) throw fail(`Whop rejected that API key (${String(msg).slice(0, 120)}). It needs payment:basic:read and member:email:read.`, 400, 'bad_key');
      if (res.status === 404) throw fail(String(msg), 404, 'whop_not_found');
      throw fail(`Whop answered HTTP ${res.status}: ${msg}`, 502, 'whop');
    }
    return data;
  } catch (err) {
    if (err.name === 'AbortError') throw fail('Whop did not answer in time.', 504, 'whop_timeout');
    throw err;
  } finally { clearTimeout(timer); }
}

export const probe = (apiKey) => whop(apiKey, 'GET', '/payments?per=1');

const money = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 100) : 0; };

/** A Whop payment object → the same transaction shape Stripe produces. */
export function normalizePayment(p) {
  const status = ['paid', 'succeeded', 'completed'].includes(String(p?.status || p?.substatus || '').toLowerCase()) || String(p?.substatus || '').toLowerCase() === 'succeeded' ? 'paid'
    : /fail|declin/i.test(String(p?.substatus || p?.status || '')) ? 'failed' : /refund/i.test(String(p?.substatus || p?.status || '')) ? 'refunded' : 'unpaid';
  const amount = p?.settlement_amount ?? p?.final_amount ?? p?.total ?? p?.amount ?? 0;
  return {
    source: 'whop', externalId: p?.id || null,
    email: String(p?.user?.email || p?.member?.email || p?.email || '').toLowerCase() || null,
    name: p?.user?.name || p?.user?.username || p?.member?.name || null, phone: p?.user?.phone || null,
    amountCents: Number.isInteger(amount) && amount > 1000 && !String(amount).includes('.') && p?.currency ? Math.round(amount) : money(amount),
    currency: String(p?.currency || 'usd').toLowerCase(), status, mode: p?.plan?.plan_type === 'renewal' ? 'subscription' : 'payment',
    paymentIntentId: null, subscriptionId: p?.membership?.id || p?.membership_id || null, customerId: p?.user?.id || null, paymentLinkId: p?.plan?.id || p?.plan_id || null,
    items: p?.product?.title ? [{ description: p.product.title, quantity: 1, amountCents: money(amount) }] : [], metadata: p?.metadata || {},
    created: p?.created_at ? new Date(p.created_at).toISOString() : new Date().toISOString(), livemode: true,
  };
}

export async function retrievePayment(apiKey, id) {
  if (!/^pay_[A-Za-z0-9]+$/.test(String(id || ''))) throw fail('That is not a Whop payment id.', 400, 'bad_request');
  return normalizePayment(await whop(apiKey, 'GET', `/payments/${encodeURIComponent(id)}`));
}

const safeEqual = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };
const SIG_HEADERS = ['x-whop-signature', 'whop-signature', 'x-signature', 'x-hub-signature', 'webhook-signature'];

/**
 * Whop signs deliveries with the webhook's secret (HMAC-SHA256). The header
 * name and framing are not spelled out in the docs, so accept the common
 * shapes: a bare hex/base64 HMAC of the body, `sha256=<hex>`, or the
 * Standard-Webhooks form (`v1,<base64>` over "<id>.<timestamp>.<body>").
 * `header` in the result says which one matched, so it can be pinned later.
 */
export function verifySignature(headers, rawBody, secret, { now = Date.now(), toleranceS = 300 } = {}) {
  if (!secret) return { ok: false, reason: 'no webhook secret saved' };
  const present = SIG_HEADERS.filter((h) => headers[h]);
  if (!present.length) return { ok: false, reason: `no signature header (seen: ${Object.keys(headers).filter((h) => /sign|hmac/i.test(h)).join(', ') || 'none'})` };
  const hex = createHmac('sha256', String(secret)).update(rawBody).digest('hex');
  const b64 = createHmac('sha256', String(secret)).update(rawBody).digest('base64');
  for (const h of present) {
    const raw = String(headers[h]).trim();
    const bare = raw.replace(/^sha256=/i, '');
    if (safeEqual(bare, hex) || safeEqual(bare, b64)) return { ok: true, header: h };
    const id = headers['webhook-id']; const ts = headers['webhook-timestamp'];
    if (id && ts && Math.abs(now / 1000 - Number(ts)) <= toleranceS) {
      const key = String(secret).startsWith('whsec_') ? Buffer.from(String(secret).slice(6), 'base64') : String(secret);
      const exp = createHmac('sha256', key).update(`${id}.${ts}.${rawBody}`).digest('base64');
      if (raw.split(' ').map((s) => s.split(',')[1] || s).some((s) => safeEqual(s, exp))) return { ok: true, header: h };
    }
  }
  return { ok: false, reason: `signature mismatch (${present.join(', ')})` };
}

/** The payment inside a webhook envelope, whatever Whop calls the wrapper. */
export function paymentFromEvent(event) {
  const type = String(event?.action || event?.type || event?.event || '');
  const data = event?.data?.object || event?.data || event?.payload || null;
  return { type, payment: data && typeof data === 'object' ? data : null };
}
