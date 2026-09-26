/**
 * POST /api/ingest?src=fathom|fireflies&t=<token> — the note-taker webhook.
 *
 * Public by design (vendors call it), protected by two things: the token in
 * the URL (random, per integration, maps to one account) and the vendor's
 * signature over the RAW body (Fathom: Standard Webhooks headers; Fireflies:
 * x-hub-signature). Anything that fails either check is refused.
 *
 * Fathom sends the whole meeting (transcript included when the webhook was
 * registered with include_transcript). Fireflies sends only { meetingId,
 * eventType }; the transcript is pulled from their GraphQL API.
 *
 * The call is stored as `queued` and the vendor gets its 200 at once; the
 * analysis then runs in the same invocation through Vercel's waitUntil (no
 * package — the request-context symbol is what @vercel/functions reads).
 * Without waitUntil (local dev) the analysis runs before the response.
 * Redeliveries are harmless: the id is derived from the vendor's id.
 */
import { findByToken, verifyFathom, verifyFireflies, callFromFathom, fetchFirefliesCall, noteEvent, integrationKey } from './_integrations.js';
import { decryptKey } from './_accounts.js';
import { saveNewCall } from './_calls.js';
import { analyzeCall } from './_analyze.js';
import { storeConfigured, storeReadOnly } from './_store.js';
import { REFRESH_MAX_S } from './_budget.js';
import { logEvent } from './_log.js';
import { verifySignature as verifyStripe, txFromEvent } from './_stripe.js';
import { verifySignature as verifyWhop, paymentFromEvent, normalizePayment, retrievePayment } from './_whop.js';
import { readLinks, recordTransaction, readSettings, notify } from './_paylinks.js';

/**
 * Stripe / Whop deliveries: verify, turn the event into a transaction, store
 * it next to what the thank-you page recorded (same id → merged). Failed
 * payments are logged as their own rows so the dashboard can list them.
 */
async function handlePayment({ src, accountId, integration, headers, body, res }) {
  const secret = integration.secretEnc ? decryptKey(integration.secretEnc) : null;
  const verdict = src === 'stripe' ? verifyStripe(headers['stripe-signature'], body, secret) : verifyWhop(headers, body, secret);
  if (!verdict.ok) {
    await noteEvent(accountId, integration.id, { error: `Rejected a delivery: ${verdict.reason}` });
    logEvent('ingest.rejected', { accountId, src, reason: verdict.reason });
    return res.status(401).json({ ok: false, error: 'bad_signature', reason: verdict.reason });
  }
  let payload;
  try { payload = JSON.parse(body || '{}'); } catch { return res.status(400).json({ ok: false, error: 'bad_json' }); }
  let tx = null;
  try {
    if (src === 'stripe') tx = txFromEvent(payload);
    else {
      const { type, payment } = paymentFromEvent(payload);
      if (!/payment|succeed|paid/i.test(type) && !payment) return res.status(200).json({ ok: true, ignored: `event ${type || 'unknown'}` });
      if (payment?.id && (!payment.user?.email && !payment.email)) { const key = await integrationKey(accountId, 'whop'); tx = key ? await retrievePayment(key, payment.id) : normalizePayment(payment); }
      else tx = payment ? normalizePayment(payment) : null;
      if (tx) tx.event = type || 'payment.succeeded';
    }
  } catch (err) {
    await noteEvent(accountId, integration.id, { error: err.message });
    return res.status(502).json({ ok: false, error: err.code || 'vendor', message: err.message });
  }
  if (!tx) return res.status(200).json({ ok: true, ignored: `event ${payload.type || payload.action || 'unknown'}` });
  const links = await readLinks(accountId);
  const link = links.find((l) => (tx.metadata?.aihyros_link && l.token === tx.metadata.aihyros_link) || (tx.paymentLinkId && (l.stripeId === tx.paymentLinkId || l.whopPlanId === tx.paymentLinkId))) || null;
  const { tx: stored, created } = await recordTransaction(accountId, tx, { via: 'webhook', linkId: link?.id || null, linkToken: link?.token || null });
  await noteEvent(accountId, integration.id);
  logEvent('ingest.payment', { accountId, src, event: tx.event, txId: stored.id, status: stored.status, created, linked: Boolean(link) });
  if (created && (stored.status === 'paid' || stored.status === 'failed')) { try { await notify(await readSettings(accountId), stored, { linkName: link?.name || null }); } catch { /* best effort */ } }
  return res.status(200).json({ ok: true, id: stored.id, status: stored.status, duplicate: !created });
}

export const maxDuration = REFRESH_MAX_S;
/** The raw bytes are needed for the HMAC — keep Vercel's body parser out of the way. */
export const config = { api: { bodyParser: false } };

/** The request body as sent: the stream when it is still there, else what the platform parsed. */
export async function rawBody(req) {
  if (typeof req.body === 'string') return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  if (req.body && typeof req.body === 'object' && !req.readable) return JSON.stringify(req.body);
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

/** Vercel's waitUntil when the runtime offers it (Fluid compute), else null. */
export function waitUntilFn() {
  try {
    const ctx = globalThis[Symbol.for('@vercel/request-context')];
    const wu = ctx?.get?.()?.waitUntil;
    return typeof wu === 'function' ? wu : null;
  } catch { return null; }
}

const lowerHeaders = (req) => Object.fromEntries(Object.entries(req.headers || {}).map(([k, v]) => [String(k).toLowerCase(), Array.isArray(v) ? v[0] : v]));

export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  const url = new URL(req.url, `http://${req.headers.host || 'local'}`);
  const src = url.searchParams.get('src');
  const token = url.searchParams.get('t');
  if (!['fathom', 'fireflies', 'stripe', 'whop'].includes(src)) return res.status(400).json({ ok: false, error: 'bad_request' });
  if (!storeConfigured()) return res.status(503).json({ ok: false, error: 'needs_storage' });
  if (storeReadOnly()) return res.status(200).json({ ok: true, ignored: 'preview deployment (read-only)' });

  const found = await findByToken(token);
  if (!found || found.integration.kind !== src) return res.status(404).json({ ok: false, error: 'unknown_webhook' });
  const { accountId, integration } = found;
  const body = await rawBody(req);
  const headers = lowerHeaders(req);
  if (src === 'stripe' || src === 'whop') return handlePayment({ src, accountId, integration, headers, body, res });

  const secret = integration.secretEnc ? decryptKey(integration.secretEnc) : null;
  const verdict = src === 'fathom' ? verifyFathom(headers, body, secret) : verifyFireflies(headers, body, secret);
  if (!verdict.ok) {
    await noteEvent(accountId, integration.id, { error: `Rejected a delivery: ${verdict.reason}` });
    logEvent('ingest.rejected', { accountId, src, reason: verdict.reason });
    return res.status(401).json({ ok: false, error: 'bad_signature', reason: verdict.reason });
  }

  let payload;
  try { payload = JSON.parse(body || '{}'); } catch { return res.status(400).json({ ok: false, error: 'bad_json' }); }

  let call;
  try {
    if (src === 'fathom') {
      const meeting = payload.meeting || payload.data || payload;
      if (!Array.isArray(meeting.transcript) || !meeting.transcript.length) {
        await noteEvent(accountId, integration.id, { error: 'A delivery had no transcript — re-create the webhook with "include transcript".' });
        return res.status(200).json({ ok: true, ignored: 'no transcript in payload' });
      }
      call = callFromFathom(meeting);
    } else {
      const eventType = String(payload.eventType || payload.event || '');
      if (eventType && !/transcri/i.test(eventType)) return res.status(200).json({ ok: true, ignored: `event ${eventType}` });
      const meetingId = payload.meetingId || payload.meeting_id || payload.id;
      if (!meetingId) return res.status(400).json({ ok: false, error: 'bad_request', message: 'meetingId missing' });
      call = await fetchFirefliesCall(await integrationKey(accountId, 'fireflies'), meetingId);
    }
  } catch (err) {
    await noteEvent(accountId, integration.id, { error: err.message });
    logEvent('ingest.failed', { accountId, src, code: err.code || 'error' });
    return res.status(502).json({ ok: false, error: err.code || 'vendor', message: err.message });
  }

  const { call: stored, duplicate } = await saveNewCall(accountId, call);
  await noteEvent(accountId, integration.id);
  logEvent('ingest.ok', { accountId, src, callId: stored.id, duplicate, lines: stored.transcript?.length || 0 });
  if (duplicate && stored.status !== 'queued') return res.status(200).json({ ok: true, id: stored.id, status: stored.status, duplicate: true });

  const run = () => analyzeCall(accountId, stored.id).catch((err) => logEvent('ingest.analysis.failed', { accountId, callId: stored.id, code: err.code || 'error' }));
  const waitUntil = waitUntilFn();
  if (waitUntil) {
    res.status(200).json({ ok: true, id: stored.id, status: 'queued', analysis: 'background' });
    waitUntil(run());
    return undefined;
  }
  await run();
  return res.status(200).json({ ok: true, id: stored.id, status: 'done', analysis: 'inline' });
}
