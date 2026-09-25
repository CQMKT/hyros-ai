/**
 * /api/integrations — model + note-taker keys for Call Intelligence
 * (password-gated, account-scoped; keys never come back out).
 *
 *   GET                                  status per integration + webhook URLs
 *   POST {kind, apiKey, model?}          connect (probes the key; Fathom registers its webhook)
 *   POST {action:'backfill', kind, days} queue the vendor's recent meetings as calls
 *   DELETE ?id=                          disconnect (Fathom webhook deleted best-effort)
 */
import { checkAccess, deny } from './_auth.js';
import { accountFromReq } from './_accounts.js';
import { storeConfigured, storeReadOnly } from './_store.js';
import { readIntegrations, publicIntegration, addIntegration, removeIntegration, firefliesSecret, backfill, KINDS } from './_integrations.js';
import { saveNewCall } from './_calls.js';
import { logEvent } from './_log.js';

export const maxDuration = 120;

/** This deployment's public origin (Vercel puts the real host in x-forwarded-host). */
export function originOf(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  const proto = req.headers['x-forwarded-proto'] || (host.startsWith('localhost') || host.startsWith('127.') ? 'http' : 'https');
  return host ? `${proto}://${host}` : '';
}

export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  const access = await checkAccess(req);
  if (!access.ok) return deny(res, access);
  const accountId = await accountFromReq(req);
  if (!accountId) return res.status(503).json({ ok: false, error: 'not_configured', message: 'No HYROS account is connected yet.' });
  const origin = originOf(req);
  try {
    if (req.method === 'GET') {
      const items = (await readIntegrations(accountId)).map((it) => publicIntegration(it, { origin }));
      const secret = await firefliesSecret(accountId);
      return res.status(200).json({ ok: true, account: accountId, items, firefliesSecret: secret, origin, kinds: KINDS, readOnly: storeReadOnly() });
    }
    if (!storeConfigured()) return res.status(503).json({ ok: false, error: 'needs_storage', message: 'Storage is not set up.' });
    if (storeReadOnly()) return res.status(409).json({ ok: false, error: 'read_only', message: 'Preview deployments are read-only — use the production URL.' });
    if (req.method === 'DELETE') {
      const url = new URL(req.url, `http://${req.headers.host || 'local'}`);
      const ok = await removeIntegration(accountId, url.searchParams.get('id') || '');
      return res.status(ok ? 200 : 404).json({ ok, error: ok ? undefined : 'not_found' });
    }
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
    const body = req.body || {};
    if (body.action === 'backfill') {
      const r = await backfill(accountId, body.kind, { days: Math.min(365, Math.max(1, Number(body.days) || 30)), max: Math.min(50, Math.max(1, Number(body.max) || 25)) });
      let added = 0; let duplicates = 0;
      for (const c of r.calls) { const { duplicate } = await saveNewCall(accountId, c); if (duplicate) duplicates += 1; else added += 1; }
      logEvent('integrations.backfill', { accountId, kind: body.kind, added, duplicates, more: r.more });
      return res.status(200).json({ ok: true, added, duplicates, more: r.more, message: `${added} call${added === 1 ? '' : 's'} queued${duplicates ? ` (${duplicates} already known)` : ''}. Analyze them from the Calls tab.` });
    }
    const it = await addIntegration(accountId, { kind: body.kind, apiKey: body.apiKey, origin, model: body.model || null });
    logEvent('integrations.added', { accountId, kind: it.kind, webhook: Boolean(it.webhookId) });
    return res.status(200).json({ ok: true, item: publicIntegration(it, { origin }), firefliesSecret: it.kind === 'fireflies' ? await firefliesSecret(accountId) : undefined });
  } catch (err) {
    logEvent('integrations.error', { accountId, kind: req.body?.kind || null, code: err.code || err.name || 'error', status: err.status || 500 });
    return res.status(err.status || 500).json({ ok: false, error: err.code || err.name || 'error', message: err.message });
  }
}
