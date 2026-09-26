/**
 * Payment Links — the store behind the Pingit-style attribution fix.
 *
 *   aihyros:acct:<id>:pay:links      the account's links (Stripe / Whop)
 *   aihyros:acct:<id>:pay:tx:<txId>  one transaction (from the thank-you page or a webhook)
 *   aihyros:acct:<id>:pay:index      newest INDEX_MAX transactions + totals
 *   aihyros:acct:<id>:pay:settings   thank-you page, domain, tracking script, notifications
 *   aihyros:paylink:<token>          link token → { accountId, linkId } (public page + webhooks)
 *
 * Why it works: the buyer lands on /ty with the paying email in the URL and
 * the account's HYROS universal script in the head; the browser still holds
 * the HYROS session from the opt-in, so HYROS links the two emails. Nothing
 * here talks to HYROS except `verifyInHyros`, which reads the lead back.
 */
import { createHash, randomBytes } from 'node:crypto';
import { kvRaw, storeConfigured } from './_store.js';
import { asAccount } from './_accounts.js';
import { callTool } from './_mcp.js';
import { parseHyrosDate } from './_dates.js';

export const INDEX_MAX = 500;
export const TEMPLATES = ['dark', 'light', 'minimal', 'bold', 'corporate'];
export const TEMPLATE_NAMES = { dark: 'Dark Modern', light: 'Light & Clean', minimal: 'Minimal', bold: 'Bold & Vibrant', corporate: 'Corporate Professional' };
export const INTERVALS = [null, 'month', 'year', 'week'];
export const CURRENCIES = ['usd', 'eur', 'gbp', 'cad', 'aud', 'nzd', 'chf', 'sek', 'nok', 'dkk', 'mxn', 'brl', 'inr', 'sgd', 'hkd', 'jpy'];

const linksKey = (a) => `aihyros:acct:${a}:pay:links`;
const txKey = (a, id) => `aihyros:acct:${a}:pay:tx:${id}`;
const indexKey = (a) => `aihyros:acct:${a}:pay:index`;
const settingsKey = (a) => `aihyros:acct:${a}:pay:settings`;
const tokenKey = (t) => `aihyros:paylink:${t}`;
const fail = (message, status, code) => Object.assign(new Error(message), { status, code });
const str = (v, n = 300) => (v === null || v === undefined ? '' : String(v)).slice(0, n);
const int = (v, d = 0) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? n : d; };

async function readJson(key) {
  const raw = await kvRaw(['GET', key]);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
async function writeJson(key, value) {
  const ok = (await kvRaw(['SET', key, JSON.stringify(value)])) !== null;
  if (!ok) throw fail('Could not write to storage (KV write failed or read-only preview).', 502, 'kv');
}

export const newToken = () => randomBytes(16).toString('hex');
export const validToken = (t) => /^[0-9a-f]{32}$/.test(String(t || ''));
export const txIdFor = (source, externalId) => `t_${createHash('sha256').update(`${source}:${externalId}`).digest('hex').slice(0, 16)}`;

/* ---------------- links ---------------- */

export async function readLinks(accountId) {
  if (!storeConfigured() || !accountId) return [];
  return (await readJson(linksKey(accountId)))?.items || [];
}
async function writeLinks(accountId, items) { await writeJson(linksKey(accountId), { items, savedAt: new Date().toISOString() }); }

/** A new link record (Stripe or Whop), token registered for the public page. */
export async function addLink(accountId, fields) {
  const link = {
    id: `pl_${randomBytes(6).toString('hex')}`, token: newToken(), source: fields.source === 'whop' ? 'whop' : 'stripe',
    name: str(fields.name, 120) || 'Payment link', description: str(fields.description, 500),
    amountCents: Math.max(0, int(fields.amountCents)), currency: CURRENCIES.includes(String(fields.currency || '').toLowerCase()) ? String(fields.currency).toLowerCase() : 'usd',
    interval: INTERVALS.includes(fields.interval) ? fields.interval : null,
    stripeId: fields.stripeId ? str(fields.stripeId, 80) : null, productId: fields.productId ? str(fields.productId, 80) : null, priceId: fields.priceId ? str(fields.priceId, 80) : null,
    whopPlanId: fields.whopPlanId ? str(fields.whopPlanId, 80) : null,
    url: fields.url ? str(fields.url, 500) : null, active: fields.active !== false, imported: Boolean(fields.imported),
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  const items = await readLinks(accountId);
  await writeLinks(accountId, [...items, link]);
  await kvRaw(['SET', tokenKey(link.token), JSON.stringify({ accountId, linkId: link.id })]);
  return link;
}

export async function updateLink(accountId, id, patch) {
  const items = await readLinks(accountId);
  const link = items.find((l) => l.id === id);
  if (!link) return null;
  for (const k of ['name', 'description', 'url']) if (patch[k] !== undefined) link[k] = str(patch[k], k === 'name' ? 120 : 500);
  for (const k of ['stripeId', 'productId', 'priceId', 'whopPlanId']) if (patch[k] !== undefined) link[k] = patch[k] ? str(patch[k], 80) : null;
  if (patch.active !== undefined) link.active = Boolean(patch.active);
  if (patch.amountCents !== undefined) link.amountCents = Math.max(0, int(patch.amountCents));
  if (patch.interval !== undefined) link.interval = INTERVALS.includes(patch.interval) ? patch.interval : null;
  link.updatedAt = new Date().toISOString();
  await writeLinks(accountId, items);
  return link;
}

export async function removeLink(accountId, id) {
  const items = await readLinks(accountId);
  const link = items.find((l) => l.id === id);
  if (!link) return null;
  await writeLinks(accountId, items.filter((l) => l.id !== id));
  await kvRaw(['DEL', tokenKey(link.token)]);
  return link;
}

/** Public page / webhook: which account and link does this token belong to? */
export async function findLinkByToken(token) {
  if (!validToken(token) || !storeConfigured()) return null;
  const ref = await readJson(tokenKey(token));
  if (!ref) return null;
  const link = (await readLinks(ref.accountId)).find((l) => l.id === ref.linkId) || null;
  return link ? { accountId: ref.accountId, link } : null;
}

/** The thank-you page origin: the custom domain when set, else this deployment. */
export function thankYouBase(settings, origin) {
  const d = String(settings?.domain || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return d ? `https://${d}` : String(origin || '').replace(/\/$/, '');
}
export const thankYouUrl = (base, token) => `${base}/ty?l=${token}`;

export function publicLink(link, { base = '' } = {}) {
  return { ...link, thankYouUrl: thankYouUrl(base, link.token) };
}

/* ---------------- transactions ---------------- */

/**
 * Record (or merge) one transaction. `via` says where it came from: the
 * thank-you page (`page`) or a webhook (`webhook`). The first record wins
 * on identity fields; status, email and HYROS result are updated.
 */
export async function recordTransaction(accountId, tx, { via = 'page', linkId = null, linkToken = null } = {}) {
  if (!tx?.externalId) throw fail('Transaction without an id.', 400, 'bad_request');
  const id = txIdFor(tx.source || 'stripe', tx.externalId);
  const existing = (await readJson(txKey(accountId, id))) || null;
  const now = new Date().toISOString();
  const merged = existing ? { ...existing } : {
    id, source: tx.source || 'stripe', externalId: str(tx.externalId, 120), linkId, linkToken,
    email: null, name: null, phone: null, amountCents: 0, currency: 'usd', status: 'unpaid', mode: null,
    paymentIntentId: null, subscriptionId: null, customerId: null, paymentLinkId: null, items: [], metadata: {},
    created: tx.created || now, firstSeenAt: now, via: [], pageHits: 0, emailPassed: false, hyros: null, failure: null, refundedCents: 0, livemode: tx.livemode !== false,
  };
  for (const k of ['email', 'name', 'phone', 'mode', 'paymentIntentId', 'subscriptionId', 'customerId', 'paymentLinkId']) if (tx[k] && !merged[k]) merged[k] = k === 'email' ? str(tx[k], 200).toLowerCase() : str(tx[k], 200);
  if (tx.amountCents) merged.amountCents = int(tx.amountCents);
  if (tx.currency) merged.currency = String(tx.currency).toLowerCase();
  if (Array.isArray(tx.items) && tx.items.length) merged.items = tx.items.slice(0, 10);
  if (tx.metadata && Object.keys(tx.metadata).length) merged.metadata = { ...(merged.metadata || {}), ...tx.metadata };
  // Status only moves forward: unpaid → paid → refunded; failed is its own record (different id).
  const rank = { unpaid: 0, expired: 0, paid: 1, failed: 1, refunded: 2 };
  if ((rank[tx.status] ?? 0) >= (rank[merged.status] ?? 0)) merged.status = tx.status || merged.status;
  if (tx.failure) merged.failure = str(tx.failure, 300);
  if (tx.refundedCents) merged.refundedCents = int(tx.refundedCents);
  if (!merged.linkId && linkId) { merged.linkId = linkId; merged.linkToken = linkToken; }
  if (!merged.via.includes(via)) merged.via.push(via);
  if (via === 'page') merged.pageHits = (merged.pageHits || 0) + 1;
  if (tx.emailPassed) merged.emailPassed = true;
  merged.updatedAt = now;
  await writeJson(txKey(accountId, id), merged);
  await upsertIndex(accountId, merged);
  return { tx: merged, created: !existing };
}

export async function readTx(accountId, id) {
  if (!storeConfigured() || !/^t_[0-9a-f]{16}$/.test(String(id || ''))) return null;
  return readJson(txKey(accountId, id));
}

export async function updateTx(accountId, id, patch) {
  const tx = await readTx(accountId, id);
  if (!tx) return null;
  Object.assign(tx, patch, { updatedAt: new Date().toISOString() });
  await writeJson(txKey(accountId, id), tx);
  await upsertIndex(accountId, tx);
  return tx;
}

export async function deleteTx(accountId, id) {
  if (!/^t_[0-9a-f]{16}$/.test(String(id || ''))) return false;
  await kvRaw(['DEL', txKey(accountId, id)]);
  const idx = await readIndex(accountId);
  await writeJson(indexKey(accountId), withTotals({ ...idx, rows: idx.rows.filter((r) => r.id !== id) }));
  return true;
}

/** The compact row the index and the snapshot carry. */
export function indexRowOf(tx) {
  return {
    id: tx.id, source: tx.source, linkId: tx.linkId || null, created: tx.created, email: tx.email, name: tx.name,
    amountCents: tx.amountCents, currency: tx.currency, status: tx.status, mode: tx.mode, via: tx.via || [], emailPassed: Boolean(tx.emailPassed),
    hyros: tx.hyros ? { checkedAt: tx.hyros.checkedAt, found: Boolean(tx.hyros.found), firstSource: tx.hyros.firstSource || null, stage: tx.hyros.stage || null, linked: Boolean(tx.hyros.linked) } : null,
    failure: tx.failure || null, refundedCents: tx.refundedCents || 0, livemode: tx.livemode !== false,
  };
}

/** Totals re-derived from the rows every time (never incremented). */
export function withTotals(idx) {
  const rows = idx.rows || [];
  const paid = rows.filter((r) => r.status === 'paid' || r.status === 'refunded');
  const checked = rows.filter((r) => r.hyros);
  return {
    ...idx,
    totals: {
      transactions: rows.length, paid: paid.length, failed: rows.filter((r) => r.status === 'failed').length, refunded: rows.filter((r) => r.status === 'refunded').length,
      revenueCents: paid.reduce((s, r) => s + (r.amountCents || 0) - (r.refundedCents || 0), 0),
      emailPassed: rows.filter((r) => r.emailPassed).length, checked: checked.length, linked: checked.filter((r) => r.hyros.linked).length, found: checked.filter((r) => r.hyros.found).length,
    },
  };
}

export async function readIndex(accountId) {
  const idx = storeConfigured() && accountId ? await readJson(indexKey(accountId)) : null;
  return withTotals({ rows: Array.isArray(idx?.rows) ? idx.rows : [], updatedAt: idx?.updatedAt || null, truncated: Boolean(idx?.truncated), dropped: idx?.dropped || 0 });
}

export async function upsertIndex(accountId, tx) {
  const idx = await readIndex(accountId);
  const rows = [...idx.rows.filter((r) => r.id !== tx.id), indexRowOf(tx)].sort((a, b) => String(b.created || '').localeCompare(String(a.created || '')));
  const dropped = Math.max(0, rows.length - INDEX_MAX);
  const next = withTotals({ rows: rows.slice(0, INDEX_MAX), updatedAt: new Date().toISOString(), truncated: idx.truncated || dropped > 0, dropped: idx.dropped + dropped });
  await writeJson(indexKey(accountId), next);
  return next;
}

/* ---------------- settings ---------------- */

export function defaultSettings() {
  return {
    template: 'light', headline: 'Thank You for Your Purchase!', message: 'Your payment was successful. We appreciate your business!',
    logoUrl: '', brand: '', accent: '', showOrder: true, showEmail: true, redirectUrl: '', countdownS: 0,
    domain: '', trackingScript: '', trackingSource: null, notifyUrl: '', updatedAt: null,
  };
}

/** The owner's HYROS universal script: a script that loads from hyros.com, nothing else. */
export function validateTrackingScript(s) {
  const v = String(s || '').trim();
  if (!v) return { ok: true, value: '' };
  if (v.length > 4000) return { ok: false, reason: 'The script is longer than 4 KB — paste only the universal script.' };
  if (!/<script[\s>]/i.test(v) || !/<\/script>/i.test(v)) return { ok: false, reason: 'Paste the whole <script>…</script> block from HYROS → Tracking → Universal Script.' };
  if (!/hyros\.com/i.test(v)) return { ok: false, reason: 'That does not look like a HYROS script (no hyros.com in it).' };
  if (/<(iframe|object|embed|link|meta|form|img)\b/i.test(v)) return { ok: false, reason: 'Only the HYROS <script> block is allowed here.' };
  return { ok: true, value: v };
}

export function normalizeSettings(raw) {
  const d = defaultSettings();
  const r = raw && typeof raw === 'object' ? raw : {};
  const url = (v) => { const s = str(v, 500).trim(); return !s || /^https?:\/\//i.test(s) ? s : ''; };
  return {
    template: TEMPLATES.includes(r.template) ? r.template : d.template,
    headline: str(r.headline, 120) || d.headline, message: str(r.message, 600) || d.message,
    logoUrl: url(r.logoUrl), brand: str(r.brand, 80), accent: /^#[0-9a-fA-F]{6}$/.test(String(r.accent || '')) ? r.accent : '',
    showOrder: r.showOrder !== false, showEmail: r.showEmail !== false,
    redirectUrl: url(r.redirectUrl), countdownS: Math.min(120, Math.max(0, int(r.countdownS))),
    domain: str(r.domain, 120).trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase(),
    trackingScript: str(r.trackingScript, 4000), trackingSource: r.trackingSource === 'hyros' ? 'hyros' : r.trackingScript ? 'pasted' : null,
    notifyUrl: url(r.notifyUrl), updatedAt: str(r.updatedAt) || null,
  };
}

export async function readSettings(accountId) {
  if (!storeConfigured() || !accountId) return normalizeSettings(null);
  return normalizeSettings(await readJson(settingsKey(accountId)));
}

export async function writeSettings(accountId, raw) {
  const s = normalizeSettings(raw);
  const script = validateTrackingScript(s.trackingScript);
  if (!script.ok) throw fail(script.reason, 400, 'bad_script');
  s.trackingScript = script.value;
  s.updatedAt = new Date().toISOString();
  await writeJson(settingsKey(accountId), s);
  return s;
}

/* ---------------- HYROS verification ---------------- */

const flatSource = (src) => (src && typeof src === 'object' ? { name: src.name || null, tag: src.tag || null, organic: Boolean(src.organic), ad: src.sourceLinkAd?.name || null, category: src.category?.name || src.category || null, clickDate: parseHyrosDate(src.clickDate) || null } : null);

/**
 * Did HYROS learn the paying email, and does that lead carry a source? A
 * lead that exists with a first source is "linked" — the script on the
 * thank-you page (or the processor integration) delivered the email into a
 * session with clicks. Best effort: errors land on the result, never throw.
 */
export async function verifyInHyros(accountId, txIds, { now = new Date() } = {}) {
  const txs = (await Promise.all(txIds.slice(0, 50).map((id) => readTx(accountId, id)))).filter((t) => t && t.email);
  const emails = [...new Set(txs.map((t) => t.email))].slice(0, 50);
  const out = { checked: 0, linked: 0, found: 0, error: null };
  if (!emails.length) return out;
  let leads = [];
  try {
    const body = await asAccount(accountId, () => callTool('hyros_get_leads', { request: { emails, pageSize: 50 } }, { timeoutMs: 15000 }));
    leads = Array.isArray(body) ? body : body?.result || [];
  } catch (err) { out.error = err.message; return out; }
  const byEmail = new Map(leads.map((l) => [String(l.email || '').toLowerCase(), l]));
  for (const t of txs) {
    const lead = byEmail.get(t.email);
    const first = flatSource(lead?.firstSource);
    const hyros = { checkedAt: now.toISOString(), found: Boolean(lead), leadId: lead?.id || null, stage: lead?.currentStage?.name || null, joined: parseHyrosDate(lead?.creationDate) || null,
      firstSource: first?.name || null, lastSource: flatSource(lead?.lastSource)?.name || null, linked: Boolean(first?.name), originLead: lead?.originLead?.email || null };
    await updateTx(accountId, t.id, { hyros });
    out.checked += 1; if (hyros.found) out.found += 1; if (hyros.linked) out.linked += 1;
  }
  return out;
}

/* ---------------- notifications ---------------- */

/** Slack / Discord incoming webhook — one line per payment. Best effort. */
export async function notify(settings, tx, { linkName = null } = {}) {
  const url = settings?.notifyUrl;
  if (!url || !/^https:\/\//.test(url)) return { ok: false, skipped: 'no notify URL' };
  const amount = `${(tx.amountCents / 100).toFixed(2)} ${String(tx.currency || 'usd').toUpperCase()}`;
  const text = `${tx.status === 'failed' ? '⚠️ Failed payment' : tx.status === 'refunded' ? '↩️ Refund' : '💸 Payment'}: ${amount}${linkName ? ` · ${linkName}` : ''}${tx.email ? ` · ${tx.email}` : ''}${tx.emailPassed ? ' · email passed to HYROS' : ''}`;
  const body = /discord\.com\/api\/webhooks/.test(url) ? { content: text } : { text };
  try {
    const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), 8000);
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ac.signal });
    clearTimeout(timer);
    return { ok: res.ok, status: res.status };
  } catch (err) { return { ok: false, error: err.message }; }
}

/* ---------------- cleanup ---------------- */

export async function deleteAccountPay(accountId) {
  for (const l of await readLinks(accountId)) await kvRaw(['DEL', tokenKey(l.token)]);
  let cursor = '0';
  for (let guard = 0; guard < 100; guard += 1) {
    const r = await kvRaw(['SCAN', cursor, 'MATCH', `aihyros:acct:${accountId}:pay:*`, 'COUNT', '200']);
    if (!Array.isArray(r)) break;
    const [next, keys] = r;
    if (Array.isArray(keys) && keys.length) await kvRaw(['DEL', ...keys]);
    cursor = String(next);
    if (cursor === '0') break;
  }
  await kvRaw(['DEL', linksKey(accountId), indexKey(accountId), settingsKey(accountId)]);
}
