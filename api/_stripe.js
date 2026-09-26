/**
 * Stripe over plain `fetch` — the handful of endpoints Payment Links need,
 * no SDK (this template ships zero dependencies). Form-encoded bodies with
 * Stripe's bracket notation (`after_completion[redirect][url]`,
 * `line_items[0][price]`), Bearer auth, typed errors:
 *
 *   bad_key            401 (wrong key) / 403 (restricted key missing a permission)
 *   stripe_not_found   404
 *   stripe             anything else Stripe refused
 *   stripe_timeout     no answer in time
 *
 * STRIPE_API_URL overrides the host (tests run against scripts/mock-stripe.mjs).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const stripeUrl = () => process.env.STRIPE_API_URL || 'https://api.stripe.com';
const fail = (message, status, code) => Object.assign(new Error(message), { status, code });

/** Nested object → Stripe form encoding (`a[b][0][c]=v`). */
export function encodeForm(value, prefix = '', out = []) {
  if (value === null || value === undefined) return out;
  if (Array.isArray(value)) { value.forEach((v, i) => encodeForm(v, `${prefix}[${i}]`, out)); return out; }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) encodeForm(v, prefix ? `${prefix}[${k}]` : k, out);
    return out;
  }
  out.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(String(value))}`);
  return out;
}

export async function stripe(apiKey, method, path, params = null, { timeoutMs = 20000 } = {}) {
  if (!apiKey) throw fail('Stripe is not connected.', 409, 'not_connected');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const encoded = params ? encodeForm(params).join('&') : '';
  const url = `${stripeUrl()}${path}${method === 'GET' && encoded ? `?${encoded}` : ''}`;
  try {
    const res = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${apiKey}`, ...(method !== 'GET' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      body: method !== 'GET' && encoded ? encoded : undefined,
      signal: ac.signal,
    });
    const text = await res.text();
    let data = null; try { data = JSON.parse(text); } catch { data = null; }
    if (!res.ok) {
      const msg = data?.error?.message || text.slice(0, 200) || `HTTP ${res.status}`;
      if (res.status === 401) throw fail('Stripe rejected that API key.', 400, 'bad_key');
      if (res.status === 403) throw fail(`Stripe refused: ${msg} — the key needs write access to Products, Prices, Payment Links, Webhook Endpoints and read access to Checkout Sessions.`, 400, 'bad_key');
      if (res.status === 404) throw fail(msg, 404, 'stripe_not_found');
      throw fail(`Stripe answered HTTP ${res.status}: ${msg}`, 502, 'stripe');
    }
    return data;
  } catch (err) {
    if (err.name === 'AbortError') throw fail('Stripe did not answer in time.', 504, 'stripe_timeout');
    throw err;
  } finally { clearTimeout(timer); }
}

/** The cheapest call that proves the key works and can see payment links. */
export const probe = (apiKey) => stripe(apiKey, 'GET', '/v1/payment_links', { limit: 1 });

export async function listPaymentLinks(apiKey, { limit = 100, active = null } = {}) {
  const out = [];
  let startingAfter = null;
  for (let page = 0; page < 5; page += 1) {
    const params = { limit: Math.min(100, limit), ...(active === null ? {} : { active }), ...(startingAfter ? { starting_after: startingAfter } : {}) };
    const r = await stripe(apiKey, 'GET', '/v1/payment_links', params);
    out.push(...(r?.data || []));
    if (!r?.has_more || out.length >= limit) break;
    startingAfter = out[out.length - 1]?.id;
  }
  return out;
}

export async function paymentLinkLineItems(apiKey, id) {
  const r = await stripe(apiKey, 'GET', `/v1/payment_links/${encodeURIComponent(id)}/line_items`, { limit: 10 });
  return (r?.data || []).map((li) => ({
    description: li.description || li.price?.product?.name || null, quantity: li.quantity || 1,
    amountCents: Number(li.amount_total ?? li.price?.unit_amount ?? 0) || 0, currency: (li.currency || li.price?.currency || 'usd').toLowerCase(),
    interval: li.price?.recurring?.interval || null,
  }));
}

/** The thank-you URL Stripe redirects to; Stripe fills the session id in. */
export const redirectUrlFor = (base, token) => `${String(base).replace(/\/$/, '')}/ty?l=${token}&session_id={CHECKOUT_SESSION_ID}`;

/** Product → price → payment link, the redirect pointed at our page. */
export async function createPaymentLink(apiKey, { name, description = '', amountCents, currency = 'usd', interval = null, redirectUrl, token }) {
  const product = await stripe(apiKey, 'POST', '/v1/products', { name, ...(description ? { description } : {}), metadata: { aihyros_link: token } });
  const price = await stripe(apiKey, 'POST', '/v1/prices', { unit_amount: amountCents, currency, product: product.id, ...(interval ? { recurring: { interval } } : {}) });
  const link = await stripe(apiKey, 'POST', '/v1/payment_links', {
    line_items: [{ price: price.id, quantity: 1 }],
    after_completion: { type: 'redirect', redirect: { url: redirectUrl } },
    metadata: { aihyros_link: token },
  });
  return { id: link.id, url: link.url, productId: product.id, priceId: price.id, active: link.active !== false };
}

export const setRedirect = (apiKey, id, url) => stripe(apiKey, 'POST', `/v1/payment_links/${encodeURIComponent(id)}`, { after_completion: { type: 'redirect', redirect: { url } } });
export const setActive = (apiKey, id, active) => stripe(apiKey, 'POST', `/v1/payment_links/${encodeURIComponent(id)}`, { active: active ? 'true' : 'false' });

const isoOf = (unix) => (Number.isFinite(Number(unix)) ? new Date(Number(unix) * 1000).toISOString() : new Date().toISOString());

/** A Checkout Session, normalized to what the page and the log need. */
export function normalizeSession(s) {
  const items = (s?.line_items?.data || []).map((li) => ({ description: li.description || li.price?.product?.name || null, quantity: li.quantity || 1, amountCents: Number(li.amount_total ?? 0) || 0 }));
  const status = s?.payment_status === 'paid' ? 'paid' : s?.payment_status === 'no_payment_required' ? 'paid' : s?.status === 'expired' ? 'expired' : 'unpaid';
  return {
    externalId: s?.id || null,
    email: (s?.customer_details?.email || s?.customer_email || '').toLowerCase() || null,
    name: s?.customer_details?.name || null, phone: s?.customer_details?.phone || null,
    amountCents: Number(s?.amount_total ?? 0) || 0, currency: String(s?.currency || 'usd').toLowerCase(),
    status, mode: s?.mode || null,
    paymentIntentId: typeof s?.payment_intent === 'string' ? s.payment_intent : s?.payment_intent?.id || null,
    subscriptionId: typeof s?.subscription === 'string' ? s.subscription : s?.subscription?.id || null,
    customerId: typeof s?.customer === 'string' ? s.customer : s?.customer?.id || null,
    paymentLinkId: typeof s?.payment_link === 'string' ? s.payment_link : s?.payment_link?.id || null,
    items, metadata: s?.metadata || {}, created: isoOf(s?.created), livemode: Boolean(s?.livemode),
  };
}

export async function retrieveCheckoutSession(apiKey, id) {
  if (!/^cs_(live|test)_[A-Za-z0-9]+$/.test(String(id || ''))) throw fail('That is not a Checkout Session id.', 400, 'bad_request');
  return normalizeSession(await stripe(apiKey, 'GET', `/v1/checkout/sessions/${encodeURIComponent(id)}`, { expand: ['line_items'] }));
}

export const WEBHOOK_EVENTS = ['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed', 'payment_intent.payment_failed', 'invoice.payment_failed', 'charge.refunded'];

export async function createWebhookEndpoint(apiKey, url, events = WEBHOOK_EVENTS) {
  const r = await stripe(apiKey, 'POST', '/v1/webhook_endpoints', { url, enabled_events: events, description: 'AI HYROS Payment Links' });
  return { id: r.id, secret: r.secret || null };
}
export const deleteWebhookEndpoint = (apiKey, id) => stripe(apiKey, 'DELETE', `/v1/webhook_endpoints/${encodeURIComponent(id)}`);

const safeEqual = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };

/** `Stripe-Signature: t=<unix>,v1=<hex>[,v1=…]` — HMAC-SHA256 over "<t>.<raw body>" with the endpoint secret. */
export function verifySignature(header, rawBody, secret, { now = Date.now(), toleranceS = 300 } = {}) {
  if (!header || !secret) return { ok: false, reason: 'missing signature' };
  const parts = Object.create(null);
  for (const kv of String(header).split(',')) { const [k, v] = kv.split('=').map((s) => s.trim()); if (k === 'v1') (parts.v1 ||= []).push(v); else parts[k] = v; }
  if (!parts.t || !parts.v1?.length) return { ok: false, reason: 'malformed signature' };
  if (Math.abs(now / 1000 - Number(parts.t)) > toleranceS) return { ok: false, reason: 'timestamp outside tolerance' };
  const expected = createHmac('sha256', String(secret)).update(`${parts.t}.${rawBody}`).digest('hex');
  return parts.v1.some((v) => safeEqual(v, expected)) ? { ok: true } : { ok: false, reason: 'signature mismatch' };
}

/** A webhook event → the transaction it describes (null for events we do not log). */
export function txFromEvent(event) {
  const type = String(event?.type || '');
  const o = event?.data?.object || {};
  if (type.startsWith('checkout.session.')) {
    const tx = normalizeSession(o);
    if (type === 'checkout.session.async_payment_failed') tx.status = 'failed';
    return { ...tx, source: 'stripe', event: type };
  }
  if (type === 'payment_intent.payment_failed') {
    return { source: 'stripe', event: type, externalId: o.id, email: (o.receipt_email || o.last_payment_error?.payment_method?.billing_details?.email || '').toLowerCase() || null, name: null, phone: null,
      amountCents: Number(o.amount || 0), currency: String(o.currency || 'usd').toLowerCase(), status: 'failed', mode: 'payment', paymentIntentId: o.id, subscriptionId: null, customerId: typeof o.customer === 'string' ? o.customer : null,
      paymentLinkId: null, items: [], metadata: o.metadata || {}, created: isoOf(o.created), livemode: Boolean(o.livemode), failure: o.last_payment_error?.message || 'payment failed' };
  }
  if (type === 'invoice.payment_failed') {
    return { source: 'stripe', event: type, externalId: o.id, email: String(o.customer_email || '').toLowerCase() || null, name: o.customer_name || null, phone: null,
      amountCents: Number(o.amount_due || 0), currency: String(o.currency || 'usd').toLowerCase(), status: 'failed', mode: 'subscription', paymentIntentId: typeof o.payment_intent === 'string' ? o.payment_intent : null,
      subscriptionId: typeof o.subscription === 'string' ? o.subscription : null, customerId: typeof o.customer === 'string' ? o.customer : null, paymentLinkId: null, items: [], metadata: o.metadata || {}, created: isoOf(o.created), livemode: Boolean(o.livemode), failure: 'invoice payment failed' };
  }
  if (type === 'charge.refunded') {
    return { source: 'stripe', event: type, externalId: typeof o.payment_intent === 'string' ? o.payment_intent : o.id, email: String(o.billing_details?.email || o.receipt_email || '').toLowerCase() || null, name: o.billing_details?.name || null, phone: null,
      amountCents: Number(o.amount || 0), currency: String(o.currency || 'usd').toLowerCase(), status: 'refunded', mode: 'payment', paymentIntentId: typeof o.payment_intent === 'string' ? o.payment_intent : null, subscriptionId: null, customerId: typeof o.customer === 'string' ? o.customer : null,
      paymentLinkId: null, items: [], metadata: o.metadata || {}, created: isoOf(o.created), livemode: Boolean(o.livemode), refundedCents: Number(o.amount_refunded || 0) };
  }
  return null;
}
