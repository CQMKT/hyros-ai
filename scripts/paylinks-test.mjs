/**
 * Payment Links — end-to-end tests against an in-memory KV, the mock MCP
 * and a mock Stripe API. Covers: Stripe form encoding + client errors,
 * connect (probe + webhook registered), create link (product → price →
 * link with the redirect carrying {CHECKOUT_SESSION_ID} and the token),
 * import (redirect rewritten), the /ty flow (302 with &email=, then 200
 * HTML with the script, the email and noindex; unknown token/session →
 * neutral page), page ↔ webhook dedupe, Stripe signature known answer /
 * tamper / stale, failed-payment rows, Verify in HYROS against the mock
 * MCP, settings validation, rollups, the hand-off assertions, cleanup.
 *
 *   node scripts/paylinks-test.mjs
 */
import { createHmac } from 'node:crypto';
import { Readable } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { startMockKv } from './mock-kv.mjs';
import { startMock, mock as mcp } from './mock-mcp.mjs';
import { startMockStripe, mock as stripeMock, requests as stripeRequests, checkoutSession } from './mock-stripe.mjs';

let failures = 0;
const check = (name, ok, extra = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${extra}`}`); if (!ok) failures += 1; };

process.env.KV_REST_API_URL = 'http://127.0.0.1:4328'; process.env.KV_REST_API_TOKEN = 'test-token';
process.env.HYROS_MCP_URL = 'http://127.0.0.1:4329/mcp';
process.env.STRIPE_API_URL = 'http://127.0.0.1:4327';
delete process.env.ACCOUNT_KEY_SECRET; delete process.env.CRON_SECRET; delete process.env.REPORT_PASSWORD; delete process.env.VERCEL_ENV;

const { server: kvServer, store: kvStore } = await startMockKv(4328);
const mcpServer = await startMock(4329);
const stripeServer = await startMockStripe(4327);

const stripe = await import('../api/_stripe.js');
const pay = await import('../api/_paylinks.js');
const setup = await import('../api/_setup.js');
const accounts = await import('../api/_accounts.js');
const integrations = await import('../api/_integrations.js');
const rollup = await import('../public/features/paylinks/rollup.js');
const tyRoute = (await import('../api/ty.js')).default;
const { renderPage } = await import('../api/ty.js');
const paylinksRoute = (await import('../api/paylinks.js')).default;
const integrationsRoute = (await import('../api/integrations.js')).default;
const ingestRoute = (await import('../api/ingest.js')).default;
const { build: buildStep } = await import('../public/features/paylinks/server.js');

const PASSWORD = 'pay-links-pass';
const fakeRes = () => { const r = { code: 200, body: null, headers: {}, text: null }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; r.send = (t) => { r.text = t; return r; }; r.end = (t) => { r.text = t ?? r.text; return r; }; r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; }; return r; };
const fakeReq = ({ method = 'GET', url = '/', body = undefined, headers = {} } = {}) => ({ method, url, body, headers: { host: 'app.test', 'x-forwarded-proto': 'https', 'x-report-key': PASSWORD, ...headers } });
const streamReq = ({ url, body, headers }) => Object.assign(Readable.from([Buffer.from(body)]), { method: 'POST', url, headers: { host: 'app.test', 'content-type': 'application/json', ...headers } });

try {
  console.log('\nStripe client');
  {
    const enc = stripe.encodeForm({ line_items: [{ price: 'price_1', quantity: 1 }], after_completion: { type: 'redirect', redirect: { url: 'https://x/ty?l=t&session_id={CHECKOUT_SESSION_ID}' } }, enabled_events: ['a', 'b'] }).join('&');
    check('encodeForm uses Stripe bracket notation for arrays and nested objects', /line_items%5B0%5D%5Bprice%5D=price_1/.test(enc) && /after_completion%5Bredirect%5D%5Burl%5D=/.test(enc) && /enabled_events%5B1%5D=b/.test(enc), enc);
    let e = null; try { await stripe.probe('sk_test_dead'); } catch (err) { e = err; }
    check('a rejected key is bad_key', e?.code === 'bad_key', e?.message);
    check('redirectUrlFor carries the token and the {CHECKOUT_SESSION_ID} placeholder', stripe.redirectUrlFor('https://x.test/', 'abc') === 'https://x.test/ty?l=abc&session_id={CHECKOUT_SESSION_ID}');
    const s = stripe.normalizeSession(checkoutSession({ id: 'cs_test_norm', customer_details: { email: 'Buyer@Example.TEST', name: 'B' }, amount_total: 1500, currency: 'USD' }));
    check('normalizeSession lower-cases the email and reads the amount, currency, status', s.email === 'buyer@example.test' && s.amountCents === 1500 && s.currency === 'usd' && s.status === 'paid' && s.items[0].description === 'Vincent test product');
    const secret = 'whsec_testsecret'; const body = '{"id":"evt_1","type":"checkout.session.completed"}'; const t = Math.floor(Date.now() / 1000);
    const sig = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
    check('verifySignature accepts a correct Stripe-Signature', stripe.verifySignature(`t=${t},v1=${sig}`, body, secret).ok);
    check('… refuses a tampered body and a stale timestamp', !stripe.verifySignature(`t=${t},v1=${sig}`, `${body} `, secret).ok && /tolerance/.test(stripe.verifySignature(`t=${t - 1000},v1=${sig}`, body, secret).reason));
    const failed = stripe.txFromEvent({ type: 'payment_intent.payment_failed', data: { object: { id: 'pi_f', amount: 4900, currency: 'usd', receipt_email: 'x@y.test', last_payment_error: { message: 'card_declined' }, created: 1700000000 } } });
    check('txFromEvent maps a failed payment intent to a failed row', failed?.status === 'failed' && failed.amountCents === 4900 && failed.failure === 'card_declined' && failed.email === 'x@y.test');
    check('txFromEvent ignores events it does not log', stripe.txFromEvent({ type: 'customer.created', data: { object: {} } }) === null);
  }

  console.log('\nStore + settings');
  const state = await setup.setPassword(PASSWORD);
  check('setup ready on the in-memory KV', state.state === 'ready');
  const accountId = (await accounts.addAccount('mock-key-0002')).account.id;
  {
    const v = pay.validateTrackingScript('<script>\nvar s=document.createElement("script");s.src="https://214375.t.hyros.com/v1/lst/universal-script?ph=abc&tag=!clicked&ref_url="+encodeURI(document.URL);document.head.appendChild(s);\n</script>');
    check('a real HYROS universal script validates', v.ok);
    check('a script without hyros.com, or with an iframe, is refused', !pay.validateTrackingScript('<script>alert(1)</script>').ok && !pay.validateTrackingScript('<script src="https://t.hyros.com/x"></script><iframe src="x"></iframe>').ok);
    let e = null; try { await pay.writeSettings(accountId, { trackingScript: '<script>evil</script>' }); } catch (err) { e = err; }
    check('writeSettings refuses a bad script (400 bad_script)', e?.status === 400 && e?.code === 'bad_script');
    const saved = await pay.writeSettings(accountId, { template: 'bold', headline: 'Woo', domain: 'https://confirm.example.test/', countdownS: 500, accent: 'red', trackingScript: v.value });
    check('settings normalize: template kept, domain stripped, countdown capped, bad accent dropped', saved.template === 'bold' && saved.domain === 'confirm.example.test' && saved.countdownS === 120 && saved.accent === '' && saved.trackingSource === 'pasted');
    check('thankYouBase prefers the custom domain', pay.thankYouBase(saved, 'https://app.test') === 'https://confirm.example.test' && pay.thankYouBase({ domain: '' }, 'https://app.test/') === 'https://app.test');
    await pay.writeSettings(accountId, { ...saved, domain: '' });
  }

  console.log('\nConnect Stripe + create / import links (route contracts)');
  let res = fakeRes(); await integrationsRoute(fakeReq({ method: 'POST', url: `/api/integrations?account=${accountId}`, body: { kind: 'stripe', apiKey: 'sk_test_mock' } }), res);
  check('connecting Stripe probes the key and registers a webhook endpoint at /api/ingest?src=stripe', res.code === 200 && res.body.item.webhookRegistered && /\/api\/ingest\?src=stripe&t=[0-9a-f]{32}$/.test(res.body.item.webhookUrl) && stripeRequests.some((r) => r.method === 'POST' && r.path === '/v1/webhook_endpoints' && r.body.url.includes('src=stripe')), JSON.stringify(res.body));
  const stripeToken = new URL(res.body.item.webhookUrl).searchParams.get('t');
  const stripeSecret = (await integrations.readIntegrations(accountId)).find((i) => i.kind === 'stripe');
  check('the webhook signing secret is stored encrypted', Boolean(stripeSecret.secretEnc) && !JSON.stringify(stripeSecret).includes('whsec_mock'));
  res = fakeRes(); await integrationsRoute(fakeReq({ method: 'POST', url: `/api/integrations?account=${accountId}`, body: { kind: 'stripe', apiKey: 'pk_live_nope' } }), res);
  check('a publishable key is refused before any Stripe call', res.code === 400 && res.body.error === 'bad_key');

  res = fakeRes(); await paylinksRoute(fakeReq({ method: 'POST', url: `/api/paylinks?account=${accountId}`, body: { action: 'create-link', name: 'Vincent test product', amountCents: 100, currency: 'usd' } }), res);
  const link = res.body?.link;
  check('create-link makes a product, a price and a payment link on Stripe', res.code === 200 && link?.stripeId && link.url?.startsWith('https://buy.stripe.com/') && ['/v1/products', '/v1/prices', '/v1/payment_links'].every((p) => stripeRequests.some((r) => r.method === 'POST' && r.path === p)), JSON.stringify(res.body));
  const created = stripeRequests.find((r) => r.method === 'POST' && r.path === '/v1/payment_links');
  check('the link\'s after-payment redirect is /ty with the link token and {CHECKOUT_SESSION_ID}', created?.body.after_completion?.type === 'redirect' && created.body.after_completion.redirect.url === `https://app.test/ty?l=${link.token}&session_id={CHECKOUT_SESSION_ID}` && created.body.metadata?.aihyros_link === link.token, JSON.stringify(created?.body));
  check('the dashboard gets the thank-you URL for the link', link.thankYouUrl === `https://app.test/ty?l=${link.token}`);
  res = fakeRes(); await paylinksRoute(fakeReq({ method: 'POST', url: `/api/paylinks?account=${accountId}`, body: { action: 'create-link', name: 'x', amountCents: 10 } }), res);
  check('create-link refuses amounts under 0.50', res.code === 400);

  stripeMock.links.push({ id: 'plink_existing', object: 'payment_link', url: 'https://buy.stripe.com/test_existing', active: true, after_completion: { type: 'hosted_confirmation' }, metadata: {}, line_items: [{ description: 'Old offer', quantity: 1, amount_total: 4900, currency: 'usd', price: { unit_amount: 4900, currency: 'usd', recurring: { interval: 'month' } } }] });
  res = fakeRes(); await paylinksRoute(fakeReq({ method: 'POST', url: `/api/paylinks?account=${accountId}`, body: { action: 'list-stripe-links' } }), res);
  check('list-stripe-links shows only links not yet imported, with their amount and billing', res.code === 200 && res.body.candidates.length === 1 && res.body.candidates[0].id === 'plink_existing' && res.body.candidates[0].amountCents === 4900 && res.body.candidates[0].interval === 'month', JSON.stringify(res.body));
  res = fakeRes(); await paylinksRoute(fakeReq({ method: 'POST', url: `/api/paylinks?account=${accountId}`, body: { action: 'import-links', ids: ['plink_existing', 'plink_missing'] } }), res);
  const imported = res.body?.imported?.[0];
  check('import-links registers the link and rewrites its redirect on Stripe; unknown ids are reported', res.code === 200 && imported?.imported === true && imported.stripeId === 'plink_existing' && res.body.errors.length === 1 && stripeMock.links.find((l) => l.id === 'plink_existing').after_completion.redirect.url === `https://app.test/ty?l=${imported.token}&session_id={CHECKOUT_SESSION_ID}`, JSON.stringify(res.body));

  console.log('\nThe thank-you page (/ty)');
  stripeMock.sessions.cs_test_buyer1 = checkoutSession({ id: 'cs_test_buyer1', customer_details: { email: 'lead1@example.test', name: 'Lead One' }, payment_link: link.stripeId, metadata: { aihyros_link: link.token } });
  res = fakeRes(); await tyRoute(fakeReq({ url: `/ty?l=${link.token}&session_id=cs_test_buyer1`, headers: { 'x-report-key': undefined } }), res);
  check('first hit: the session is resolved and the page redirects to itself with &email=', res.code === 302 && res.headers.location === `/ty?l=${link.token}&session_id=cs_test_buyer1&email=lead1%40example.test`, `${res.code} ${res.headers.location}`);
  let idx = await pay.readIndex(accountId);
  check('the transaction is recorded from the page with the link attached', idx.rows.length === 1 && idx.rows[0].status === 'paid' && idx.rows[0].linkId === link.id && idx.rows[0].via.includes('page') && idx.rows[0].emailPassed === false, JSON.stringify(idx.rows[0]));
  res = fakeRes(); await tyRoute(fakeReq({ url: `/ty?l=${link.token}&session_id=cs_test_buyer1&email=lead1%40example.test` }), res);
  check('second hit: 200 HTML with the HYROS script in <head>, the email, order details, noindex, no-store', res.code === 200 && /^<!doctype html>/i.test(res.text) && res.text.indexOf('t.hyros.com') < res.text.indexOf('</head>') && res.text.includes('lead1@example.test') && res.text.includes('Order Details') && res.headers['x-robots-tag'] === 'noindex, nofollow' && res.headers['cache-control'] === 'no-store', `${res.code} ${res.text?.slice(0, 120)}`);
  check('… and a hidden email input as a second capture path', /<input type="email" name="email" value="lead1@example.test">/.test(res.text));
  idx = await pay.readIndex(accountId);
  check('the second hit marks emailPassed and does not create a second row', idx.rows.length === 1 && idx.rows[0].emailPassed === true && idx.rows[0].status === 'paid');
  check('the second hit reused the stored session (one Stripe retrieve, not two)', stripeRequests.filter((r) => r.path === '/v1/checkout/sessions/cs_test_buyer1').length === 1);
  res = fakeRes(); await tyRoute(fakeReq({ url: `/ty?l=${'0'.repeat(32)}&session_id=cs_test_buyer1` }), res);
  check('an unknown token renders a neutral thank-you page (200, no script, no email)', res.code === 200 && res.text.includes('Thank You') && !res.text.includes('t.hyros.com') && !res.text.includes('class="email"') && !res.text.includes('type="email"'), `${res.code}`);
  res = fakeRes(); await tyRoute(fakeReq({ url: `/ty?l=${link.token}&session_id=cs_test_nope` }), res);
  check('an unknown session still renders the account\'s thank-you page with its script (never an error for a buyer)', res.code === 200 && res.text.includes('class="card"') && res.text.includes('t.hyros.com') && !res.text.includes('class="email"'));
  res = fakeRes(); await tyRoute(fakeReq({ url: `/ty?l=${link.token}&session_id={CHECKOUT_SESSION_ID}` }), res);
  check('the raw placeholder (link opened without paying) renders the neutral page', res.code === 200);
  const html = renderPage({ settings: { template: 'dark', redirectUrl: 'https://x.test/next', countdownS: 5, brand: 'CQ <b>' }, tx: { externalId: 'cs_x', amountCents: 250000, currency: 'eur', status: 'paid', items: [] }, email: 'a@b.c', script: false });
  check('renderPage escapes settings, formats money in the tx currency and adds the countdown', html.includes('CQ &lt;b&gt;') && html.includes('€2,500.00') && html.includes('id="cd">5<') && html.includes('#0f1115'));

  console.log('\nWebhooks');
  const sign = (b, secret, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${b}`).digest('hex')}`;
  const secretPlain = (await import('../api/_accounts.js')).decryptKey(stripeSecret.secretEnc);
  const evt = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', data: { object: checkoutSession({ id: 'cs_test_buyer1', customer_details: { email: 'lead1@example.test', name: 'Lead One' }, payment_link: link.stripeId, metadata: { aihyros_link: link.token } }) } });
  res = fakeRes(); await ingestRoute(streamReq({ url: `/api/ingest?src=stripe&t=${stripeToken}`, body: evt, headers: { 'stripe-signature': sign(evt, secretPlain) } }), res);
  check('a signed checkout.session.completed for a session the page already saw merges into the same row', res.code === 200 && res.body.duplicate === true && (await pay.readIndex(accountId)).rows.length === 1 && (await pay.readIndex(accountId)).rows[0].via.includes('webhook'), JSON.stringify(res.body));
  const evt2 = JSON.stringify({ id: 'evt_2', type: 'checkout.session.completed', data: { object: checkoutSession({ id: 'cs_test_buyer2', customer_details: { email: 'lead2@example.test' }, payment_link: link.stripeId }) } });
  res = fakeRes(); await ingestRoute(streamReq({ url: `/api/ingest?src=stripe&t=${stripeToken}`, body: evt2, headers: { 'stripe-signature': sign(evt2, secretPlain) } }), res);
  check('a webhook-only sale (buyer closed the tab) is recorded and matched to the link by payment_link id', res.code === 200 && res.body.duplicate === false && (await pay.readIndex(accountId)).rows.find((r) => r.email === 'lead2@example.test')?.linkId === link.id);
  const evt3 = JSON.stringify({ id: 'evt_3', type: 'payment_intent.payment_failed', data: { object: { id: 'pi_fail1', amount: 100, currency: 'usd', receipt_email: 'lead3@example.test', last_payment_error: { message: 'insufficient_funds' }, created: 1700000000 } } });
  res = fakeRes(); await ingestRoute(streamReq({ url: `/api/ingest?src=stripe&t=${stripeToken}`, body: evt3, headers: { 'stripe-signature': sign(evt3, secretPlain) } }), res);
  check('a failed payment lands as its own failed row', res.code === 200 && res.body.status === 'failed' && (await pay.readIndex(accountId)).totals.failed === 1);
  res = fakeRes(); await ingestRoute(streamReq({ url: `/api/ingest?src=stripe&t=${stripeToken}`, body: evt2, headers: { 'stripe-signature': 't=1,v1=00' } }), res);
  check('a bad Stripe signature is refused with 401', res.code === 401);
  res = fakeRes(); await ingestRoute(streamReq({ url: `/api/ingest?src=stripe&t=${stripeToken}`, body: JSON.stringify({ type: 'customer.created', data: { object: {} } }), headers: { 'stripe-signature': sign(JSON.stringify({ type: 'customer.created', data: { object: {} } }), secretPlain) } }), res);
  check('unrelated events are acknowledged and ignored', res.code === 200 && /ignored/.test(JSON.stringify(res.body)));

  console.log('\nVerify in HYROS, index, route GET');
  res = fakeRes(); await paylinksRoute(fakeReq({ method: 'POST', url: `/api/paylinks?account=${accountId}`, body: { action: 'verify' } }), res);
  check('verify reads the paying emails back from HYROS: lead1/lead2 are linked (first source), the failed row is skipped', res.code === 200 && res.body.checked === 2 && res.body.linked === 2 && res.body.index.rows.filter((r) => r.hyros?.linked).length === 2, JSON.stringify({ checked: res.body.checked, linked: res.body.linked, error: res.body.error }));
  mcp.failNext({ tool: 'hyros_get_leads', status: 500, body: 'boom' });
  res = fakeRes(); await paylinksRoute(fakeReq({ method: 'POST', url: `/api/paylinks?account=${accountId}`, body: { action: 'verify', recheck: true } }), res);
  check('an MCP failure during verify is reported, not thrown', res.code === 200 && Boolean(res.body.error));
  mcp.reset();
  res = fakeRes(); await paylinksRoute(fakeReq({ url: `/api/paylinks?account=${accountId}` }), res);
  check('GET /api/paylinks returns links with sales/revenue, rows, totals, settings and connection status, no keys', res.code === 200 && res.body.links.find((l) => l.id === link.id)?.sales === 2 && res.body.links.find((l) => l.id === link.id).revenueCents === 200 && res.body.totals.paid === 2 && res.body.connected.stripe === true && !JSON.stringify(res.body).includes('sk_test_mock') && !JSON.stringify(res.body).includes('whsec_'), JSON.stringify(res.body.totals));
  res = fakeRes(); await paylinksRoute(fakeReq({ url: `/api/paylinks?account=${accountId}`, headers: { 'x-report-key': 'wrong' } }), res);
  check('GET without the password is 401', res.code === 401);
  res = fakeRes(); await paylinksRoute(fakeReq({ method: 'POST', url: `/api/paylinks?account=${accountId}`, body: { action: 'preview', settings: { template: 'corporate', headline: 'Hi there' } } }), res);
  check('preview returns the page HTML with sample data and no script', res.code === 200 && res.body.html.includes('Hi there') && !res.body.html.includes('t.hyros.com'));
  res = fakeRes(); await paylinksRoute(fakeReq({ method: 'POST', url: `/api/paylinks?account=${accountId}`, body: { action: 'update-link', id: link.id, active: false } }), res);
  check('deactivating a link updates it on Stripe', res.code === 200 && res.body.link.active === false && stripeMock.links.find((l) => l.id === link.stripeId).active === false);
  const failedId = (await pay.readIndex(accountId)).rows.find((r) => r.status === 'failed').id;
  res = fakeRes(); await paylinksRoute(fakeReq({ method: 'DELETE', url: `/api/paylinks?account=${accountId}&tx=${failedId}` }), res);
  check('DELETE ?tx= removes a transaction and re-derives the totals', res.code === 200 && (await pay.readIndex(accountId)).totals.failed === 0);
  res = fakeRes(); await paylinksRoute(fakeReq({ method: 'POST', url: `/api/paylinks?account=${accountId}`, body: { action: 'delete-link', id: imported.id } }), res);
  check('delete-link forgets the link and its token', res.code === 200 && (await pay.findLinkByToken(imported.token)) === null);

  console.log('\nRollups, server step, hand-off');
  {
    const rows = [
      { status: 'paid', amountCents: 1000, currency: 'usd', emailPassed: true, hyros: { found: true, linked: true }, created: new Date().toISOString(), linkId: 'a' },
      { status: 'refunded', amountCents: 1000, refundedCents: 1000, currency: 'usd', emailPassed: true, hyros: { found: true, linked: false }, created: new Date().toISOString(), linkId: 'a' },
      { status: 'failed', amountCents: 500, currency: 'usd', created: new Date().toISOString(), linkId: 'a' },
      { status: 'paid', amountCents: 3000, currency: 'usd', emailPassed: false, hyros: null, created: new Date().toISOString(), linkId: 'b' },
    ];
    const t = rollup.totals(rows);
    check('totals: revenue net of refunds, shares re-derived from counts', t.paid === 3 && t.revenueCents === 4000 && t.failed === 1 && Math.round(t.emailShare * 100) === 67 && t.checked === 2 && t.linked === 1 && t.linkedShare === 0.5, JSON.stringify(t));
    const hb = rollup.hyrosBuckets(rows);
    check('hyrosBuckets splits paid rows into linked / found / missing / unchecked', hb.linked === 1 && hb.foundOnly === 1 && hb.missing === 0 && hb.unchecked === 1);
    check('byDay returns 14 buckets ending today', rollup.byDay(rows, 14).length === 14 && rollup.byDay(rows, 14)[13].sales === 3);
    check('formatMoney renders in the transaction currency', rollup.formatMoney(150000, 'usd') === '$1,500.00' && rollup.formatMoney(9900, 'eur') === '€99.00');
    const blk = await buildStep({ snapshot: { payIntel: { links: [{ id: 'a' }], rows: [{ id: 't1' }], totals: { paid: 1 }, updatedAt: 'x' } }, previous: null, timeLeft: () => 5000, now: new Date('2026-09-25T10:00:00Z') });
    check('server.js copies payIntel into the block', blk.links.length === 1 && blk.rows.length === 1 && blk.built === '2026-09-25T10:00:00.000Z');
    const vercelJson = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
    check('vercel.json rewrites /ty to the function and sizes paylinks/ty', vercelJson.rewrites?.some((r) => r.source === '/ty' && r.destination === '/api/ty') && vercelJson.functions['api/paylinks.js']?.maxDuration === 60 && vercelJson.functions['api/ty.js']?.maxDuration === 30);
    const appJs = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
    check('app.js scopes /api/paylinks to the selected account', /ACCOUNT_SCOPED = new Set\(\[[^\]]*'\/api\/paylinks'/.test(appJs));
    const snapSrc = await readFile(new URL('../api/_snapshot.js', import.meta.url), 'utf8');
    check('buildSnapshot accepts payIntel and exposes it to feature steps', /payIntel = null/.test(snapSrc) && /callIntel, payIntel, account/.test(snapSrc));
    await accounts.removeAccount(accountId);
    check('removing the account deletes its links, transactions, settings and tokens', [...kvStore.keys()].every((k) => !k.includes(`:${accountId}:`) && !k.startsWith('aihyros:paylink:')), [...kvStore.keys()].filter((k) => k.includes(accountId) || k.startsWith('aihyros:paylink:')).join(', '));
  }
} finally {
  kvServer.close(); mcpServer.close(); stripeServer.close();
}

console.log(failures ? `\n${failures} payment-links check(s) failed.` : '\nAll payment-links checks passed.');
process.exitCode = failures ? 1 : 0;
