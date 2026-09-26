/**
 * GET /ty?l=<linkToken>&session_id=cs_…   (Stripe)   — rewritten from /ty in vercel.json
 * GET /ty?l=<linkToken>&payment_id=pay_…  (Whop, experimental)
 *
 * The thank-you page that fixes the different-email problem. Stripe sends
 * the buyer here after paying; the page resolves the Checkout Session with
 * the account's Stripe key, records the transaction, and — once — redirects
 * to itself with `&email=<buyer>` appended. The second load renders the
 * page with the account's HYROS universal script in the <head>: the script
 * reads the email from the URL while the browser still holds the HYROS
 * session from the opt-in, so HYROS links the paying email to the clicks.
 *
 * Public by design; the only secrets involved never leave the server. A
 * buyer must never see an error: anything unexpected renders a neutral
 * thank-you page and logs an event.
 */
import { findLinkByToken, recordTransaction, readSettings, readTx, txIdFor, notify, defaultSettings } from './_paylinks.js';
import { integrationKey } from './_integrations.js';
import { retrieveCheckoutSession } from './_stripe.js';
import { retrievePayment } from './_whop.js';
import { storeConfigured } from './_store.js';
import { logEvent } from './_log.js';

export const maxDuration = 30;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (cents, currency) => { try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: String(currency || 'usd').toUpperCase() }).format((cents || 0) / 100); } catch { return `${((cents || 0) / 100).toFixed(2)} ${String(currency || 'usd').toUpperCase()}`; } };

const THEMES = {
  dark: { bg: '#0f1115', card: '#171a21', ink: '#f5f5f7', muted: '#9aa0ab', accent: '#4ade80', border: 'rgba(255,255,255,.08)', shadow: '0 24px 60px rgba(0,0,0,.5)' },
  light: { bg: '#f6f7f9', card: '#ffffff', ink: '#111318', muted: '#6b7280', accent: '#22c55e', border: 'rgba(0,0,0,.06)', shadow: '0 20px 50px rgba(15,23,42,.08)' },
  minimal: { bg: '#ffffff', card: '#ffffff', ink: '#111111', muted: '#777777', accent: '#111111', border: 'transparent', shadow: 'none' },
  bold: { bg: 'linear-gradient(135deg,#6d5cff 0%,#ff6cab 100%)', card: '#ffffff', ink: '#14121f', muted: '#6b6480', accent: '#ff3d81', border: 'transparent', shadow: '0 30px 80px rgba(20,18,31,.35)' },
  corporate: { bg: '#eef2f7', card: '#ffffff', ink: '#0b1f3a', muted: '#5b6b82', accent: '#1d4ed8', border: 'rgba(11,31,58,.08)', shadow: '0 16px 40px rgba(11,31,58,.10)' },
};

/** The page HTML. `tx` may be null (neutral page); `email` is what the URL/session gave us. */
export function renderPage({ settings, tx = null, email = null, link = null, script = true } = {}) {
  const s = { ...defaultSettings(), ...(settings || {}) };
  const t = { ...(THEMES[s.template] || THEMES.light) };
  if (s.accent) t.accent = s.accent;
  const order = tx && s.showOrder ? `<div class="order"><div class="order-title">Order Details</div>
      <div class="row"><span>Order Number:</span><b>${esc(String(tx.externalId || tx.id || '').slice(-8).toUpperCase())}</b></div>
      ${tx.items?.[0]?.description ? `<div class="row"><span>Item:</span><b>${esc(tx.items[0].description)}</b></div>` : (link?.name ? `<div class="row"><span>Item:</span><b>${esc(link.name)}</b></div>` : '')}
      <div class="row"><span>Amount:</span><b>${esc(money(tx.amountCents, tx.currency))}</b></div>
      <div class="row"><span>Status:</span><b class="ok">${esc(tx.status === 'paid' ? 'Completed' : tx.status === 'unpaid' ? 'Processing' : tx.status)}</b></div>
    </div>` : '';
  const redirect = s.redirectUrl ? (s.countdownS > 0
    ? `<p class="redir">Redirecting in <b id="cd">${esc(s.countdownS)}</b>s… <a href="${esc(s.redirectUrl)}">continue now</a></p><script>(function(){var n=${Number(s.countdownS)};var el=document.getElementById('cd');var i=setInterval(function(){n-=1;if(el)el.textContent=n;if(n<=0){clearInterval(i);location.href=${JSON.stringify(s.redirectUrl)};}},1000);})();</script>`
    : `<p class="redir"><a class="btn" href="${esc(s.redirectUrl)}">Continue →</a></p>`) : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>${esc(s.brand ? `${s.brand} — ` : '')}Thank you</title>
${script && s.trackingScript ? `${s.trackingScript}\n` : ''}<style>
:root{--bg:${t.bg};--card:${t.card};--ink:${t.ink};--muted:${t.muted};--accent:${t.accent};--border:${t.border};--shadow:${t.shadow}}
*{box-sizing:border-box}html,body{margin:0;min-height:100%}body{background:var(--bg);color:var(--ink);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,Helvetica,Arial,sans-serif;display:flex;align-items:center;justify-content:center;padding:32px 16px;min-height:100vh}
.card{background:var(--card);border:1px solid var(--border);border-radius:18px;box-shadow:var(--shadow);max-width:640px;width:100%;padding:48px 40px;text-align:center}
.logo{max-height:48px;max-width:220px;margin:0 auto 24px;display:block}.brand{font-weight:600;color:var(--muted);margin-bottom:24px;letter-spacing:.02em}
.check{width:96px;height:96px;border-radius:50%;background:var(--accent);margin:0 auto 28px;display:flex;align-items:center;justify-content:center}.check svg{width:44px;height:44px;stroke:#fff;stroke-width:4;fill:none;stroke-linecap:round;stroke-linejoin:round}
h1{font-size:34px;line-height:1.15;margin:0 0 12px;font-weight:800;letter-spacing:-.02em}p{margin:0 0 8px;color:var(--muted);font-size:17px}
.email{display:inline-block;margin:22px 0 6px;padding:10px 18px;border-radius:10px;background:rgba(127,127,127,.12);color:var(--ink);font-weight:500}.small{font-size:13px}
.order{margin:28px auto 0;max-width:460px;border:1px solid var(--border);background:rgba(127,127,127,.06);border-radius:12px;padding:18px 20px;text-align:left}.order-title{text-align:center;font-weight:600;margin-bottom:10px}
.row{display:flex;justify-content:space-between;gap:12px;padding:6px 0;font-size:14px}.row span{color:var(--muted)}.row b{font-weight:600}.row .ok{color:var(--accent)}
.redir{margin-top:26px}.btn{display:inline-block;background:var(--accent);color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600}a{color:var(--accent)}
@media(max-width:520px){.card{padding:36px 22px}h1{font-size:28px}}
</style></head>
<body><main class="card">
${s.logoUrl ? `<img class="logo" src="${esc(s.logoUrl)}" alt="${esc(s.brand || 'logo')}">` : (s.brand ? `<div class="brand">${esc(s.brand)}</div>` : '')}
<div class="check" aria-hidden="true"><svg viewBox="0 0 48 48"><path d="M10 25 L20 35 L38 14"/></svg></div>
<h1>${esc(s.headline)}</h1>
<p>${esc(s.message)}</p>
${email && s.showEmail ? `<div class="email">${esc(email)}</div><p class="small">You will receive a confirmation email shortly.</p>` : ''}
${order}${redirect}
</main>
${email ? `<form hidden aria-hidden="true"><input type="email" name="email" value="${esc(email)}"></form>` : ''}
</body></html>`;
}

const html = (res, status, body) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.setHeader('cache-control', 'no-store'); res.setHeader('x-robots-tag', 'noindex, nofollow'); res.status(status).send(body); };

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.setHeader('allow', 'GET'); return res.status(405).end(); }
  const url = new URL(req.url, `http://${req.headers.host || 'local'}`);
  const token = url.searchParams.get('l');
  const found = storeConfigured() && token ? await findLinkByToken(token).catch(() => null) : null;
  if (!found) {
    logEvent('ty.unknown', { token: Boolean(token) });
    return html(res, 200, renderPage({ settings: defaultSettings(), script: false }));
  }
  const { accountId, link } = found;
  const settings = await readSettings(accountId);
  const sessionId = url.searchParams.get('session_id');
  const paymentId = url.searchParams.get('payment_id');
  const urlEmail = String(url.searchParams.get('email') || '').trim().toLowerCase() || null;
  let tx = null;
  let email = urlEmail;

  try {
    if (link.source === 'stripe' && sessionId && sessionId !== '{CHECKOUT_SESSION_ID}') {
      const known = await readTx(accountId, txIdFor('stripe', sessionId));
      let data = null;
      if (known?.email) { data = { ...known, source: 'stripe' }; }
      else {
        const key = await integrationKey(accountId, 'stripe');
        if (key) data = { ...(await retrieveCheckoutSession(key, sessionId)), source: 'stripe' };
      }
      if (data) {
        const r = await recordTransaction(accountId, { ...data, emailPassed: Boolean(urlEmail && data.email && urlEmail === data.email) }, { via: 'page', linkId: link.id, linkToken: link.token });
        tx = r.tx; email = data.email || urlEmail;
        if (r.created && tx.status === 'paid') notify(settings, tx, { linkName: link.name }).catch(() => {});
      }
    } else if (link.source === 'whop' && paymentId) {
      const known = await readTx(accountId, txIdFor('whop', paymentId));
      let data = known?.email ? { ...known, source: 'whop' } : null;
      if (!data) { const key = await integrationKey(accountId, 'whop'); if (key) data = await retrievePayment(key, paymentId); }
      if (data) {
        const r = await recordTransaction(accountId, { ...data, emailPassed: Boolean(urlEmail && data.email && urlEmail === data.email) }, { via: 'page', linkId: link.id, linkToken: link.token });
        tx = r.tx; email = data.email || urlEmail;
        if (r.created && tx.status === 'paid') notify(settings, tx, { linkName: link.name }).catch(() => {});
      }
    }
  } catch (err) {
    logEvent('ty.resolve.failed', { accountId, source: link.source, code: err.code || err.name || 'error' });
  }

  // The one hop that makes the email visible to the script: same URL + &email=.
  if (email && urlEmail !== email) {
    url.searchParams.set('email', email);
    res.setHeader('cache-control', 'no-store');
    res.setHeader('location', `${url.pathname}?${url.searchParams.toString()}`);
    return res.status(302).end();
  }
  logEvent('ty.render', { accountId, linkId: link.id, source: link.source, hasEmail: Boolean(email), recorded: Boolean(tx) });
  return html(res, 200, renderPage({ settings, tx, email, link }));
}
