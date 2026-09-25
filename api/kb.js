/**
 * /api/kb — the account's knowledge base for call analysis (password-gated,
 * account-scoped). See api/_kb.js for the shape.
 *
 *   GET              { kb, problems, templates, outcomes }
 *   POST { kb }      validate + save (lead criteria must total 100)
 */
import { checkAccess, deny } from './_auth.js';
import { accountFromReq } from './_accounts.js';
import { storeConfigured, storeReadOnly } from './_store.js';
import { readKb, writeKb, validateKb, SCORECARD_TEMPLATES, DEFAULT_LEAD_CRITERIA, OUTCOMES } from './_kb.js';

export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  const access = await checkAccess(req);
  if (!access.ok) return deny(res, access);
  const accountId = await accountFromReq(req);
  if (!accountId) return res.status(503).json({ ok: false, error: 'not_configured', message: 'No HYROS account is connected yet.' });
  try {
    if (req.method === 'GET') {
      const kb = await readKb(accountId);
      return res.status(200).json({ ok: true, account: accountId, kb, problems: validateKb(kb), templates: SCORECARD_TEMPLATES, defaultLeadCriteria: DEFAULT_LEAD_CRITERIA, outcomes: OUTCOMES, readOnly: storeReadOnly() });
    }
    if (req.method !== 'POST' && req.method !== 'PUT') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
    if (!storeConfigured()) return res.status(503).json({ ok: false, error: 'needs_storage', message: 'Storage is not set up.' });
    if (storeReadOnly()) return res.status(409).json({ ok: false, error: 'read_only', message: 'Preview deployments are read-only — use the production URL.' });
    const kb = await writeKb(accountId, req.body?.kb || req.body || {});
    return res.status(200).json({ ok: true, account: accountId, kb, problems: [] });
  } catch (err) {
    return res.status(err.status || 500).json({ ok: false, error: err.code || err.name || 'error', message: err.message, problems: err.problems || undefined });
  }
}
