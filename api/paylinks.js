/**
 * /api/paylinks — the Payment Links tab's backend (password-gated, account-scoped).
 *
 *   GET                                   links (+ sales/revenue), transactions index, settings, status
 *   POST {action:'create-link', name, description?, amountCents, currency?, interval?}   Stripe product → price → link
 *   POST {action:'list-stripe-links'}     existing Stripe payment links not yet imported
 *   POST {action:'import-links', ids}     import them and point their after-payment redirect at /ty
 *   POST {action:'add-whop-link', name, url, amountCents?, currency?}   register a Whop link's thank-you page
 *   POST {action:'update-link', id, name?, description?, active?}
 *   POST {action:'delete-link', id}       deactivates on Stripe (links cannot be deleted there) and forgets it
 *   POST {action:'settings', settings}    thank-you page, domain, tracking script, notifications
 *   POST {action:'fetch-script'}          pull the universal script from HYROS (hyros_get_account_tracking_script)
 *   POST {action:'verify', ids?}          read the paying emails back from HYROS (linked / found / missing)
 *   POST {action:'preview', settings?}    the page HTML with sample data (for the editor's iframe)
 *   DELETE ?tx=<id>
 */
import { checkAccess, deny } from './_auth.js';
import { accountFromReq, asAccount } from './_accounts.js';
import { storeConfigured, storeReadOnly } from './_store.js';
import { callTool } from './_mcp.js';
import { readLinks, addLink, updateLink, removeLink, publicLink, readIndex, readSettings, writeSettings, validateTrackingScript, verifyInHyros, deleteTx, thankYouBase, TEMPLATES, TEMPLATE_NAMES, CURRENCIES, INTERVALS } from './_paylinks.js';
import { integrationKey, readIntegrations } from './_integrations.js';
import { createPaymentLink, listPaymentLinks, paymentLinkLineItems, setRedirect, setActive, redirectUrlFor } from './_stripe.js';
import { renderPage } from './ty.js';
import { originOf } from './integrations.js';
import { logEvent } from './_log.js';

export const maxDuration = 60;
const fail = (message, status, code) => Object.assign(new Error(message), { status, code });

function guardWrites() {
  if (!storeConfigured()) throw fail('Storage is not set up — payment links cannot be stored.', 503, 'needs_storage');
  if (storeReadOnly()) throw fail('This is a preview deployment (read-only) — use the production URL.', 409, 'read_only');
}

/** Links with sales and revenue re-derived from the index rows. */
function linksWithStats(links, index, base) {
  return links.map((l) => {
    const rows = index.rows.filter((r) => r.linkId === l.id);
    const paid = rows.filter((r) => r.status === 'paid' || r.status === 'refunded');
    return { ...publicLink(l, { base }), sales: paid.length, revenueCents: paid.reduce((s, r) => s + (r.amountCents || 0) - (r.refundedCents || 0), 0), failed: rows.filter((r) => r.status === 'failed').length, lastSaleAt: paid[0]?.created || null };
  });
}

/** The script text out of whatever the MCP tool returns (a string, or an object with a script/html field). */
export function scriptFromTool(reply) {
  if (typeof reply === 'string') return reply;
  if (reply && typeof reply === 'object') {
    for (const k of ['script', 'trackingScript', 'universalScript', 'html', 'code', 'result']) if (typeof reply[k] === 'string') return reply[k];
    if (reply.result && typeof reply.result === 'object') return scriptFromTool(reply.result);
  }
  return '';
}

export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  const access = await checkAccess(req);
  if (!access.ok) return deny(res, access);
  const accountId = await accountFromReq(req);
  if (!accountId) return res.status(503).json({ ok: false, error: 'not_configured', message: 'No HYROS account is connected yet — add one from the account menu.' });
  const origin = originOf(req);
  const url = new URL(req.url, `http://${req.headers.host || 'local'}`);
  try {
    if (req.method === 'GET') {
      const [links, index, settings, integrations] = await Promise.all([readLinks(accountId), readIndex(accountId), readSettings(accountId), readIntegrations(accountId)]);
      const base = thankYouBase(settings, origin);
      return res.status(200).json({
        ok: true, account: accountId, origin, base, links: linksWithStats(links, index, base), ...index, settings,
        connected: { stripe: integrations.some((i) => i.kind === 'stripe'), whop: integrations.some((i) => i.kind === 'whop') },
        templates: TEMPLATES.map((id) => ({ id, name: TEMPLATE_NAMES[id] })), currencies: CURRENCIES, intervals: INTERVALS, readOnly: storeReadOnly(),
      });
    }
    if (req.method === 'DELETE') {
      guardWrites();
      const ok = await deleteTx(accountId, url.searchParams.get('tx') || '');
      return res.status(ok ? 200 : 400).json({ ok, error: ok ? undefined : 'bad_request' });
    }
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
    const body = req.body || {};
    const action = String(body.action || '');
    if (action === 'preview') {
      const settings = { ...(await readSettings(accountId)), ...(body.settings && typeof body.settings === 'object' ? body.settings : {}) };
      const sample = { externalId: 'cs_live_SAMPLE0MW6J9Z8K', amountCents: 100, currency: 'usd', status: 'paid', items: [{ description: 'Vincent test product', quantity: 1, amountCents: 100 }] };
      return res.status(200).json({ ok: true, html: renderPage({ settings, tx: sample, email: 'austin@example.com', link: { name: 'Sample link' }, script: false }) });
    }
    guardWrites();
    const settings = await readSettings(accountId);
    const base = thankYouBase(settings, origin);

    if (action === 'create-link') {
      const key = await integrationKey(accountId, 'stripe');
      if (!key) throw fail('Connect Stripe first (Setup → Integrations).', 409, 'not_connected');
      const amountCents = Math.round(Number(body.amountCents));
      if (!body.name || !Number.isFinite(amountCents) || amountCents < 50) throw fail('A name and an amount of at least 0.50 are required.', 400, 'bad_request');
      const link = await addLink(accountId, { source: 'stripe', name: body.name, description: body.description, amountCents, currency: body.currency, interval: body.interval || null });
      try {
        const made = await createPaymentLink(key, { name: link.name, description: link.description, amountCents: link.amountCents, currency: link.currency, interval: link.interval, redirectUrl: redirectUrlFor(base, link.token), token: link.token });
        const updated = await updateLink(accountId, link.id, { url: made.url, stripeId: made.id, productId: made.productId, priceId: made.priceId, active: made.active });
        logEvent('paylinks.created', { accountId, linkId: link.id, stripeId: made.id });
        return res.status(200).json({ ok: true, link: { ...publicLink(updated, { base }), sales: 0, revenueCents: 0 } });
      } catch (err) { await removeLink(accountId, link.id); throw err; }
    }
    if (action === 'list-stripe-links') {
      const key = await integrationKey(accountId, 'stripe');
      if (!key) throw fail('Connect Stripe first.', 409, 'not_connected');
      const known = new Set((await readLinks(accountId)).map((l) => l.stripeId).filter(Boolean));
      const raw = await listPaymentLinks(key, { limit: 100 });
      const out = [];
      for (const l of raw.filter((x) => !known.has(x.id)).slice(0, 25)) {
        let items = [];
        try { items = await paymentLinkLineItems(key, l.id); } catch { items = []; }
        out.push({ id: l.id, url: l.url, active: l.active !== false, name: items[0]?.description || l.id, amountCents: items.reduce((s, i) => s + (i.amountCents || 0), 0), currency: items[0]?.currency || 'usd', interval: items[0]?.interval || null, redirect: l.after_completion?.type === 'redirect' ? l.after_completion.redirect?.url || null : null });
      }
      return res.status(200).json({ ok: true, candidates: out, more: raw.length > 25 });
    }
    if (action === 'import-links') {
      const key = await integrationKey(accountId, 'stripe');
      if (!key) throw fail('Connect Stripe first.', 409, 'not_connected');
      const ids = (Array.isArray(body.ids) ? body.ids : []).map(String).filter((id) => /^plink_[A-Za-z0-9]+$/.test(id)).slice(0, 25);
      const raw = await listPaymentLinks(key, { limit: 100 });
      const imported = []; const errors = [];
      for (const id of ids) {
        const l = raw.find((x) => x.id === id);
        if (!l) { errors.push(`${id}: not found on Stripe`); continue; }
        let items = []; try { items = await paymentLinkLineItems(key, id); } catch { items = []; }
        const link = await addLink(accountId, { source: 'stripe', name: body.names?.[id] || items[0]?.description || id, amountCents: items.reduce((s, i) => s + (i.amountCents || 0), 0), currency: items[0]?.currency || 'usd', interval: items[0]?.interval || null, stripeId: id, url: l.url, active: l.active !== false, imported: true });
        try { await setRedirect(key, id, redirectUrlFor(base, link.token)); imported.push(publicLink(link, { base })); }
        catch (err) { await removeLink(accountId, link.id); errors.push(`${id}: ${err.message}`); }
      }
      logEvent('paylinks.imported', { accountId, count: imported.length, errors: errors.length });
      return res.status(200).json({ ok: true, imported, errors });
    }
    if (action === 'add-whop-link') {
      if (!body.name || !/^https?:\/\//.test(String(body.url || ''))) throw fail('A name and the Whop checkout URL are required.', 400, 'bad_request');
      const link = await addLink(accountId, { source: 'whop', name: body.name, description: body.description, url: body.url, amountCents: Math.max(0, Math.round(Number(body.amountCents) || 0)), currency: body.currency, interval: body.interval || null, whopPlanId: body.planId || null });
      return res.status(200).json({ ok: true, link: { ...publicLink(link, { base }), sales: 0, revenueCents: 0 }, note: `Set this as the post-purchase redirect for the Whop checkout: ${publicLink(link, { base }).thankYouUrl}&payment_id={PAYMENT_ID} (Whop's placeholder, if offered) — otherwise the webhook records the sale and the page shows a neutral thank-you.` });
    }
    if (action === 'update-link') {
      const links = await readLinks(accountId); const cur = links.find((l) => l.id === body.id);
      if (!cur) throw fail('Unknown link.', 404, 'not_found');
      if (body.active !== undefined && Boolean(body.active) !== cur.active && cur.stripeId) {
        const key = await integrationKey(accountId, 'stripe');
        if (key) await setActive(key, cur.stripeId, Boolean(body.active));
      }
      const link = await updateLink(accountId, body.id, { name: body.name, description: body.description, active: body.active });
      return res.status(200).json({ ok: true, link: publicLink(link, { base }) });
    }
    if (action === 'delete-link') {
      const links = await readLinks(accountId); const cur = links.find((l) => l.id === body.id);
      if (!cur) throw fail('Unknown link.', 404, 'not_found');
      if (cur.stripeId) { try { const key = await integrationKey(accountId, 'stripe'); if (key) await setActive(key, cur.stripeId, false); } catch { /* best effort */ } }
      await removeLink(accountId, body.id);
      return res.status(200).json({ ok: true });
    }
    if (action === 'settings') {
      const saved = await writeSettings(accountId, { ...settings, ...(body.settings || {}) });
      return res.status(200).json({ ok: true, settings: saved, base: thankYouBase(saved, origin) });
    }
    if (action === 'fetch-script') {
      let reply;
      try { reply = await asAccount(accountId, () => callTool('hyros_get_account_tracking_script', {}, { timeoutMs: 15000 })); }
      catch (err) { throw fail(`HYROS did not return the script (${err.message}). Paste it from HYROS → Tracking → Universal Script instead.`, 502, 'mcp'); }
      const text = scriptFromTool(reply);
      const v = validateTrackingScript(text.includes('<script') ? text : `<script>${text}</script>`);
      if (!v.ok) throw fail(`HYROS returned something unexpected — paste the script by hand. (${v.reason})`, 502, 'mcp');
      const saved = await writeSettings(accountId, { ...settings, trackingScript: v.value, trackingSource: 'hyros' });
      return res.status(200).json({ ok: true, settings: saved });
    }
    if (action === 'verify') {
      const index = await readIndex(accountId);
      const ids = Array.isArray(body.ids) && body.ids.length ? body.ids.map(String) : index.rows.filter((r) => r.status === 'paid' && r.email && (!r.hyros || body.recheck)).slice(0, 50).map((r) => r.id);
      const r = await verifyInHyros(accountId, ids);
      return res.status(200).json({ ok: true, ...r, index: await readIndex(accountId) });
    }
    return res.status(400).json({ ok: false, error: 'bad_request', message: 'Unknown action.' });
  } catch (err) {
    logEvent('paylinks.error', { accountId, action: req.body?.action || req.method, code: err.code || err.name || 'error', status: err.status || 500 });
    return res.status(err.status || 500).json({ ok: false, error: err.code || err.name || 'error', message: err.message });
  }
}
