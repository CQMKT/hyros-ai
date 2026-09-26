/**
 * Integrations — the keys the Call Intelligence feature needs, per account,
 * encrypted at rest exactly like HYROS keys (api/_accounts.js encryptKey):
 *
 *   anthropic   the model API key (analysis)
 *   fathom      Fathom API key; a webhook is registered on Fathom's side
 *   fireflies   Fireflies API key; the user pastes our webhook URL + secret
 *               into Fireflies → Settings → Developer settings
 *
 * KV: aihyros:acct:<id>:integrations  { items: [...] }
 *     aihyros:ingest:<token>          { accountId, id, kind }   webhook URL → account
 *
 * The webhook URL carries a random token, never the account id, so a leaked
 * URL cannot be pointed at another account. Keys never leave the server.
 */
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { kvRaw, storeConfigured } from './_store.js';
import { encryptKey, decryptKey } from './_accounts.js';
import { probeKey as probeLlm } from './_llm.js';
import { newCall, normalizeTranscript, parseTimestamp } from './_calls.js';
import { probe as probeStripe, createWebhookEndpoint, deleteWebhookEndpoint } from './_stripe.js';
import { probe as probeWhop } from './_whop.js';

export const KINDS = ['anthropic', 'fathom', 'fireflies', 'stripe', 'whop'];
const intKey = (accountId) => `aihyros:acct:${accountId}:integrations`;
const tokenKey = (token) => `aihyros:ingest:${token}`;
const fail = (message, status, code) => Object.assign(new Error(message), { status, code });

export const fathomUrl = () => process.env.FATHOM_API_URL || 'https://api.fathom.ai/external/v1';
export const firefliesUrl = () => process.env.FIREFLIES_API_URL || 'https://api.fireflies.ai/graphql';

async function readJson(key) {
  const raw = await kvRaw(['GET', key]);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export async function readIntegrations(accountId) {
  if (!storeConfigured() || !accountId) return [];
  return (await readJson(intKey(accountId)))?.items || [];
}

async function saveIntegrations(accountId, items) {
  const ok = (await kvRaw(['SET', intKey(accountId), JSON.stringify({ items, savedAt: new Date().toISOString() })])) !== null;
  if (!ok) throw fail('Could not save the integration (KV write failed or read-only preview).', 502, 'kv');
}

/** Public shape — no key material, no webhook secret. */
export function publicIntegration(it, { origin = '' } = {}) {
  return {
    id: it.id, kind: it.kind, label: it.label || null, createdAt: it.createdAt || null,
    lastEventAt: it.lastEventAt || null, lastError: it.lastError || null, events: it.events || 0,
    webhookRegistered: Boolean(it.webhookId), webhookUrl: it.token ? `${origin}/api/ingest?src=${it.kind}&t=${it.token}` : null,
    model: it.model || null,
  };
}

/** Decrypted key for a kind, or null when not connected. */
export async function integrationKey(accountId, kind) {
  const it = (await readIntegrations(accountId)).find((x) => x.kind === kind);
  return it ? decryptKey(it.keyEnc) : null;
}

export async function findByToken(token) {
  if (!/^[0-9a-f]{32}$/.test(String(token || ''))) return null;
  const ref = await readJson(tokenKey(token));
  if (!ref) return null;
  const it = (await readIntegrations(ref.accountId)).find((x) => x.id === ref.id);
  return it ? { accountId: ref.accountId, integration: it } : null;
}

/* ---------------- vendor calls ---------------- */

async function fathom(apiKey, path, { method = 'GET', body = null, timeoutMs = 20000 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${fathomUrl()}${path}`, { method, headers: { 'x-api-key': apiKey, 'content-type': 'application/json', accept: 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: ac.signal });
    const text = await res.text();
    let data = null; try { data = JSON.parse(text); } catch { data = null; }
    if (!res.ok) throw fail(res.status === 401 || res.status === 403 ? 'Fathom rejected that API key.' : `Fathom answered HTTP ${res.status}: ${(data?.message || data?.error || text).toString().slice(0, 200)}`, res.status === 401 || res.status === 403 ? 400 : 502, res.status === 401 || res.status === 403 ? 'bad_key' : 'vendor');
    return data;
  } catch (err) {
    if (err.name === 'AbortError') throw fail('Fathom did not answer in time.', 504, 'vendor_timeout');
    throw err;
  } finally { clearTimeout(timer); }
}

async function fireflies(apiKey, query, variables = {}, { timeoutMs = 20000 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(firefliesUrl(), { method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }), signal: ac.signal });
    const text = await res.text();
    let data = null; try { data = JSON.parse(text); } catch { data = null; }
    const gqlErr = data?.errors?.[0];
    if (res.status === 401 || res.status === 403 || /unauthor|forbidden|invalid.*key|api.?key/i.test(gqlErr?.message || '')) throw fail('Fireflies rejected that API key.', 400, 'bad_key');
    if (!res.ok || gqlErr) throw fail(`Fireflies answered: ${(gqlErr?.message || text).toString().slice(0, 200)}`, 502, 'vendor');
    return data?.data || {};
  } catch (err) {
    if (err.name === 'AbortError') throw fail('Fireflies did not answer in time.', 504, 'vendor_timeout');
    throw err;
  } finally { clearTimeout(timer); }
}

const FIREFLIES_TRANSCRIPT = `query Transcript($id: String!) { transcript(id: $id) {
  id title date duration organizer_email transcript_url
  meeting_attendees { email displayName }
  participants
  sentences { speaker_name text start_time end_time }
  summary { overview }
} }`;
const FIREFLIES_LIST = `query List($fromDate: DateTime, $limit: Int, $skip: Int) { transcripts(fromDate: $fromDate, limit: $limit, skip: $skip) { id title date duration } }`;

/* ---------------- normalizing vendor payloads into calls ---------------- */

const lower = (e) => (e ? String(e).toLowerCase() : null);

/** A Fathom meeting (webhook payload or GET /meetings item) → a queued call record. */
export function callFromFathom(m, { source = 'fathom' } = {}) {
  const recorder = m.recorded_by ? { name: m.recorded_by.name || null, email: lower(m.recorded_by.email) } : null;
  const recorderDomain = recorder?.email?.split('@')[1] || null;
  const attendees = (Array.isArray(m.calendar_invitees) ? m.calendar_invitees : []).map((p) => ({
    name: p.name || p.display_name || null, email: lower(p.email),
    external: p.is_external !== undefined ? Boolean(p.is_external) : Boolean(lower(p.email) && recorderDomain && !lower(p.email).endsWith(`@${recorderDomain}`)),
  }));
  const transcript = (Array.isArray(m.transcript) ? m.transcript : []).map((t) => ({ t: parseTimestamp(t.timestamp), speaker: t.speaker?.display_name || 'Unknown', text: t.text }));
  const summary = typeof m.default_summary === 'string' ? m.default_summary : m.default_summary?.markdown_formatted || m.default_summary?.text || null;
  const start = m.recording_start_time || m.scheduled_start_time || m.created_at || null;
  const end = m.recording_end_time || m.scheduled_end_time || null;
  const durationS = start && end ? Math.max(0, Math.round((Date.parse(end) - Date.parse(start)) / 1000)) : null;
  return newCall({
    source, externalId: String(m.recording_id ?? m.id ?? m.url ?? ''), title: m.meeting_title || m.title || 'Fathom call', date: start,
    durationS, attendees, recordedBy: recorder, transcript, vendorSummary: summary, url: m.share_url || m.url || null,
  });
}

/** A Fireflies transcript (GraphQL) → a queued call record. */
export function callFromFireflies(t, { source = 'fireflies' } = {}) {
  const organizer = lower(t.organizer_email);
  const orgDomain = organizer?.split('@')[1] || null;
  const attendees = (Array.isArray(t.meeting_attendees) ? t.meeting_attendees : []).map((p) => ({
    name: p.displayName || null, email: lower(p.email), external: Boolean(lower(p.email) && orgDomain && !lower(p.email).endsWith(`@${orgDomain}`)),
  }));
  const transcript = normalizeTranscript((Array.isArray(t.sentences) ? t.sentences : []).map((x) => ({ t: x.start_time, speaker: x.speaker_name, text: x.text })));
  const date = Number.isFinite(Number(t.date)) ? new Date(Number(t.date)).toISOString() : t.date || null;
  return newCall({
    source, externalId: String(t.id), title: t.title || 'Fireflies call', date,
    durationS: Number.isFinite(Number(t.duration)) ? Math.round(Number(t.duration) * (Number(t.duration) < 1000 ? 60 : 1)) : null,
    attendees, recordedBy: organizer ? { name: null, email: organizer } : null, transcript, vendorSummary: t.summary?.overview || null, url: t.transcript_url || null,
  });
}

/* ---------------- connect / remove ---------------- */

/**
 * Probe the key with the vendor, encrypt and store it. Fathom also gets a
 * webhook registered (destination = this deployment's /api/ingest with the
 * integration's token); Fireflies is configured by hand on their side.
 */
export async function addIntegration(accountId, { kind, apiKey, origin, model = null, webhookSecret = null }) {
  if (!KINDS.includes(kind)) throw fail('Unknown integration.', 400, 'bad_request');
  const key = String(apiKey || '').trim();
  if (key.length < 8) throw fail('That does not look like an API key.', 400, 'bad_key');
  let label = null;
  if (kind === 'anthropic') {
    try { label = (await probeLlm(key, model ? { model } : {})).model; }
    catch (err) { if (err.code === 'llm_auth') throw fail('The model API rejected that key.', 400, 'bad_key'); throw fail(err.message, 502, err.code || 'vendor'); }
  }
  if (kind === 'fathom') { const r = await fathom(key, '/meetings?include_transcript=false'); label = Array.isArray(r?.items) ? `${r.items.length}+ meetings visible` : 'connected'; }
  if (kind === 'fireflies') { const r = await fireflies(key, '{ user { email name } }'); label = r?.user?.email || r?.user?.name || 'connected'; }
  if (kind === 'stripe') { if (!/^(sk|rk)_(live|test)_/.test(key)) throw fail('Paste a Stripe secret or restricted key (sk_… / rk_…).', 400, 'bad_key'); await probeStripe(key); label = key.startsWith('rk_') ? 'restricted key' : 'secret key'; label += key.includes('_test_') ? ' (test mode)' : ' (live)'; }
  if (kind === 'whop') { await probeWhop(key); label = 'connected'; }

  const items = (await readIntegrations(accountId)).filter((x) => x.kind !== kind);
  const old = (await readIntegrations(accountId)).find((x) => x.kind === kind);
  if (old?.token) await kvRaw(['DEL', tokenKey(old.token)]);
  if (old?.kind === 'stripe' && old.webhookId) { try { await deleteWebhookEndpoint(decryptKey(old.keyEnc), old.webhookId); } catch { /* best effort */ } }
  const it = { id: `int_${randomBytes(6).toString('hex')}`, kind, label, keyEnc: encryptKey(key), createdAt: new Date().toISOString(), events: 0, lastEventAt: null, lastError: null, model: model || null };
  if (['fathom', 'fireflies', 'stripe', 'whop'].includes(kind)) {
    it.token = randomBytes(16).toString('hex');
    await kvRaw(['SET', tokenKey(it.token), JSON.stringify({ accountId, id: it.id, kind })]);
  }
  if (kind === 'fireflies') it.secretEnc = encryptKey(randomBytes(12).toString('hex')); // 24 chars: Fireflies wants 16–32
  if (kind === 'whop' && webhookSecret) it.secretEnc = encryptKey(String(webhookSecret).trim());
  if (kind === 'stripe' && origin) {
    try {
      const r = await createWebhookEndpoint(key, `${origin}/api/ingest?src=stripe&t=${it.token}`);
      it.webhookId = r.id || null;
      if (r.secret) it.secretEnc = encryptKey(String(r.secret));
      if (!r.secret) it.lastError = 'Stripe created the webhook endpoint but returned no signing secret — deliveries cannot be verified.';
    } catch (err) { it.lastError = `Webhook not registered: ${err.message} (payments still record from the thank-you page).`; }
  }
  if (kind === 'fathom' && origin) {
    try {
      const r = await fathom(key, '/webhooks', { method: 'POST', body: { destination_url: `${origin}/api/ingest?src=fathom&t=${it.token}`, triggered_for: ['my_recordings', 'shared_team_recordings'], include_transcript: true, include_summary: true } });
      it.webhookId = r?.id ? String(r.id) : null;
      if (r?.secret) it.secretEnc = encryptKey(String(r.secret));
      if (!it.webhookId || !r?.secret) it.lastError = 'Fathom created the webhook but returned no id/secret — deliveries cannot be verified.';
    } catch (err) { it.lastError = `Webhook not registered: ${err.message}`; }
  }
  await saveIntegrations(accountId, [...items, it]);
  return it;
}

export async function removeIntegration(accountId, id) {
  const items = await readIntegrations(accountId);
  const it = items.find((x) => x.id === id);
  if (!it) return false;
  if (it.kind === 'fathom' && it.webhookId) {
    try { await fathom(decryptKey(it.keyEnc), `/webhooks/${encodeURIComponent(it.webhookId)}`, { method: 'DELETE' }); } catch { /* best effort */ }
  }
  if (it.kind === 'stripe' && it.webhookId) {
    try { await deleteWebhookEndpoint(decryptKey(it.keyEnc), it.webhookId); } catch { /* best effort */ }
  }
  if (it.token) await kvRaw(['DEL', tokenKey(it.token)]);
  await saveIntegrations(accountId, items.filter((x) => x.id !== id));
  return true;
}

/** The Fireflies signing secret, shown on the setup screen (password-gated). */
export async function firefliesSecret(accountId) {
  const it = (await readIntegrations(accountId)).find((x) => x.kind === 'fireflies');
  return it?.secretEnc ? decryptKey(it.secretEnc) : null;
}

export async function noteEvent(accountId, id, { error = null } = {}) {
  const items = await readIntegrations(accountId);
  const it = items.find((x) => x.id === id);
  if (!it) return;
  it.events = (it.events || 0) + 1; it.lastEventAt = new Date().toISOString(); it.lastError = error;
  await saveIntegrations(accountId, items);
}

/* ---------------- signature verification ---------------- */

const safeEqual = (a, b) => {
  const ab = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  return ab.length === bb.length && timingSafeEqual(ab, bb);
};

/**
 * Fathom (Standard Webhooks): `webhook-id`, `webhook-timestamp` (unix s),
 * `webhook-signature` = "v1,<base64 hmac>" (space-separated list); the HMAC
 * is SHA-256 over "<id>.<timestamp>.<raw body>" keyed with the base64-decoded
 * secret after the "whsec_" prefix. 5-minute tolerance.
 */
export function verifyFathom(headers, rawBody, secret, { now = Date.now(), toleranceS = 300 } = {}) {
  const id = headers['webhook-id']; const ts = headers['webhook-timestamp']; const sigs = String(headers['webhook-signature'] || '');
  if (!id || !ts || !sigs || !secret) return { ok: false, reason: 'missing signature headers' };
  if (Math.abs(now / 1000 - Number(ts)) > toleranceS) return { ok: false, reason: 'timestamp outside tolerance' };
  const keyB64 = String(secret).startsWith('whsec_') ? String(secret).slice(6) : String(secret);
  const expected = createHmac('sha256', Buffer.from(keyB64, 'base64')).update(`${id}.${ts}.${rawBody}`).digest('base64');
  const ok = sigs.split(' ').map((s) => s.split(',')[1] || s).some((s) => safeEqual(s, expected));
  return ok ? { ok: true } : { ok: false, reason: 'signature mismatch' };
}

/** Fireflies: `x-hub-signature` = hex SHA-256 HMAC of the raw body with the shared secret (optionally "sha256=" prefixed). */
export function verifyFireflies(headers, rawBody, secret) {
  const given = String(headers['x-hub-signature'] || '').replace(/^sha256=/, '');
  if (!given || !secret) return { ok: false, reason: 'missing signature' };
  const expected = createHmac('sha256', String(secret)).update(rawBody).digest('hex');
  return safeEqual(given, expected) ? { ok: true } : { ok: false, reason: 'signature mismatch' };
}

/* ---------------- fetch / backfill ---------------- */

/** Pull one Fireflies transcript by id (the webhook only carries the id). */
export async function fetchFirefliesCall(apiKey, meetingId) {
  const data = await fireflies(apiKey, FIREFLIES_TRANSCRIPT, { id: String(meetingId) }, { timeoutMs: 40000 });
  if (!data?.transcript) throw fail('Fireflies has no transcript with that id.', 404, 'not_found');
  return callFromFireflies(data.transcript);
}

/**
 * Backfill: the vendor's meetings from the last `days` days as queued call
 * records (analysis runs separately, within its own budget). Returns
 * { calls, more } — capped at `max` per run.
 */
export async function backfill(accountId, kind, { days = 30, max = 25 } = {}) {
  const apiKey = await integrationKey(accountId, kind);
  if (!apiKey) throw fail(`${kind} is not connected.`, 409, 'not_connected');
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const calls = [];
  if (kind === 'fathom') {
    let cursor = null;
    for (let page = 0; page < 10 && calls.length < max; page += 1) {
      const q = new URLSearchParams({ include_transcript: 'true', include_summary: 'true', created_after: since });
      if (cursor) q.set('cursor', cursor);
      const r = await fathom(apiKey, `/meetings?${q}`, { timeoutMs: 40000 });
      for (const m of (Array.isArray(r?.items) ? r.items : [])) { if (calls.length >= max) break; calls.push(callFromFathom(m)); }
      cursor = r?.next_cursor || null;
      if (!cursor) break;
    }
    return { calls, more: Boolean(cursor) };
  }
  if (kind === 'fireflies') {
    const r = await fireflies(apiKey, FIREFLIES_LIST, { fromDate: since, limit: max, skip: 0 }, { timeoutMs: 40000 });
    const list = Array.isArray(r?.transcripts) ? r.transcripts : [];
    for (const t of list.slice(0, max)) {
      try { calls.push(await fetchFirefliesCall(apiKey, t.id)); } catch { /* skip one broken transcript */ }
    }
    return { calls, more: list.length >= max };
  }
  throw fail('Backfill is only available for Fathom and Fireflies.', 400, 'bad_request');
}
