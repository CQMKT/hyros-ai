/**
 * Payment Links — the tab. Sub-views: Overview · Links · Transactions ·
 * Setup. Reads ctx.block (links + newest transactions copied into the
 * snapshot at refresh) and, on live accounts, re-pulls through
 * ctx.api('/api/paylinks'). Every data string goes through ctx.esc; the
 * view never throws on a missing or marker block.
 */
import { totals as rollTotals, byLink, byDay, hyrosBuckets, newestFirst, formatMoney, STATUS_LABEL, isPaid } from './rollup.js';
import { DEMO_SETTINGS } from './demo.js';

const MARKERS = ['skipped', 'error', 'stale'];
const REFRESH_MS = 30000;
const TEMPLATES = [['dark', 'Dark Modern', '#0f1115'], ['light', 'Light & Clean', '#f6f7f9'], ['minimal', 'Minimal', '#ffffff'], ['bold', 'Bold & Vibrant', 'linear-gradient(135deg,#6d5cff,#ff6cab)'], ['corporate', 'Corporate Professional', '#eef2f7']];
const states = new WeakMap();
const state = (root) => {
  if (!states.has(root)) states.set(root, { view: 'overview', live: null, fetchedAt: 0, loading: false, msg: null, err: null, busy: false, settings: null, integrations: null, candidates: null, preview: null, filters: { status: '', link: '', q: '' }, showCreate: false, showImport: false, showWhop: false, selected: new Set() });
  return states.get(root);
};
const dataOf = (b) => (b && typeof b === 'object' ? Object.fromEntries(Object.entries(b).filter(([k]) => !MARKERS.includes(k))) : {});
const pctText = (v) => (v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`);
const chip = (id, label, active) => `<button type="button" class="chip${active ? ' active' : ''}" data-nav="${id}">${label}</button>`;
const srcPill = (s, esc) => `<span class="pill paylinks-${esc(s)}">${esc(s)}</span>`;
const statusPill = (s, esc) => `<span class="pill ${s === 'paid' ? 'ok' : s === 'failed' ? 'bad' : s === 'refunded' ? 'warn' : ''}">${esc(STATUS_LABEL[s] || s)}</span>`;
const hyrosPill = (r, esc) => (!isPaid(r) ? '' : !r.hyros ? '<span class="pill paylinks-unchecked">unchecked</span>' : r.hyros.linked ? `<span class="pill paylinks-linked" title="${esc(r.hyros.firstSource || '')}">linked · ${esc(r.hyros.firstSource || 'source')}</span>` : r.hyros.found ? '<span class="pill paylinks-found">lead found, no source yet</span>' : '<span class="pill paylinks-missing">not in HYROS</span>');

function blockOf(ctx, st) {
  const base = dataOf(ctx.block);
  if (ctx.demo) return { ...base, settings: DEMO_SETTINGS, base: `https://${DEMO_SETTINGS.domain}`, connected: { stripe: true, whop: true }, links: (base.links || []).map((l) => ({ ...l, thankYouUrl: `https://${DEMO_SETTINGS.domain}/ty?l=${l.token}` })) };
  if (!st.live) return { ...base, settings: null, base: '', connected: null, links: (base.links || []).map((l) => ({ ...l, thankYouUrl: l.token ? `${location.origin}/ty?l=${l.token}` : null })) };
  return { ...base, ...st.live, links: st.live.links || base.links || [], rows: st.live.rows || base.rows || [] };
}

async function loadLive(ctx, st, { force = false } = {}) {
  if (ctx.demo || typeof ctx.api !== 'function') return;
  if (!force && (st.loading || Date.now() - st.fetchedAt < REFRESH_MS)) return;
  st.loading = true;
  try {
    const { body } = await ctx.api('/api/paylinks');
    if (body?.ok) { st.live = body; st.err = null; if (!st.settings || force) st.settings = JSON.parse(JSON.stringify(body.settings || {})); }
    else if (body?.error && body.error !== 'not_configured') st.err = body.message || body.error;
  } catch (err) { st.err = err.message; }
  finally { st.loading = false; st.fetchedAt = Date.now(); }
  render(ctx);
}

async function post(ctx, st, payload) {
  if (typeof ctx.api !== 'function') return null;
  st.busy = true; st.msg = 'Working…'; st.err = null; render(ctx);
  let body = null;
  try {
    ({ body } = await ctx.api('/api/paylinks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }));
    if (!body?.ok) st.err = body?.message || body?.error || 'Request failed.'; else st.msg = null;
  } catch (err) { st.err = err.message; }
  st.busy = false;
  return body;
}

/* ---------- pieces ---------- */

function statusLine(b, ctx) {
  const { esc, fmt } = ctx;
  if (!b || typeof b !== 'object') return '';
  if (b.error) return `<br><b>Error:</b> ${esc(b.error)}`;
  if (b.skipped && b.stale) return `<br><b>Showing the previous result</b>${b.built ? ` (${esc(fmt.datetime(b.built))})` : ''} — skipped this refresh: ${esc(b.skipped)}.`;
  if (b.skipped) return `<br>Skipped this refresh (${esc(b.skipped)}) — nothing was copied yet. Hit Refresh again.`;
  return '';
}

function nav(ctx, st, b) {
  const rows = b.rows || [];
  return `<div class="paylinks-nav"><div class="chipset">${[['overview', 'Overview'], ['links', 'Links'], ['transactions', 'Transactions'], ['setup', 'Setup']].map(([id, l]) => chip(id, l, st.view === id)).join('')}</div>
    <span class="sub">${ctx.esc((b.links || []).length)} link${(b.links || []).length === 1 ? '' : 's'} · ${ctx.esc(rows.length)} transaction${rows.length === 1 ? '' : 's'}${b.updatedAt ? ` · ${ctx.esc(ctx.fmt.datetime(b.updatedAt))}` : ''}${st.loading ? ' · loading…' : ''}</span>
    <div class="spacer"></div><div class="paylinks-actions">${!ctx.demo ? `<button type="button" data-act="reload" ${st.busy ? 'disabled' : ''}>↻ Reload</button>` : ''}${st.view === 'links' ? `<button type="button" class="primary" data-act="toggle-create">${st.showCreate ? 'Close' : '+ Create payment link'}</button>` : ''}</div></div>
    ${st.err ? `<div class="note err"><b>Problem.</b> ${ctx.esc(st.err)}</div>` : ''}${st.msg ? `<div class="note">${ctx.esc(st.msg)}</div>` : ''}`;
}

function overviewView(ctx, st, b) {
  const { esc, fmt, kpis } = ctx;
  const rows = b.rows || [];
  const t = rollTotals(rows);
  const days = byDay(rows, 14);
  const max = Math.max(1, ...days.map((d) => d.revenueCents));
  const hb = hyrosBuckets(rows);
  const per = byLink(rows, b.links || []);
  const cur = t.currency;
  return `<div class="kpis">${kpis([
    { label: 'Sales', value: fmt.int(t.paid), sub: t.refunded ? `${fmt.int(t.refunded)} refunded` : 'paid transactions' },
    { label: 'Revenue', value: formatMoney(t.revenueCents, cur), sub: t.mixed ? 'mixed currencies' : 'net of refunds', cls: t.revenueCents > 0 ? 'good' : '' },
    { label: 'Avg order', value: t.avgOrderCents === null ? '—' : formatMoney(t.avgOrderCents, cur), sub: 'per paid transaction' },
    { label: 'Email passed', value: pctText(t.emailShare), sub: 'page loaded with the buyer email', cls: t.emailShare !== null && t.emailShare >= 0.9 ? 'good' : '' },
    { label: 'Linked in HYROS', value: t.checked ? pctText(t.linkedShare) : '—', sub: t.checked ? `${fmt.int(t.linked)} of ${fmt.int(t.checked)} checked` : 'run Verify in HYROS', cls: t.linkedShare !== null && t.linkedShare >= 0.8 ? 'good' : '' },
    { label: 'Failed', value: fmt.int(t.failed), sub: 'from webhooks', cls: t.failed ? 'bad' : '' },
  ])}</div>
  <div class="fcols">
    <div class="fpanel"><h3>Last 14 days</h3><div class="fhint">revenue per day (net) — hover for the number</div>
      <div class="paylinks-days">${days.map((d, i) => `<i class="${i === days.length - 1 ? 'hi' : ''}" style="height:${Math.round((d.revenueCents / max) * 100)}%" title="${esc(d.day)} · ${esc(d.sales)} sale${d.sales === 1 ? '' : 's'} · ${esc(formatMoney(d.revenueCents, cur))}"></i>`).join('')}</div>
      <div class="paylinks-daylabels">${days.map((d) => `<span>${esc(d.day.slice(8))}</span>`).join('')}</div></div>
    <div class="fpanel"><h3>HYROS link check</h3><div class="fhint">paid transactions, by what HYROS knows about the paying email</div>
      ${[['linked', 'Linked (lead exists with a source)', 'ok'], ['foundOnly', 'Lead found, no source yet', ''], ['missing', 'Not in HYROS', 'bad'], ['unchecked', 'Not checked yet', '']].map(([k, label, cls]) => `<div class="fshare"><div class="fshare-head"><span>${esc(label)}</span><b class="${cls}">${esc(fmt.int(hb[k]))}</b></div></div>`).join('')}
      <div class="sub" style="margin-top:8px">A "different email" purchase shows as linked once HYROS has the paying email as a lead with the booking lead's first source. Run <b>Verify in HYROS</b> under Transactions.</div></div>
  </div>
  <div class="fpanel"><h3>By link</h3><div class="fhint">sales and revenue per payment link</div>
    ${per.length ? `<div class="table-wrap"><table class="paylinks-table"><thead><tr><th>Link</th><th class="num">Sales</th><th class="num">Revenue</th><th class="num">Failed</th><th class="num">Linked</th><th>Last sale</th></tr></thead><tbody>${per.map((p) => `<tr><td><span class="paylinks-title">${esc(p.link.name)}</span> ${srcPill(p.link.source, esc)}</td><td class="num">${esc(p.sales)}</td><td class="num paylinks-money">${esc(formatMoney(p.revenueCents, p.currency))}</td><td class="num ${p.failed ? 'bad' : ''}">${esc(p.failed)}</td><td class="num">${esc(pctText(p.linkedShare))}</td><td>${p.lastSaleAt ? esc(fmt.datetime(p.lastSaleAt)) : '—'}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No links yet — create one under Links.</div>'}</div>
  <div class="fpanel"><h3>How it works</h3>
    ${[['1', 'The rep drops a payment link from here into the call.', 'Created on Stripe with its after-payment redirect pointed at this deployment\'s thank-you page.'], ['2', 'The buyer pays on Stripe with any email.', 'Stripe sends them to /ty with the Checkout Session id.'], ['3', 'The page resolves the paying email and reloads itself with &email= in the URL.', 'Your HYROS universal script (Setup → Tracking) runs on that page and reads it.'], ['4', 'HYROS links the paying email to the browser session that carries the ad clicks.', 'The booking email and the paying email become one journey; the sale is attributed.']].map(([n, t1, t2]) => `<div class="paylinks-step"><b>${n}</b><div>${esc(t1)}<span class="sub">${esc(t2)}</span></div></div>`).join('')}</div>`;
}

function linksView(ctx, st, b) {
  const { esc, fmt } = ctx;
  const links = b.links || [];
  const per = new Map(byLink(b.rows || [], links).map((p) => [p.link.id, p]));
  const ro = ctx.demo ? 'disabled' : '';
  const create = st.showCreate ? `<div class="fpanel"><h3>Create a Stripe payment link</h3><div class="fhint">a product, a price and a payment link are created on Stripe with the redirect already set${b.connected && !b.connected.stripe ? ' — <span class="bad">connect Stripe under Setup first</span>' : ''}</div>
    <form class="paylinks-form" data-form="create"><div class="paylinks-row4"><label>Name<input type="text" name="name" placeholder="e.g. Sales Accelerator — Setup" required ${ro}></label><label>Amount<input type="number" name="amount" min="0.5" step="0.01" placeholder="1500.00" required ${ro}></label><label>Currency<select name="currency" ${ro}>${['usd', 'eur', 'gbp', 'cad', 'aud'].map((c) => `<option value="${c}">${c.toUpperCase()}</option>`).join('')}</select></label><label>Billing<select name="interval" ${ro}><option value="">One-time</option><option value="month">Monthly</option><option value="year">Yearly</option><option value="week">Weekly</option></select></label></div>
    <label>Description (optional)<input type="text" name="description" ${ro}></label>
    <div class="paylinks-inline"><button type="submit" class="primary" ${st.busy || ctx.demo ? 'disabled' : ''}>Create on Stripe</button><button type="button" data-act="toggle-import" ${ro}>Import existing Stripe links…</button><button type="button" data-act="toggle-whop" ${ro}>Register a Whop link…</button></div></form></div>` : '';
  const imp = st.showImport ? `<div class="fpanel"><h3>Import existing Stripe payment links</h3><div class="fhint">their "after payment" behaviour will be changed to redirect to this thank-you page — the links themselves stay the same</div>
    ${st.candidates === null ? '<div class="empty">Loading your Stripe payment links…</div>' : st.candidates.length ? `<form class="paylinks-form" data-form="import"><div class="paylinks-import">${st.candidates.map((c) => `<label><input type="checkbox" name="ids" value="${esc(c.id)}"> <span><b>${esc(c.name)}</b> · ${esc(formatMoney(c.amountCents, c.currency))}${c.interval ? ` / ${esc(c.interval)}` : ''}${c.redirect ? `<span class="sub">currently redirects to ${esc(c.redirect)}</span>` : '<span class="sub">currently shows Stripe\'s confirmation page</span>'}</span></label>`).join('')}</div><div class="paylinks-inline"><button type="submit" class="primary" ${st.busy ? 'disabled' : ''}>Import selected</button></div></form>` : '<div class="empty">No Stripe payment links found that are not already here.</div>'}</div>` : '';
  const whop = st.showWhop ? `<div class="fpanel"><h3>Register a Whop checkout link</h3><div class="fhint">Whop links are created in Whop; register one here to get its thank-you URL and record its sales (webhook) <span class="pill warn">experimental</span></div>
    <form class="paylinks-form" data-form="whop"><div class="paylinks-row4"><label>Name<input type="text" name="name" required></label><label>Amount<input type="number" name="amount" min="0" step="0.01"></label><label>Currency<select name="currency">${['usd', 'eur', 'gbp'].map((c) => `<option value="${c}">${c.toUpperCase()}</option>`).join('')}</select></label><label>Billing<select name="interval"><option value="">One-time</option><option value="month">Monthly</option><option value="year">Yearly</option></select></label></div><label>Whop checkout URL<input type="url" name="url" placeholder="https://whop.com/checkout/plan_…" required></label><div class="paylinks-inline"><button type="submit" class="primary" ${st.busy ? 'disabled' : ''}>Register</button></div></form></div>` : '';
  return `${create}${imp}${whop}
  <div class="win"><div class="winbar"><i></i><i></i><i></i><span>app.hyros.com &middot; payment links</span></div><div class="table-wrap">
  <table class="paylinks-table"><thead><tr><th>Date</th><th>Link name</th><th class="num">Amount</th><th>Thank-you page</th><th>Stats</th><th>Status</th><th>Actions</th></tr></thead>
  <tbody>${links.length ? links.map((l) => { const p = per.get(l.id); return `<tr>
    <td><span class="sub">${esc(fmt.datetime(l.createdAt))}</span></td>
    <td><span class="paylinks-title">${esc(l.name)}</span> ${srcPill(l.source, esc)}${l.imported ? ' <span class="pill">imported</span>' : ''}${l.url ? `<span class="paylinks-meta"><a href="${esc(l.url)}" target="_blank" rel="noopener">View link →</a></span>` : ''}</td>
    <td class="num"><span class="paylinks-money">${esc(formatMoney(l.amountCents, l.currency))}</span>${l.interval ? `<span class="paylinks-meta">per ${esc(l.interval)}</span>` : ''}</td>
    <td><span class="paylinks-url">${esc(l.thankYouUrl || '')}</span>${l.thankYouUrl ? `<span class="paylinks-meta"><button type="button" class="linkish" data-copy="${esc(l.thankYouUrl)}">copy</button></span>` : ''}</td>
    <td>${p ? `${esc(p.sales)} sale${p.sales === 1 ? '' : 's'} · ${esc(formatMoney(p.revenueCents, p.currency))}` : '—'}</td>
    <td>${l.active ? '<span class="pill ok">Active</span>' : '<span class="pill">Inactive</span>'}</td>
    <td class="paylinks-actions">${!ctx.demo ? `<button type="button" data-act="rename" data-id="${esc(l.id)}" ${st.busy ? 'disabled' : ''}>Rename</button><button type="button" data-act="toggle-active" data-id="${esc(l.id)}" data-active="${l.active ? '1' : '0'}" ${st.busy ? 'disabled' : ''}>${l.active ? 'Deactivate' : 'Activate'}</button><button type="button" class="danger" data-act="delete-link" data-id="${esc(l.id)}" ${st.busy ? 'disabled' : ''}>Delete</button>` : ''}</td>
  </tr>`; }).join('') : `<tr><td colspan="7"><div class="empty">${ctx.demo ? 'No demo links.' : 'No payment links yet. Create one, or import your existing Stripe links.'}</div></td></tr>`}</tbody></table></div></div>`;
}

function transactionsView(ctx, st, b) {
  const { esc, fmt } = ctx;
  const links = b.links || [];
  const nameOf = (id) => links.find((l) => l.id === id)?.name || null;
  const all = newestFirst(b.rows || []);
  const f = st.filters; const q = f.q.trim().toLowerCase();
  const rows = all.filter((r) => (!f.status || r.status === f.status) && (!f.link || r.linkId === f.link) && (!q || [r.email, r.name, nameOf(r.linkId)].some((v) => String(v || '').toLowerCase().includes(q))));
  const unchecked = all.filter((r) => isPaid(r) && r.email && !r.hyros).length;
  return `<div class="calls-filters paylinks-nav"><input type="search" data-filter="q" value="${esc(f.q)}" placeholder="Search email, name, link…"><select data-filter="status"><option value="">All statuses</option>${Object.entries(STATUS_LABEL).map(([v, l]) => `<option value="${v}"${f.status === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select><select data-filter="link"><option value="">All links</option>${links.map((l) => `<option value="${esc(l.id)}"${f.link === l.id ? ' selected' : ''}>${esc(l.name)}</option>`).join('')}</select><span class="rowcount">${esc(rows.length)} shown</span><div class="spacer"></div>${!ctx.demo ? `<button type="button" class="primary" data-act="verify" ${st.busy || !unchecked ? 'disabled' : ''}>Verify ${unchecked ? `${unchecked} ` : ''}in HYROS</button><button type="button" data-act="verify-all" ${st.busy ? 'disabled' : ''}>Re-check all</button>` : ''}</div>
  <div class="win"><div class="winbar"><i></i><i></i><i></i><span>app.hyros.com &middot; transactions</span></div><div class="table-wrap">
  <table class="paylinks-table"><thead><tr><th>Date</th><th>Buyer</th><th class="num">Amount</th><th>Status</th><th>Link</th><th>Recorded via</th><th>HYROS</th>${!ctx.demo ? '<th></th>' : ''}</tr></thead>
  <tbody>${rows.length ? rows.map((r) => `<tr>
    <td><span class="sub">${esc(fmt.datetime(r.created))}</span></td>
    <td>${r.email ? `<button type="button" class="drill" data-journey="${esc(r.email)}">${esc(r.email)}</button>` : '<span class="sub">no email</span>'}${r.name ? `<span class="paylinks-meta">${esc(r.name)}</span>` : ''}</td>
    <td class="num"><span class="paylinks-money ${r.status === 'failed' ? 'bad' : ''}">${esc(formatMoney(r.amountCents, r.currency))}</span>${r.refundedCents ? `<span class="paylinks-meta">refunded ${esc(formatMoney(r.refundedCents, r.currency))}</span>` : ''}${r.failure ? `<span class="paylinks-meta bad">${esc(r.failure)}</span>` : ''}</td>
    <td>${statusPill(r.status, esc)}${r.mode === 'subscription' ? ' <span class="pill">sub</span>' : ''}</td>
    <td>${esc(nameOf(r.linkId) || '—')} ${srcPill(r.source, esc)}</td>
    <td><span class="sub">${esc((r.via || []).join(' + ') || '—')}</span>${isPaid(r) ? `<span class="paylinks-meta ${r.emailPassed ? 'good' : 'bad'}">${r.emailPassed ? 'email passed to page' : 'email not passed'}</span>` : ''}</td>
    <td>${hyrosPill(r, esc)}${r.hyros?.stage ? `<span class="paylinks-meta">stage ${esc(r.hyros.stage)}</span>` : ''}</td>
    ${!ctx.demo ? `<td><button type="button" class="linkish" data-act="delete-tx" data-id="${esc(r.id)}" ${st.busy ? 'disabled' : ''}>remove</button></td>` : ''}
  </tr>`).join('') : `<tr><td colspan="8"><div class="empty">${all.length ? 'No transactions match these filters.' : 'No transactions yet — they appear when a buyer lands on a thank-you page or Stripe sends a webhook.'}</div></td></tr>`}</tbody></table></div></div>`;
}

function setupView(ctx, st, b) {
  const { esc } = ctx;
  const s = ctx.demo ? DEMO_SETTINGS : st.settings;
  if (!s) return '<div class="fpanel"><div class="empty">Loading setup…</div></div>';
  const ro = ctx.demo ? 'disabled' : '';
  const connected = b.connected || {};
  const base = b.base || '';
  const inp = (path, value, { type = 'text', placeholder = '', extra = '' } = {}) => `<input type="${type}" data-path="${esc(path)}" value="${esc(value ?? '')}" placeholder="${esc(placeholder)}" ${ro} ${extra}>`;
  const intRow = (kind, label, hint, extraField = '') => `<div class="paylinks-int"><b>${esc(label)}</b>${connected[kind] ? `<span class="pill ok">connected</span><span class="sub">${esc(hint.connected || '')}${b.webhooks?.[kind] ? `<br>Webhook: <span class="paylinks-code">${esc(b.webhooks[kind])}</span>` : ''}</span><button type="button" class="danger" data-act="disconnect" data-kind="${kind}" ${st.busy || ctx.demo ? 'disabled' : ''}>Disconnect</button>` : `<span class="sub">${esc(hint.help)}</span><form data-form="connect" data-kind="${kind}" class="paylinks-inline"><input type="password" name="apiKey" placeholder="${esc(label)} API key" autocomplete="off" ${ro} style="min-width:220px">${extraField}<button type="submit" class="primary" ${st.busy || ctx.demo ? 'disabled' : ''}>Connect</button></form>`}</div>`;
  return `<div class="note"><b>Setup.</b> Connect the processor, paste your HYROS universal script, design the thank-you page.${ctx.demo ? ' <span class="pill warn">demo — read-only</span>' : ''}</div>
  <div class="fpanel"><h3>Integrations</h3><div class="fhint">keys are verified, encrypted and never shown again</div>
    ${intRow('stripe', 'Stripe', { help: 'Stripe → Developers → API keys. A restricted key needs write on Products, Prices, Payment Links, Webhook Endpoints and read on Checkout Sessions. The webhook is registered for you.', connected: 'payment links can be created and imported; webhook registered' })}
    ${intRow('whop', 'Whop', { help: 'Whop → Developer → API key (payment:basic:read + member:email:read). Paste the webhook secret from the webhook you create in Whop pointing at the URL shown after connecting.', connected: 'payments recorded from the webhook' }, '<input type="password" name="webhookSecret" placeholder="Whop webhook secret (optional)" autocomplete="off">')}
  </div>
  <form class="paylinks-form" data-form="settings">
  <div class="fpanel"><h3>HYROS tracking script</h3><div class="fhint">injected into the &lt;head&gt; of every thank-you page — HYROS → Tracking → Universal Script${s.trackingSource ? ` · <span class="pill ok">${esc(s.trackingSource === 'hyros' ? 'fetched from HYROS' : 'pasted')}</span>` : ' · <span class="pill bad">not set — pages will not link emails</span>'}</div>
    <div class="paylinks-form"><label>Universal tracking script<textarea data-path="trackingScript" placeholder="<script>…hyros.com…</script>" ${ro}>${esc(s.trackingScript || '')}</textarea></label>
    <div class="paylinks-inline">${!ctx.demo ? `<button type="button" data-act="fetch-script" ${st.busy ? 'disabled' : ''}>Fetch from HYROS</button>` : ''}<span class="sub">Paste the whole &lt;script&gt; block. Only a script that loads from hyros.com is accepted.</span></div></div></div>
  <div class="fcols">
    <div class="fpanel"><h3>Thank-you page</h3><div class="fhint">what the buyer sees after paying</div>
      <div class="paylinks-form">
        <div class="paylinks-templates">${TEMPLATES.map(([id, name, bg]) => `<button type="button" class="paylinks-template${s.template === id ? ' active' : ''}" data-template="${id}" ${ro}><div class="swatch" style="background:${bg}"></div>${esc(name)}</button>`).join('')}</div>
        <label>Headline${inp('headline', s.headline)}</label><label>Message${inp('message', s.message)}</label>
        <div class="paylinks-row2"><label>Brand name${inp('brand', s.brand)}</label><label>Logo URL${inp('logoUrl', s.logoUrl, { type: 'url', placeholder: 'https://…/logo.png' })}</label></div>
        <div class="paylinks-row2"><label>Accent color (hex, optional)${inp('accent', s.accent, { placeholder: '#5150F6' })}</label><label>Auto-redirect after (seconds, 0 = show a button)${inp('countdownS', s.countdownS, { type: 'number', extra: 'min="0" max="120"' })}</label></div>
        <label>Redirect URL (optional)${inp('redirectUrl', s.redirectUrl, { type: 'url', placeholder: 'https://yoursite.com/welcome' })}</label>
        <label class="paylinks-check"><input type="checkbox" data-path="showOrder" ${s.showOrder ? 'checked' : ''} ${ro}> Show order details (number, amount, status)</label>
        <label class="paylinks-check"><input type="checkbox" data-path="showEmail" ${s.showEmail ? 'checked' : ''} ${ro}> Show the buyer's email on the page</label>
        ${!ctx.demo ? `<div class="paylinks-inline"><button type="button" data-act="preview" ${st.busy ? 'disabled' : ''}>Preview</button></div>` : ''}
      </div></div>
    <div>
      <div class="fpanel"><h3>Domain</h3><div class="fhint">thank-you links use this deployment's domain unless you set a custom one</div>
        <div class="paylinks-form"><label>Custom domain (optional)${inp('domain', s.domain, { placeholder: 'confirm.yourbrand.com' })}</label>
        <div class="sub">Links currently print as <span class="paylinks-code">${esc(base || 'this deployment')}/ty?l=…</span>. To use your own domain: Vercel → this project → Settings → Domains → add it, point its CNAME at Vercel as instructed, then enter it here. Existing links keep working on both.</div></div></div>
      <div class="fpanel"><h3>Notifications</h3><div class="fhint">one line per payment to Slack or Discord (incoming-webhook URL)</div>
        <div class="paylinks-form"><label>Webhook URL${inp('notifyUrl', s.notifyUrl, { type: 'url', placeholder: 'https://hooks.slack.com/services/…' })}</label></div></div>
      ${st.preview ? `<div class="fpanel"><h3>Preview</h3><div class="fhint">sample data, no script</div><iframe class="paylinks-preview" sandbox="" srcdoc="${esc(st.preview)}"></iframe></div>` : ''}
    </div>
  </div>
  ${!ctx.demo ? `<div class="paylinks-inline"><button type="submit" class="primary" ${st.busy ? 'disabled' : ''}>Save settings</button><span class="sub">${s.updatedAt ? `saved ${esc(ctx.fmt.datetime(s.updatedAt))}` : 'not saved yet'}</span></div>` : ''}
  </form>`;
}

/* ---------- wiring ---------- */

function setPath(obj, path, value) { obj[path] = value; }

function wire(ctx, st, b) {
  const root = ctx.root;
  if (typeof root.querySelectorAll !== 'function') return;
  const on = (sel, evt, fn) => root.querySelectorAll(sel).forEach((el) => el.addEventListener(evt, fn));
  const reload = async () => { st.fetchedAt = 0; await loadLive(ctx, st, { force: true }); };
  on('[data-nav]', 'click', (e) => { st.view = e.currentTarget.dataset.nav; st.err = null; render(ctx); loadLive(ctx, st); });
  on('[data-act="reload"]', 'click', reload);
  on('[data-act="toggle-create"]', 'click', () => { st.showCreate = !st.showCreate; render(ctx); });
  on('[data-act="toggle-whop"]', 'click', () => { st.showWhop = !st.showWhop; render(ctx); });
  on('[data-act="toggle-import"]', 'click', async () => { st.showImport = !st.showImport; render(ctx); if (st.showImport && st.candidates === null) { const r = await post(ctx, st, { action: 'list-stripe-links' }); st.candidates = r?.ok ? r.candidates : []; render(ctx); } });
  on('[data-copy]', 'click', (e) => { const v = e.currentTarget.dataset.copy; if (navigator.clipboard) navigator.clipboard.writeText(v).then(() => { st.msg = 'Copied.'; render(ctx); }); });
  on('[data-filter]', 'input', (e) => { st.filters[e.currentTarget.dataset.filter] = e.currentTarget.value; render(ctx); const q = root.querySelector('[data-filter="q"]'); if (q && e.currentTarget.dataset.filter === 'q') { q.focus(); q.setSelectionRange(q.value.length, q.value.length); } });
  on('[data-filter]', 'change', (e) => { st.filters[e.currentTarget.dataset.filter] = e.currentTarget.value; render(ctx); });
  on('[data-journey]', 'click', (e) => ctx.openJourney(e.currentTarget.dataset.journey));
  on('[data-form="create"]', 'submit', async (e) => {
    e.preventDefault(); const f = e.currentTarget; const v = (n) => (f.querySelector(`[name="${n}"]`)?.value || '').trim();
    const r = await post(ctx, st, { action: 'create-link', name: v('name'), description: v('description'), amountCents: Math.round(Number(v('amount')) * 100), currency: v('currency'), interval: v('interval') || null });
    if (r?.ok) { st.showCreate = false; st.msg = `Created: ${r.link.url}`; }
    await reload();
  });
  on('[data-form="import"]', 'submit', async (e) => {
    e.preventDefault(); const ids = [...e.currentTarget.querySelectorAll('input[name="ids"]:checked')].map((i) => i.value);
    if (!ids.length) return;
    const r = await post(ctx, st, { action: 'import-links', ids });
    if (r?.ok) { st.showImport = false; st.candidates = null; st.msg = `${r.imported.length} imported${r.errors.length ? ` · ${r.errors.join(' · ')}` : ''}`; }
    await reload();
  });
  on('[data-form="whop"]', 'submit', async (e) => {
    e.preventDefault(); const f = e.currentTarget; const v = (n) => (f.querySelector(`[name="${n}"]`)?.value || '').trim();
    const r = await post(ctx, st, { action: 'add-whop-link', name: v('name'), url: v('url'), amountCents: Math.round(Number(v('amount') || 0) * 100), currency: v('currency'), interval: v('interval') || null });
    if (r?.ok) { st.showWhop = false; st.msg = r.note; }
    await reload();
  });
  on('[data-act="rename"]', 'click', async (e) => { const id = e.currentTarget.dataset.id; const cur = (b.links || []).find((l) => l.id === id); const name = typeof prompt === 'function' ? prompt('Link name', cur?.name || '') : null; if (!name) return; await post(ctx, st, { action: 'update-link', id, name }); await reload(); });
  on('[data-act="toggle-active"]', 'click', async (e) => { await post(ctx, st, { action: 'update-link', id: e.currentTarget.dataset.id, active: e.currentTarget.dataset.active !== '1' }); await reload(); });
  on('[data-act="delete-link"]', 'click', async (e) => { if (typeof confirm === 'function' && !confirm('Delete this link here and deactivate it on Stripe?')) return; await post(ctx, st, { action: 'delete-link', id: e.currentTarget.dataset.id }); await reload(); });
  on('[data-act="delete-tx"]', 'click', async (e) => { st.busy = true; render(ctx); try { await ctx.api(`/api/paylinks?tx=${encodeURIComponent(e.currentTarget.dataset.id)}`, { method: 'DELETE' }); } catch (err) { st.err = err.message; } st.busy = false; await reload(); });
  on('[data-act="verify"]', 'click', async () => { const r = await post(ctx, st, { action: 'verify' }); if (r?.ok) st.msg = `${r.checked} checked · ${r.linked} linked · ${r.found - r.linked} found without a source${r.error ? ` · ${r.error}` : ''}`; await reload(); });
  on('[data-act="verify-all"]', 'click', async () => { const r = await post(ctx, st, { action: 'verify', recheck: true }); if (r?.ok) st.msg = `${r.checked} re-checked · ${r.linked} linked${r.error ? ` · ${r.error}` : ''}`; await reload(); });
  // setup
  on('[data-path]', 'input', (e) => { const el = e.currentTarget; if (!st.settings) return; setPath(st.settings, el.dataset.path, el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value); });
  on('[data-template]', 'click', (e) => { if (!st.settings) return; st.settings.template = e.currentTarget.dataset.template; render(ctx); });
  on('[data-form="settings"]', 'submit', async (e) => { e.preventDefault(); const r = await post(ctx, st, { action: 'settings', settings: st.settings }); if (r?.ok) { st.settings = r.settings; st.msg = 'Settings saved.'; } await reload(); });
  on('[data-act="preview"]', 'click', async () => { const r = await post(ctx, st, { action: 'preview', settings: st.settings }); if (r?.ok) st.preview = r.html; render(ctx); });
  on('[data-act="fetch-script"]', 'click', async () => { const r = await post(ctx, st, { action: 'fetch-script' }); if (r?.ok) { st.settings = r.settings; st.msg = 'Script fetched from HYROS and saved.'; } render(ctx); });
  on('[data-form="connect"]', 'submit', async (e) => {
    e.preventDefault(); const f = e.currentTarget; const apiKey = f.querySelector('[name="apiKey"]')?.value || ''; const webhookSecret = f.querySelector('[name="webhookSecret"]')?.value || '';
    st.busy = true; st.msg = 'Connecting…'; render(ctx);
    try { const { body } = await ctx.api('/api/integrations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: f.dataset.kind, apiKey, webhookSecret: webhookSecret || undefined }) }); if (body?.ok) { st.msg = `${f.dataset.kind} connected.${body.item?.lastError ? ` ${body.item.lastError}` : ''}`; st.err = null; } else st.err = body?.message || 'Could not connect.'; }
    catch (err) { st.err = err.message; }
    st.busy = false; await reload();
  });
  on('[data-act="disconnect"]', 'click', async (e) => {
    st.busy = true; render(ctx);
    try { const { body } = await ctx.api('/api/integrations'); const it = (body?.items || []).find((i) => i.kind === e.currentTarget.dataset.kind); if (it) await ctx.api(`/api/integrations?id=${encodeURIComponent(it.id)}`, { method: 'DELETE' }); } catch (err) { st.err = err.message; }
    st.busy = false; await reload();
  });
}

/* ---------- render ---------- */

export function render(ctx) {
  const st = state(ctx.root);
  const raw = ctx.block;
  const has = raw && typeof raw === 'object';
  const b = blockOf(ctx, st);
  const intro = `<div class="note"><b>Payment Links.</b> Stripe and Whop links whose thank-you page carries the buyer's email into your HYROS script — a purchase made with a different email than the opt-in still gets attributed.${statusLine(has ? raw : null, ctx)}${ctx.demo ? ' <span class="pill warn">demo</span>' : ''}</div>`;
  if (!has && ctx.demo) { ctx.root.innerHTML = `${intro}<div class="fpanel"><div class="empty">No payment links in this snapshot.</div></div>`; return; }
  let body = '';
  try {
    if (st.view === 'links') body = linksView(ctx, st, b);
    else if (st.view === 'transactions') body = transactionsView(ctx, st, b);
    else if (st.view === 'setup') body = setupView(ctx, st, b);
    else body = overviewView(ctx, st, b);
  } catch (err) { body = `<div class="note err"><b>Could not render this view.</b> ${ctx.esc(err.message)}</div>`; }
  ctx.root.innerHTML = `${intro}${nav(ctx, st, b)}${body}`;
  wire(ctx, st, b);
  if (!ctx.demo) loadLive(ctx, st);
}
