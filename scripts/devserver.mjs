/**
 * Local preview: serves public/ and stubs the API.
 *
 *   DEV_SETUP_STATE=ready          (default) one connected account, served from data/seed.json
 *   DEV_SETUP_STATE=needs_storage  the storage gate (no KV)
 *   DEV_SETUP_STATE=needs_setup    first-load flow: key + password -> harden
 *
 * The state machine is in memory so the Playwright harness can walk the whole
 * first-run flow without Upstash or the HYROS MCP.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEMPLATE_VERSION } from '../api/_version.js';

// fileURLToPath, not .pathname: on Windows the pathname is "/C:/…", which join() mangles into a 404 for every file.
const ROOT = fileURLToPath(new URL('../public/', import.meta.url));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.gif': 'image/gif', '.woff2': 'font/woff2' };

const dev = {
  state: process.env.DEV_SETUP_STATE || 'ready',
  password: process.env.DEV_SETUP_STATE && process.env.DEV_SETUP_STATE !== 'ready' ? null : 'dev',
  pendingSecrets: process.env.DEV_SETUP_STATE === 'needs_setup',
  accounts: [],
};
if (dev.state === 'ready') {
  dev.accounts = [
    { id: 'acc_devprimary0', kind: 'key', label: 'demo@hyros.com', email: 'demo@hyros.com', company: 'Scale Ecom', status: 'APPROVED', keyStatus: 'ok', lastRefresh: '2026-09-14T09:05:00Z' },
    { id: 'acc_devagency00', kind: 'key', label: 'ops@growthlabs.agency', email: 'ops@growthlabs.agency', company: 'Growth Labs', agency: true, status: 'APPROVED', keyStatus: 'invalid', keyError: 'MCP rejected the API key (HTTP 401)', clientMode: 'arg', clientModeStatus: 'verified', clientsSyncedAt: '2026-09-14T09:00:00Z', lastRefresh: '2026-09-13T09:02:00Z' },
    { id: 'cli_devclient001', kind: 'client', parentId: 'acc_devagency00', label: 'Bright Peak Fit', email: 'owner@brightpeakfit.com', status: 'APPROVED', keyStatus: 'invalid', keyError: 'MCP rejected the API key (HTTP 401)', lastRefresh: '2026-09-13T09:05:00Z' },
    { id: 'cli_devclient002', kind: 'client', parentId: 'acc_devagency00', label: 'Lumen & Oak', email: 'hello@lumenandoak.com', status: 'PENDING', keyStatus: 'invalid', lastRefresh: null },
  ];
}

const setupState = () => ({
  ok: true, state: dev.state, storage: dev.state !== 'needs_storage', storeVia: dev.state !== 'needs_storage' ? 'KV_REST_API_URL' : null,
  passwordSource: dev.password ? 'kv' : null, masterPassword: false, keySecret: dev.password ? (dev.pendingSecrets ? 'kv' : 'env') : null,
  cronSecret: dev.password ? (dev.pendingSecrets ? 'kv' : 'env') : null, pendingSecrets: dev.pendingSecrets,
  accounts: dev.accounts.filter((a) => a.kind !== 'client').length, envKey: false, mcpUrl: 'https://mcp.hyros.com/mcp', createdAt: null,
});
/* Like _auth.js: the x-report-key header, a Bearer token, or (legacy) ?key=. The app itself only sends the header. */
const signedIn = (url, req) => {
  if (!dev.password) return false;
  const bearer = String(req?.headers?.authorization || '').startsWith('Bearer ') ? req.headers.authorization.slice(7) : null;
  return [req?.headers?.['x-report-key'], bearer, url.searchParams.get('key')].some((c) => c === dev.password);
};
/* Routes stay open until a password exists (the first-run screen needs them); after that, the password. */
const authed = (url, req) => !dev.password || signedIn(url, req);
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((resolve) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } }); });

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');

  if (url.pathname === '/api/setup') {
    if (req.method === 'GET') {
      const out = setupState();
      // Like api/setup.js: before sign-in (or before a password exists) only what the page needs to pick a screen.
      if (!signedIn(url, req)) {
        if (url.searchParams.get('secrets')) return json(res, 401, { ok: false, error: 'unauthorized' });
        return json(res, 200, { ok: true, state: out.state, storage: out.storage, pendingSecrets: out.pendingSecrets });
      }
      out.templateVersion = TEMPLATE_VERSION;
      if (url.searchParams.get('secrets')) {
        out.secrets = dev.pendingSecrets ? { ACCOUNT_KEY_SECRET: 'dev-generated-account-key-secret-0123456789abcdef', CRON_SECRET: 'dev-generated-cron-secret-0123456789abcdef' } : { ACCOUNT_KEY_SECRET: null, CRON_SECRET: null };
      }
      return json(res, 200, out);
    }
    const body = await readBody(req);
    if (body.action === 'setup') {
      if (dev.state === 'needs_storage') return json(res, 503, { ok: false, error: 'needs_storage', message: 'Storage is not set up yet.' });
      if (dev.password) return json(res, 409, { ok: false, error: 'exists', message: 'This dashboard is already set up.' });
      if (String(body.password || '').length < 8) return json(res, 400, { ok: false, error: 'weak', message: 'Use at least 8 characters.' });
      const key = String(body.apiKey || '').trim();
      // Same body shape as api/setup.js errorBody(): error (legacy), code (the MCP error code), message, detail.
      if (key === 'dead-key-000') return json(res, 400, { ok: false, error: 'bad_key', code: 'auth', message: 'HYROS rejected that key — copy it again from HYROS → Settings → API.', detail: 'MCP rejected the API key (HTTP 401)' });
      if (key === 'mcp-off-key-000') return json(res, 403, { ok: false, error: 'bad_key', code: 'forbidden', message: 'The key is valid but this account cannot use the MCP. Ask HYROS support to enable MCP access for it (it is granted per account).', detail: 'hyros_get_user_info: MCP is not enabled for this account' });
      if (key && key.length < 8) return json(res, 400, { ok: false, error: 'bad_key', message: 'That does not look like a HYROS API key.' });
      dev.accounts = []; dev.password = body.password; dev.pendingSecrets = true; dev.state = 'ready';
      let added = {};
      if (key) {
        const account = { id: `acc_${Buffer.from(key).toString('hex').slice(0, 12).padEnd(12, '0')}`, kind: 'key', label: 'you@yourbrand.test', email: 'you@yourbrand.test', status: 'APPROVED', keyStatus: 'ok', agency: Boolean(body.agency), lastRefresh: null };
        dev.accounts = [account]; added = { account, clientsFound: 0, clientsApproved: 0 };
      }
      return json(res, 200, { ...setupState(), ...added });
    }
    if (!authed(url, req)) return json(res, 401, { ok: false, error: 'unauthorized' });
    if (body.action === 'harden') { dev.pendingSecrets = false; return json(res, 200, { ok: true, done: { ACCOUNT_KEY_SECRET: true, CRON_SECRET: true }, remaining: { ACCOUNT_KEY_SECRET: false, CRON_SECRET: false }, envSet: { ACCOUNT_KEY_SECRET: true, CRON_SECRET: true } }); }
    if (body.action === 'change-password') { dev.password = body.password; return json(res, 200, setupState()); }
    if (body.action === 'reset') { dev.accounts = []; dev.password = null; dev.pendingSecrets = false; dev.state = 'needs_setup'; return json(res, 200, { ok: true, deleted: 7, ...setupState() }); }
    return json(res, 400, { ok: false, error: 'bad_request' });
  }

  if (url.pathname.startsWith('/api/') && !authed(url, req)) return json(res, 401, { ok: false, error: dev.password ? 'unauthorized' : 'setup_required' });

  if (url.pathname === '/api/data') {
    const account = url.searchParams.get('account') || dev.accounts.find((a) => a.kind !== 'client')?.id || null;
    const acct = dev.accounts.find((a) => a.id === account);
    if (!acct || !acct.lastRefresh) return json(res, 200, { ok: true, templateVersion: TEMPLATE_VERSION, origin: 'none', account, prefs: null, capabilities: { mcpConfigured: Boolean(account), storeConfigured: true }, snapshot: null });
    const seed = JSON.parse(await readFile(new URL('../data/seed.json', import.meta.url), 'utf8'));
    seed.origin = 'kv';
    return json(res, 200, { ok: true, templateVersion: TEMPLATE_VERSION, origin: 'kv', account, prefs: null, capabilities: { mcpConfigured: true, storeConfigured: true }, snapshot: seed });
  }
  if (url.pathname === '/api/drill') {
    return json(res, 200, { ok: false, error: 'dev', message: 'Dev server has no MCP — drill-downs need a deployed API. Demo mode drills work.' });
  }
  if (url.pathname === '/api/accounts') {
    if (req.method === 'GET') {
      return json(res, 200, { ok: true, defaultId: dev.accounts.find((a) => a.kind !== 'client')?.id || null, canAdd: true, accounts: dev.accounts });
    }
    if (req.method === 'DELETE') { const id = url.searchParams.get('id'); dev.accounts = dev.accounts.filter((a) => a.id !== id && a.parentId !== id); return json(res, 200, { ok: true }); }
    const body = await readBody(req);
    if (body.action === 'replace-key') return json(res, 200, { ok: true, account: dev.accounts.find((a) => a.id === body.id) });
    if (body.action === 'import-clients') return json(res, 200, { ok: true, added: 0, total: 0, offset: 0, remaining: 0, pending: 0 });
    if (String(body.apiKey || '').length < 8) return json(res, 400, { ok: false, error: 'bad_key', message: 'That does not look like a HYROS API key.' });
    if (body.apiKey === 'dead-key-000') return json(res, 400, { ok: false, error: 'bad_key', code: 'auth', message: 'HYROS rejected that key — copy it again from HYROS → Settings → API.', detail: 'MCP rejected the API key (HTTP 401)' });
    if (body.apiKey === 'mcp-off-key-000') return json(res, 403, { ok: false, error: 'bad_key', code: 'forbidden', message: 'The key is valid but this account cannot use the MCP. Ask HYROS support to enable MCP access for it (it is granted per account).', detail: 'hyros_get_user_info: MCP is not enabled for this account' });
    const id = `acc_${Buffer.from(body.apiKey).toString('hex').slice(0, 12).padEnd(12, '0')}`;
    const account = { id, kind: 'key', label: 'you@yourbrand.test', email: 'you@yourbrand.test', status: 'APPROVED', keyStatus: 'ok', agency: Boolean(body.agency), lastRefresh: null };
    dev.accounts = [...dev.accounts.filter((a) => a.id !== id), account]; dev.state = 'ready';
    return json(res, 200, { ok: true, account, clientsFound: 0, clientsApproved: 0 });
  }
  if (url.pathname === '/api/prefs') return json(res, 200, { ok: true, persisted: false, message: 'Dev server — saved in this browser only.' });
  if (url.pathname === '/api/refresh') {
    const account = url.searchParams.get('account') || dev.accounts.find((a) => a.kind !== 'client')?.id;
    const acct = dev.accounts.find((a) => a.id === account);
    if (!acct) return json(res, 503, { ok: false, error: 'not_configured', message: 'No HYROS account is connected yet.' });
    acct.lastRefresh = new Date().toISOString();
    return json(res, 200, { ok: true, account, persisted: true, ms: 1200, steps: ['dev: served the synthetic seed'], generatedAt: acct.lastRefresh });
  }
  // Call Intelligence stubs: the seed's demo block stands in for the KV index; writes need a deployed API.
  if (url.pathname === '/api/calls') {
    const seed = JSON.parse(await readFile(new URL('../data/seed.json', import.meta.url), 'utf8'));
    const blk = seed.calls || { rows: [], avatars: [], calls: {} };
    if (req.method === 'GET') {
      const id = url.searchParams.get('id');
      if (id) return blk.calls?.[id] ? json(res, 200, { ok: true, call: blk.calls[id] }) : json(res, 404, { ok: false, error: 'not_found' });
      return json(res, 200, { ok: true, rows: blk.rows, avatars: blk.avatars, updatedAt: blk.updatedAt, truncated: false, dropped: 0, connected: { anthropic: false, fathom: false, fireflies: false }, writeBack: { enabled: false }, readOnly: null, dev: true });
    }
    return json(res, 200, { ok: false, error: 'dev', message: 'Dev server has no model API or KV — paste, analyze and delete need a deployed API. The Demo account shows the full flow.' });
  }
  if (url.pathname === '/api/kb') {
    const { defaultKb, SCORECARD_TEMPLATES, DEFAULT_LEAD_CRITERIA, OUTCOMES } = await import('../api/_kb.js');
    if (req.method === 'GET') return json(res, 200, { ok: true, kb: defaultKb(), problems: [], templates: SCORECARD_TEMPLATES, defaultLeadCriteria: DEFAULT_LEAD_CRITERIA, outcomes: OUTCOMES, readOnly: null });
    return json(res, 200, { ok: false, error: 'dev', message: 'Dev server has no KV — the knowledge base is saved on a deployed API only.' });
  }
  if (url.pathname === '/api/integrations') {
    if (req.method === 'GET') return json(res, 200, { ok: true, items: [], firefliesSecret: null, origin: 'http://127.0.0.1:4321', kinds: ['anthropic', 'fathom', 'fireflies'], readOnly: null });
    return json(res, 200, { ok: false, error: 'dev', message: 'Dev server cannot reach vendors — connect integrations on a deployed API.' });
  }
  // Payment Links stubs: the seed's demo block stands in for KV; writes and vendors need a deployed API.
  if (url.pathname === '/api/paylinks') {
    const seed = JSON.parse(await readFile(new URL('../data/seed.json', import.meta.url), 'utf8'));
    const blk = seed.paylinks || { links: [], rows: [] };
    if (req.method === 'GET') {
      const base = 'http://127.0.0.1:4321';
      return json(res, 200, { ok: true, origin: base, base, links: blk.links.map((l) => ({ ...l, thankYouUrl: `${base}/ty?l=${l.token}`, sales: 0, revenueCents: 0 })), rows: blk.rows, totals: null, updatedAt: blk.updatedAt, truncated: false, settings: { template: 'light', headline: 'Thank You for Your Purchase!', message: 'Your payment was successful. We appreciate your business!', logoUrl: '', brand: '', accent: '', showOrder: true, showEmail: true, redirectUrl: '', countdownS: 0, domain: '', trackingScript: '', trackingSource: null, notifyUrl: '', updatedAt: null }, connected: { stripe: false, whop: false }, readOnly: null, dev: true });
    }
    const body = await readBody(req);
    if (body.action === 'preview') { const { renderPage } = await import('../api/ty.js'); return json(res, 200, { ok: true, html: renderPage({ settings: body.settings || {}, tx: { externalId: 'cs_test_SAMPLE0MW6J9Z8K', amountCents: 100, currency: 'usd', status: 'paid', items: [{ description: 'Sample product', quantity: 1, amountCents: 100 }] }, email: 'buyer@example.com', link: { name: 'Sample link' }, script: false }) }); }
    return json(res, 200, { ok: false, error: 'dev', message: 'Dev server has no Stripe or KV — create, import and verify need a deployed API.' });
  }
  if (url.pathname === '/ty') {
    const { renderPage } = await import('../api/ty.js');
    const email = url.searchParams.get('email');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(renderPage({ settings: { template: url.searchParams.get('template') || 'light', brand: 'Dev preview' }, tx: email ? { externalId: 'cs_test_DEV', amountCents: 100, currency: 'usd', status: 'paid', items: [{ description: 'Dev product', quantity: 1, amountCents: 100 }] } : null, email, link: { name: 'Dev link' }, script: false }));
  }
  if (url.pathname === '/api/health') {
    // The real route lists which of the 15 required tools the key cannot see; the stub pretends two are absent.
    return json(res, 200, { ok: true, setup: dev.state, dev: true, templateVersion: TEMPLATE_VERSION, toolCount: 13, hasAttributionTool: true, missingTools: ['hyros_get_lead_journey', 'hyros_get_lead_clicks'] });
  }

  const rel = url.pathname === '/' ? 'index.html' : normalize(url.pathname).replace(/^(\.\.[/\\])+/, '').replace(/^\//, '');
  try {
    const buf = await readFile(join(ROOT, rel));
    res.writeHead(200, { 'content-type': TYPES[extname(rel)] || 'application/octet-stream' });
    res.end(buf);
  } catch {
    res.writeHead(404); res.end('not found');
  }
});
server.listen(4321, () => console.log(`preview on http://127.0.0.1:4321  (DEV_SETUP_STATE=${dev.state})`));
