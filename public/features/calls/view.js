/**
 * Call Intelligence — the tab. One render(ctx) with an in-section router:
 *   Calls (index + paste) · a call's detail (Overview · Lead Quality · Buying
 *   Language · Objections · Rep Scorecard · Transcript) · Avatars · By source
 *   · Setup (knowledge base + integrations).
 *
 * Reads ctx.block (the index copied into the snapshot at refresh) and, on
 * live accounts, re-pulls the index through ctx.api('/api/calls') so calls
 * that arrived since the last refresh show up. Details come from
 * /api/calls?id= (live) or block.calls (demo). Every data string is escaped
 * with ctx.esc; the view never throws on a missing or marker block.
 */
import { kpis as rollupKpis, outcomeCounts, bySource, byCategory, byRep, byAvatar, topItems, newestFirst, OUTCOMES, OUTCOME_LABEL, STATUS_LABEL, scoreLabel, isDone } from './rollup.js';
import { DEMO_KB } from './demo.js';

const MARKERS = ['skipped', 'error', 'stale'];
const REFRESH_MS = 30000;
const states = new WeakMap();
const state = (root) => {
  if (!states.has(root)) states.set(root, { view: 'list', tab: 'overview', callId: null, filters: { outcome: '', rep: '', avatar: '', source: '', q: '' }, cache: new Map(), live: null, fetchedAt: 0, loading: false, msg: null, err: null, busy: false, kb: null, kbMeta: null, integrations: null, paste: false });
  return states.get(root);
};
const dataOf = (b) => (b && typeof b === 'object' ? Object.fromEntries(Object.entries(b).filter(([k]) => !MARKERS.includes(k))) : {});
const mmss = (sec) => {
  if (!Number.isFinite(sec)) return '--:--';
  const m = Math.floor(sec / 60); const s = Math.floor(sec % 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}:${String(s).padStart(2, '0')}`;
};
const pctText = (v) => (v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`);
const tempPill = (t, esc) => (t ? `<span class="pill calls-${esc(t)}">${esc(t)}</span>` : '');
const statusPill = (s, esc) => (s && s !== 'done' ? `<span class="pill calls-${esc(s)}${s === 'error' ? ' bad' : ''}">${esc(STATUS_LABEL[s] || s)}</span>` : '');
const outcomePill = (o, esc) => (o ? `<span class="pill ${o === 'closed' ? 'ok' : o === 'lost' ? 'bad' : ''}">${esc(OUTCOME_LABEL[o] || o)}</span>` : '');
const bar = (points, max, rep = false) => `<div class="calls-bar${rep ? ' rep' : ''}"><i style="width:${max ? Math.round(Math.min(100, (points / max) * 100)) : 0}%"></i></div>`;
const chip = (id, label, active, extra = '') => `<button type="button" class="chip${active ? ' active' : ''}" data-nav="${id}"${extra}>${label}</button>`;

/* ---------- data access (live overlay) ---------- */

function blockOf(ctx, st) {
  const base = dataOf(ctx.block);
  if (ctx.demo || !st.live) return base;
  return { ...base, rows: st.live.rows || base.rows || [], avatars: st.live.avatars || base.avatars || [], updatedAt: st.live.updatedAt || base.updatedAt, truncated: Boolean(st.live.truncated), dropped: st.live.dropped || 0, connected: st.live.connected || null, writeBack: st.live.writeBack || null, readOnly: st.live.readOnly || null };
}

async function loadIndex(ctx, st, { force = false } = {}) {
  if (ctx.demo || typeof ctx.api !== 'function') return;
  if (!force && (st.loading || Date.now() - st.fetchedAt < REFRESH_MS)) return;
  st.loading = true;
  try {
    const { body } = await ctx.api('/api/calls');
    if (body?.ok && Array.isArray(body.rows)) { st.live = body; st.err = null; }
    else if (body?.error && body.error !== 'not_configured') st.err = body.message || body.error;
  } catch (err) { st.err = err.message; }
  finally { st.loading = false; st.fetchedAt = Date.now(); }
  render(ctx);
}

async function loadCall(ctx, st, id) {
  if (st.cache.has(id) || st.loading) return;
  st.loading = true;
  try {
    const { body } = await ctx.api(`/api/calls?id=${encodeURIComponent(id)}`);
    if (body?.ok && body.call) st.cache.set(id, body.call); else st.err = body?.message || 'Could not load this call.';
  } catch (err) { st.err = err.message; }
  finally { st.loading = false; }
  render(ctx);
}

async function post(ctx, st, path, payload, { then = null } = {}) {
  if (typeof ctx.api !== 'function') return null;
  st.busy = true; st.msg = 'Working…'; st.err = null; render(ctx);
  let body = null;
  try {
    ({ body } = await ctx.api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }));
    if (!body?.ok) st.err = body?.message || body?.error || 'Request failed.'; else st.msg = null;
  } catch (err) { st.err = err.message; }
  st.busy = false;
  if (then) await then(body);
  render(ctx);
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
  const queued = rows.filter((r) => r.status === 'queued').length;
  const views = [['list', 'Calls'], ['avatars', 'Avatars'], ['sources', 'By source'], ['setup', 'Setup']];
  const cur = st.view === 'detail' ? 'list' : st.view;
  return `<div class="calls-nav"><div class="chipset">${views.map(([id, label]) => chip(id, label, cur === id)).join('')}</div>
    <span class="sub">${ctx.esc(rows.length)} call${rows.length === 1 ? '' : 's'}${b.updatedAt ? ` · index ${ctx.esc(ctx.fmt.datetime(b.updatedAt))}` : ''}${b.truncated ? ` · oldest ${ctx.esc(b.dropped)} dropped` : ''}${st.loading ? ' · loading…' : ''}</span>
    <div class="spacer"></div>
    <div class="calls-actions">
      ${!ctx.demo ? `<button type="button" data-act="reload" ${st.busy ? 'disabled' : ''}>↻ Reload</button>` : ''}
      ${!ctx.demo && queued ? `<button type="button" data-act="analyze-queued" ${st.busy ? 'disabled' : ''}>Analyze ${queued} queued</button>` : ''}
      ${st.view !== 'detail' ? `<button type="button" class="primary" data-act="paste-toggle">${st.paste ? 'Close' : '+ Paste a transcript'}</button>` : ''}
    </div></div>
    ${st.err ? `<div class="note err"><b>Problem.</b> ${ctx.esc(st.err)}</div>` : ''}${st.msg ? `<div class="note">${ctx.esc(st.msg)}</div>` : ''}`;
}

function pastePanel(ctx, st) {
  if (!st.paste) return '';
  const esc = ctx.esc;
  return `<div class="fpanel"><h3>Paste a transcript</h3>
    <div class="fhint">one utterance per line — "Speaker: text", optionally with [mm:ss] timestamps; Fathom and Fireflies exports paste as-is${ctx.demo ? ' · <span class="pill warn">demo — not stored</span>' : ''}</div>
    <form class="calls-form" data-form="paste">
      <div class="calls-row2"><label>Title<input type="text" name="title" placeholder="e.g. Strategy Call — Bram" required></label><label>Date<input type="text" name="date" placeholder="${esc(new Date().toISOString().slice(0, 10))}"></label></div>
      <div class="calls-row2"><label>Rep (who ran the call)<input type="text" name="rep" placeholder="Jay Moreno"></label><label>Prospect email (for the HYROS join)<input type="email" name="email" placeholder="prospect@example.com"></label></div>
      <label>Transcript<textarea name="transcript" style="min-height:180px" placeholder="[00:00] Jay: Thanks for jumping on…&#10;[00:14] Bram: Happy to be here…" required></textarea></label>
      <div class="calls-inline"><button type="submit" class="primary" ${st.busy || ctx.demo ? 'disabled' : ''}>Store &amp; analyze</button><span class="sub">Analysis takes 1–3 minutes; the row shows "Analyzing" meanwhile.</span></div>
    </form></div>`;
}

function listView(ctx, st, b) {
  const { esc, fmt, kpis } = ctx;
  const all = newestFirst(b.rows || []);
  const f = st.filters;
  const q = f.q.trim().toLowerCase();
  const rows = all.filter((r) => (!f.outcome || r.outcome === f.outcome) && (!f.rep || r.rep === f.rep) && (!f.avatar || r.avatarId === f.avatar) && (!f.source || r.source === f.source)
    && (!q || [r.title, r.prospect, r.rep, r.leadEmail, r.attribution?.firstSource].some((v) => String(v || '').toLowerCase().includes(q))));
  const k = rollupKpis(rows);
  const oc = outcomeCounts(rows);
  const opts = (list, cur, all = 'All') => `<option value="">${all}</option>${list.map(([v, l]) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(l)}</option>`).join('')}`;
  const reps = [...new Set(all.map((r) => r.rep).filter(Boolean))].sort();
  const avatars = (b.avatars || []).map((a) => [a.id, a.name]);
  const sources = [...new Set(all.map((r) => r.source).filter(Boolean))].map((s) => [s, s]);
  const empty = !all.length
    ? (ctx.demo ? 'No demo calls.' : 'No calls yet. Connect Fathom or Fireflies under Setup, run a backfill, or paste a transcript.')
    : 'No calls match these filters.';
  return `${pastePanel(ctx, st)}
    <div class="kpis">${kpis([
      { label: 'Calls analyzed', value: fmt.int(k.analyzed), sub: k.queued ? `${fmt.int(k.queued)} queued${k.failed ? ` · ${fmt.int(k.failed)} failed` : ''}` : (k.failed ? `${fmt.int(k.failed)} failed` : `of ${fmt.int(k.total)}`) },
      { label: 'Avg lead score', value: k.avgLead === null ? '—' : `${Math.round(k.avgLead)}`, sub: k.avgLead === null ? '' : scoreLabel(k.avgLead), cls: k.avgLead === null ? '' : k.avgLead >= 70 ? 'good' : k.avgLead < 50 ? 'bad' : '' },
      { label: 'Hot leads', value: pctText(k.hotShare), sub: 'buying language: hot' },
      { label: 'Close rate', value: pctText(k.closeRate), sub: `${fmt.int(oc.closed)} closed · ${fmt.int(oc.follow_up)} follow-up · ${fmt.int(oc.lost)} lost`, cls: k.closeRate === null ? '' : k.closeRate >= 0.3 ? 'good' : '' },
      { label: 'Rep score', value: pctText(k.avgRepPct), sub: 'avg of scorecard %' },
      { label: 'Attributed', value: k.analyzed ? `${fmt.int(k.attributed)} / ${fmt.int(k.analyzed)}` : '—', sub: 'matched to a HYROS lead', cls: k.analyzed && k.attributed < k.analyzed ? '' : 'good' },
    ])}</div>
    <div class="calls-filters">
      <input type="search" data-filter="q" value="${esc(f.q)}" placeholder="Search title, prospect, rep, source…">
      <select data-filter="outcome">${opts(OUTCOMES.map((o) => [o, OUTCOME_LABEL[o]]), f.outcome, 'All outcomes')}</select>
      <select data-filter="rep">${opts(reps.map((r) => [r, r]), f.rep, 'All reps')}</select>
      <select data-filter="avatar">${opts(avatars, f.avatar, 'All avatars')}</select>
      <select data-filter="source">${opts(sources, f.source, 'All sources')}</select>
      <span class="rowcount">${esc(rows.length)} shown</span>
    </div>
    <div class="win"><div class="winbar"><i></i><i></i><i></i><span>app.hyros.com &middot; call intelligence</span></div><div class="table-wrap">
    <table class="calls-table"><thead><tr><th>Call</th><th>Prospect</th><th>Outcome</th><th class="num">Lead score</th><th class="num">Rep</th><th>Temp</th><th>Avatar</th><th>First source</th></tr></thead>
    <tbody>${rows.length ? rows.map((r) => `<tr class="calls-row" data-open="${esc(r.id)}">
      <td><span class="calls-title">${esc(r.title)}</span><span class="calls-meta">${esc(fmt.datetime(r.date))} · ${esc(mmss(r.durationS))} · ${esc(r.source)}${r.rep ? ` · ${esc(r.rep)}` : ''}</span></td>
      <td>${esc(r.prospect || '—')}${r.leadEmail ? `<span class="calls-meta">${esc(r.leadEmail)}</span>` : ''}</td>
      <td>${statusPill(r.status, esc)}${outcomePill(r.outcome, esc)}${r.error ? `<span class="calls-meta bad">${esc(r.error)}</span>` : ''}</td>
      <td class="num">${isDone(r) ? `<span class="calls-score ${r.leadScore >= 70 ? 'good' : r.leadScore < 50 ? 'bad' : ''}">${esc(r.leadScore)}<small>/${esc(r.leadMax || 100)}</small></span>` : '—'}</td>
      <td class="num">${isDone(r) && r.repMax ? `${esc(r.repScore)}<small class="sub">/${esc(r.repMax)}</small>` : '—'}</td>
      <td>${tempPill(r.temperature, esc)}</td>
      <td>${esc(r.avatarName || '—')}</td>
      <td>${r.attribution?.firstSource ? `<span class="pill fb" title="${esc(r.attribution.category || '')}">${esc(r.attribution.firstSource)}</span>` : '<span class="sub">no HYROS match</span>'}</td>
    </tr>`).join('') : `<tr><td colspan="8"><div class="empty">${esc(empty)}</div></td></tr>`}</tbody></table></div></div>`;
}

function detailView(ctx, st, b) {
  const { esc, fmt } = ctx;
  const id = st.callId;
  const call = ctx.demo ? (b.calls || {})[id] : st.cache.get(id);
  const row = (b.rows || []).find((r) => r.id === id) || null;
  if (!call) {
    if (!ctx.demo && id) loadCall(ctx, st, id);
    return `<div class="calls-head"><button type="button" data-nav="list">← Calls</button><div><h2>${esc(row?.title || 'Call')}</h2></div></div><div class="fpanel"><div class="empty">${st.loading ? 'Loading the call…' : (st.err ? esc(st.err) : 'This call is not available.')}</div></div>`;
  }
  const a = call.analysis;
  const tabs = [['overview', 'Overview'], ['lead', 'Lead Quality'], ['language', 'Buying Language'], ['objections', 'Objections'], ['rep', 'Rep Performance'], ['transcript', 'Transcript']];
  const attr = call.attribution;
  const head = `<div class="calls-head"><button type="button" data-nav="list">← Calls</button>
    <div><h2>${esc(call.title)}</h2><div class="calls-sub">${esc(fmt.datetime(call.date))} · ${esc(mmss(call.durationS))} · ${esc(call.source)}${call.rep || a?.participants?.rep ? ` · rep ${esc(a?.participants?.rep || call.rep)}` : ''}${call.url ? ` · <a href="${esc(call.url)}" target="_blank" rel="noopener">recording</a>` : ''}</div></div>
    <div class="spacer"></div>
    <div class="calls-actions">${statusPill(call.status, esc)}${a ? outcomePill(a.outcome, esc) : ''}${a ? tempPill(a.buyingLanguage.temperature, esc) : ''}
      ${!ctx.demo ? `<select data-act="outcome" ${st.busy ? 'disabled' : ''}><option value="">Set outcome…</option>${OUTCOMES.map((o) => `<option value="${o}">${esc(OUTCOME_LABEL[o])}</option>`).join('')}</select><button type="button" data-act="reanalyze" ${st.busy ? 'disabled' : ''}>Re-analyze</button><button type="button" class="danger" data-act="delete" ${st.busy ? 'disabled' : ''}>Delete</button>` : ''}
    </div></div>`;
  if (!a) {
    return `${head}<div class="fpanel"><div class="empty">${call.status === 'error' ? `Analysis failed: ${esc(call.error || 'unknown error')}` : call.status === 'analyzing' ? 'Analyzing… reload in a minute.' : 'Queued — not analyzed yet.'}</div></div>${transcriptPanel(call, esc)}`;
  }
  const attrPanel = `<div class="fpanel"><h3>HYROS attribution</h3><div class="fhint">the lead behind this call, joined by email (hyros_get_leads)</div>
    ${attr?.matched ? `<div class="calls-item"><b>${esc(attr.name || attr.email)}</b> <span class="sub">${esc(attr.email)}${attr.stage ? ` · stage ${esc(attr.stage)}` : ''}${attr.joined ? ` · joined ${esc(fmt.date(attr.joined))}` : ''}</span></div>
      <div class="calls-item"><b>First source</b> <span class="pill fb">${esc(attr.firstSource?.name || '—')}</span> ${attr.firstSource?.category ? `<span class="sub">${esc(attr.firstSource.category)}</span>` : ''}${attr.firstSource?.ad ? `<span class="sub"> · ad ${esc(attr.firstSource.ad)}</span>` : ''}</div>
      <div class="calls-item"><b>Last source</b> <span class="pill fb">${esc(attr.lastSource?.name || '—')}</span></div>
      ${attr.tags?.length ? `<div class="calls-item calls-tags">${attr.tags.map((t) => `<span class="pill">${esc(t)}</span>`).join('')}</div>` : ''}
      <div class="calls-item"><button type="button" class="drill" data-journey="${esc(attr.email)}">Open lead journey →</button></div>`
      : `<div class="empty">${esc(attr?.error ? `Lookup failed: ${attr.error}` : attr?.reason || 'No HYROS lead matched this call.')}</div>`}
    ${call.writeBack ? `<div class="sub" style="margin-top:8px">Write-back: ${call.writeBack.ok ? `tags ${esc((call.writeBack.tags || []).join(', '))}` : esc(call.writeBack.error || call.writeBack.skipped || 'not run')}</div>` : ''}
  </div>`;
  let body = '';
  if (st.tab === 'overview') {
    body = `<div class="fcols"><div>
      <div class="fpanel"><h3>Call summary</h3><div class="calls-prose">${esc(a.summary.overview)}</div>
        <div class="calls-item" style="margin-top:10px"><b>Verdict</b><span class="sub">${esc(a.summary.verdict)}</span></div>
        ${a.outcomeEvidence ? `<div class="sub">Outcome: ${esc(OUTCOME_LABEL[a.outcome] || a.outcome)}${a.outcomeOverride ? ' (set by hand)' : ''} — ${esc(a.outcomeEvidence)}</div>` : ''}</div>
      <div class="fpanel"><h3>What the rep did well</h3>${a.summary.didWell.length ? a.summary.didWell.map((x) => `<div class="calls-item"><b>${esc(x.title)}</b><span class="sub">${esc(x.detail)}</span></div>`).join('') : '<div class="empty">Nothing singled out.</div>'}</div>
      <div class="fpanel"><h3>Moments that cost the close</h3>${a.summary.costTheClose.length ? a.summary.costTheClose.map((x) => `<div class="calls-item"><b>${esc(x.title)}</b><span class="sub">${esc(x.detail)}</span></div>`).join('') : '<div class="empty">None — clean call.</div>'}</div>
      ${a.summary.nextSteps.length ? `<div class="fpanel"><h3>Next steps</h3>${a.summary.nextSteps.map((x) => `<div class="calls-item">${esc(x)}</div>`).join('')}</div>` : ''}
    </div><div>
      <div class="fpanel"><h3>Avatar</h3><div class="fhint">this call fell into</div>${a.avatar?.name ? `<div class="calls-item"><b>${esc(a.avatar.name)}</b><span class="sub">confidence ${esc(a.avatar.confidence)}%${a.avatar.manual ? ' · set by hand' : ''}</span></div>` : '<div class="empty">No avatar assigned.</div>'}
        ${!ctx.demo && (b.avatars || []).length ? `<select data-act="avatar" ${st.busy ? 'disabled' : ''}><option value="">Change avatar…</option>${(b.avatars || []).map((av) => `<option value="${esc(av.id)}">${esc(av.name)}</option>`).join('')}</select>` : ''}</div>
      ${attrPanel}
      <div class="fpanel"><h3>Prospect intelligence</h3>
        <div class="calls-item"><b>Demographics</b><span class="sub">${esc([...new Set([a.prospect.demographics.role, a.prospect.demographics.businessType, a.prospect.demographics.ageRange, a.prospect.demographics.location, a.prospect.demographics.revenueRange].filter((v) => v && !/^unknown$/i.test(v)))].join(' · ') || 'not stated')}</span></div>
        ${a.prospect.psychographics.length ? `<div class="calls-item"><b>Psychographics</b><span class="sub">${esc(a.prospect.psychographics.join(' · '))}</span></div>` : ''}
        ${a.prospect.painPoints.length ? `<div class="calls-item"><b>Pain points</b><span class="sub">${esc(a.prospect.painPoints.join(' · '))}</span></div>` : ''}
        ${a.prospect.desires.length ? `<div class="calls-item"><b>Desires</b><span class="sub">${esc(a.prospect.desires.join(' · '))}</span></div>` : ''}
        ${a.prospect.language.length ? `<div class="calls-item"><b>In their words</b>${a.prospect.language.map((q) => `<span class="sub">“${esc(q)}”</span>`).join('')}</div>` : ''}
      </div>
    </div></div>`;
  } else if (st.tab === 'lead') {
    const lq = a.leadQuality;
    body = `<div class="fcols"><div class="fpanel"><h3>Lead Quality Score</h3>
      <div class="calls-big"><b class="${lq.score >= 70 ? 'good' : lq.score < 50 ? 'bad' : ''}">${esc(lq.score)}<span class="sub">/${esc(lq.max)}</span></b><span class="sub">${esc(lq.label)} · close probability ${esc(lq.closeProbability)}%</span></div>
      <div class="calls-prose" style="margin:10px 0">${esc(lq.rationale)}</div>
      ${lq.pattern ? `<div class="calls-pattern"><div class="kpi-label">${esc(lq.pattern.name)}</div>${esc(lq.pattern.implication)}</div>` : ''}
      <h3 style="margin-top:14px">Factor breakdown</h3>
      ${lq.factors.map((f) => `<div class="calls-factor"><div class="calls-factor-head"><b>${esc(f.name)}</b><span>${esc(f.points)}/${esc(f.max)}</span></div>${bar(f.points, f.max)}<p>${esc(f.evidence)}</p></div>`).join('')}
    </div>${attrPanel}</div>`;
  } else if (st.tab === 'language') {
    const bl = a.buyingLanguage;
    const good = new Set(['commitment', 'ownership', 'internal_locus', 'urgency']);
    const warn = new Set(['hesitation', 'price', 'authority', 'skepticism']);
    body = `<div class="fpanel"><div class="calls-head"><h3 style="margin:0">Buying Language</h3><div class="spacer"></div>${tempPill(bl.temperature, esc)}</div>
      <div class="calls-item"><span class="kpi-label">Overall assessment</span><b>${esc(bl.mindset || '—')}</b></div>
      <h3 style="margin-top:14px">Mindset signals</h3>
      ${bl.signals.length ? bl.signals.map((s) => `<div class="calls-signal${good.has(s.kind) ? ' calls-good' : warn.has(s.kind) ? ' calls-warnish' : ''}"><q>${esc(s.quote)}</q><div class="calls-signal-foot"><span class="sub">${esc(s.note)}</span><span class="pill">${esc(String(s.kind).replace('_', ' '))}</span></div></div>`).join('') : '<div class="empty">No signals extracted.</div>'}</div>`;
  } else if (st.tab === 'objections') {
    body = `<div class="fpanel"><h3>Objection analysis</h3><div class="fhint">each objection, whether it was handled, and what would have been better</div>
      ${a.objections.length ? a.objections.map((o) => `<div class="calls-factor"><div class="calls-factor-head"><b>${esc(o.objection)}</b><span class="pill ${o.handled ? 'ok' : 'bad'}">${o.handled ? 'handled' : 'not handled'}</span></div><p><b>What happened:</b> ${esc(o.howHandled || '—')}</p><p class="calls-coach"><b>Better:</b> ${esc(o.better || '—')}</p></div>`).join('') : '<div class="empty">No objections surfaced on this call.</div>'}</div>`;
  } else if (st.tab === 'rep') {
    const rs = a.repScorecard;
    body = `<div class="fpanel"><h3>Rep scorecard — ${esc(rs.scorecardName)}</h3>
      <div class="calls-big"><b>${esc(rs.total)}<span class="sub">/${esc(rs.max)}</span></b><span class="sub">${esc(pctText(rs.max ? rs.total / rs.max : null))}</span></div>
      <div class="calls-prose" style="margin:10px 0">${esc(rs.summary)}</div>
      ${rs.criteria.map((c) => `<div class="calls-factor"><div class="calls-factor-head"><b>${esc(c.title)}</b><span>${esc(c.points)}/${esc(c.max)}</span></div>${bar(c.points, c.max, true)}<p>${esc(c.evidence)}</p>${c.coaching ? `<p class="calls-coach"><b>Coaching:</b> ${esc(c.coaching)}</p>` : ''}</div>`).join('')}</div>`;
  } else {
    body = transcriptPanel(call, esc);
  }
  return `${head}<div class="chipset calls-tabs">${tabs.map(([id, label]) => chip(id, label, st.tab === id, ' data-tab="1"')).join('')}</div>${body}`;
}

function transcriptPanel(call, esc) {
  const lines = Array.isArray(call.transcript) ? call.transcript : [];
  return `<div class="fpanel"><h3>Transcript</h3><div class="fhint">${esc(lines.length)} utterances${call.vendorSummary ? ' · note-taker summary below' : ''}</div>
    <div class="calls-transcript">${lines.map((l) => `<div class="calls-line"><span class="calls-t">${esc(mmss(l.t))}</span><span class="calls-who">${esc(l.speaker)}</span><span class="calls-text">${esc(l.text)}</span></div>`).join('') || '<div class="empty">Empty transcript.</div>'}</div>
    ${call.vendorSummary ? `<h3 style="margin-top:14px">Note-taker summary</h3><div class="calls-prose">${esc(call.vendorSummary)}</div>` : ''}</div>`;
}

function avatarsView(ctx, st, b) {
  const { esc, fmt } = ctx;
  const rows = b.rows || [];
  const groups = byAvatar(rows, b.avatars || []);
  const list = (b.avatars || []).map((a) => ({ ...a, g: groups.find((g) => g.key === a.id) || null }));
  for (const g of groups) if (!list.some((a) => a.id === g.key)) list.push({ id: g.key, name: g.name, who: '', description: '', callCount: g.calls, g });
  if (!list.length) return `<div class="fpanel"><div class="empty">No avatars yet — they appear as calls are analyzed (the analysis proposes one when no existing avatar fits). Edit them under Setup.</div></div>`;
  return `<div class="note"><b>Avatars.</b> Who is actually on your calls: assigned by the analysis, editable under Setup. Pain points, desires and language are rolled up from every call in the avatar.</div>
    <div class="calls-avatars">${list.map((a) => {
      const g = a.g; const rs = g ? g.rows : [];
      return `<div class="fpanel calls-avatar"><h4>${esc(a.name)}</h4><div class="calls-who">${esc(a.who || '')}</div><p>${esc(a.description || '')}</p>
        ${rs.length ? `<div class="sub"><b>Top pains</b></div><ul>${topItems(rs.map((r) => r.painPoints), 3).map((x) => `<li>${esc(x.text)}${x.n > 1 ? ` <span class="sub">×${x.n}</span>` : ''}</li>`).join('')}</ul>
          <div class="sub"><b>Top desires</b></div><ul>${topItems(rs.map((r) => r.desires), 3).map((x) => `<li>${esc(x.text)}</li>`).join('')}</ul>
          <div class="sub"><b>In their words</b></div><ul>${topItems(rs.map((r) => r.language), 3).map((x) => `<li>“${esc(x.text)}”</li>`).join('')}</ul>` : ''}
        <div class="calls-avatar-foot"><span class="sub">☏ ${esc(fmt.int(g ? g.calls : a.callCount || 0))} call${(g ? g.calls : a.callCount) === 1 ? '' : 's'} analyzed${g && g.avgLead !== null ? ` · avg lead ${esc(Math.round(g.avgLead))}` : ''}</span><span class="pill ${g && g.closeRate >= 0.3 ? 'ok' : ''}">${esc(pctText(g ? g.closeRate : null))} conversion</span></div>
      </div>`;
    }).join('')}</div>`;
}

function sourcesView(ctx, st, b) {
  const { esc, fmt, snapshot } = ctx;
  const rows = b.rows || [];
  const range = snapshot?.ranges?.[ctx.range] && !snapshot.ranges[ctx.range].skipped ? snapshot.ranges[ctx.range] : snapshot?.ranges?.['30d'] || null;
  const adsets = range?.levels?.adset || [];
  const campaigns = range?.levels?.campaign || [];
  const table = (title, hint, groups, joinRows) => `<div class="fpanel"><h3>${esc(title)}</h3><div class="fhint">${esc(hint)}</div>
    ${groups.length ? `<div class="table-wrap"><table class="calls-table"><thead><tr><th>${esc(title.replace(/^By /, ''))}</th><th class="num">Calls</th><th class="num">Avg lead</th><th class="num">Hot</th><th class="num">Close rate</th><th class="num">Closed</th>${joinRows ? '<th class="num">Spend</th><th class="num">Leads</th><th class="num">Cost / call</th>' : ''}</tr></thead>
      <tbody>${groups.map((g) => {
        const j = joinRows ? joinRows.find((r) => r.name === g.key) : null;
        return `<tr><td>${esc(g.name)}</td><td class="num">${esc(g.calls)}</td><td class="num ${g.avgLead >= 70 ? 'good' : g.avgLead !== null && g.avgLead < 50 ? 'bad' : ''}">${g.avgLead === null ? '—' : esc(Math.round(g.avgLead))}</td><td class="num">${esc(pctText(g.hotShare))}</td><td class="num ${g.closeRate >= 0.3 ? 'good' : ''}">${esc(pctText(g.closeRate))}</td><td class="num">${esc(g.closed)}</td>
          ${joinRows ? `<td class="num">${j ? esc(fmt.money(j.cost || 0)) : '—'}</td><td class="num">${j ? esc(fmt.int(j.leads || 0)) : '—'}</td><td class="num">${j && g.calls ? esc(fmt.money((j.cost || 0) / g.calls)) : '—'}</td>` : ''}</tr>`;
      }).join('')}</tbody></table></div>` : '<div class="empty">No analyzed calls with a HYROS match yet.</div>'}</div>`;
  return `<div class="note"><b>Bottom of the funnel, back to the top.</b> Lead quality and close rate of the calls each source produced, joined by the prospect's email to the HYROS lead's first click${range ? ` · spend and leads from the ${esc(range.label || ctx.range)} report` : ''}. Which ads bring people who can actually be closed.</div>
    ${table('By first source (ad set)', 'the source HYROS credits the lead\'s first click to', bySource(rows), adsets)}
    <div class="fcols">${table('By campaign (source category)', 'HYROS\'s Campaign level', byCategory(rows), campaigns)}${table('By rep', 'who ran the call', byRep(rows), null)}</div>`;
}

/* ---------- setup: knowledge base + integrations ---------- */

async function loadSetup(ctx, st) {
  if (ctx.demo || typeof ctx.api !== 'function' || st.kb || st.loading) return;
  st.loading = true;
  try {
    const [kbr, ir] = await Promise.all([ctx.api('/api/kb'), ctx.api('/api/integrations')]);
    if (kbr.body?.ok) { st.kb = kbr.body.kb; st.kbMeta = { templates: kbr.body.templates || [], problems: kbr.body.problems || [], readOnly: kbr.body.readOnly }; }
    else st.err = kbr.body?.message || 'Could not load the knowledge base.';
    if (ir.body?.ok) st.integrations = ir.body; else st.integrations = { items: [], error: ir.body?.message || ir.body?.error };
  } catch (err) { st.err = err.message; }
  finally { st.loading = false; }
  render(ctx);
}

function setPath(obj, path, value) {
  const keys = path.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i += 1) cur = cur[keys[i]];
  cur[keys[keys.length - 1]] = value;
}

function setupView(ctx, st) {
  const { esc } = ctx;
  if (ctx.demo) st.kb = st.kb || JSON.parse(JSON.stringify(DEMO_KB));
  else if (!st.kb) { loadSetup(ctx, st); return `<div class="fpanel"><div class="empty">${st.err ? esc(st.err) : 'Loading setup…'}</div></div>`; }
  const kb = st.kb;
  const ro = ctx.demo ? 'disabled' : '';
  const total = kb.leadCriteria.reduce((s, c) => s + (Number(c.points) || 0), 0);
  const card = kb.scorecards.find((s) => s.id === kb.activeScorecardId) || kb.scorecards[0];
  const inp = (path, value, { type = 'text', placeholder = '', extra = '' } = {}) => `<input type="${type}" data-path="${esc(path)}" value="${esc(value ?? '')}" placeholder="${esc(placeholder)}" ${ro} ${extra}>`;
  const ta = (path, value, placeholder = '') => `<textarea data-path="${esc(path)}" placeholder="${esc(placeholder)}" ${ro}>${esc(value ?? '')}</textarea>`;
  const integrations = st.integrations || { items: [] };
  const item = (kind) => (integrations.items || []).find((i) => i.kind === kind) || null;
  const intRow = (kind, label, hint) => {
    const it = item(kind);
    return `<div class="calls-int"><b>${esc(label)}</b>
      ${it ? `<span class="pill ok">connected</span><span class="sub">${esc(it.label || '')}${it.events ? ` · ${esc(it.events)} deliveries` : ''}${it.lastEventAt ? ` · last ${esc(ctx.fmt.datetime(it.lastEventAt))}` : ''}${it.lastError ? `<br><span class="bad">${esc(it.lastError)}</span>` : ''}
          ${it.webhookUrl ? `<br>Webhook URL: <span class="calls-code">${esc(it.webhookUrl)}</span>${kind === 'fireflies' && integrations.firefliesSecret ? `<br>Signing secret: <span class="calls-code">${esc(integrations.firefliesSecret)}</span> — paste both into Fireflies → Settings → Developer settings` : ''}${kind === 'fathom' ? (it.webhookRegistered ? ' (registered on Fathom)' : ' — <span class="bad">not registered on Fathom</span>') : ''}` : ''}</span>
          ${kind !== 'anthropic' ? `<select data-backfill-days="${kind}" ${st.busy ? 'disabled' : ''}><option value="7">last 7 days</option><option value="30" selected>last 30 days</option><option value="90">last 90 days</option></select><button type="button" data-act="backfill" data-kind="${kind}" ${st.busy ? 'disabled' : ''}>Import calls</button>` : ''}
          <button type="button" class="danger" data-act="disconnect" data-id="${esc(it.id)}" ${st.busy ? 'disabled' : ''}>Disconnect</button>`
        : `<span class="sub">${esc(hint)}</span><form data-form="connect" data-kind="${kind}" class="calls-inline"><input type="password" name="apiKey" placeholder="${esc(label)} API key" autocomplete="off" ${ro} style="min-width:220px"><button type="submit" class="primary" ${st.busy || ctx.demo ? 'disabled' : ''}>Connect</button></form>`}
    </div>`;
  };
  return `<div class="note"><b>Setup.</b> The knowledge base tells the analysis how you sell and how to score; integrations bring the calls in.${ctx.demo ? ' <span class="pill warn">demo — read-only</span>' : ''}${st.kbMeta?.readOnly ? ' <span class="pill warn">preview deployment — read-only</span>' : ''}</div>
  <div class="fpanel"><h3>Integrations</h3><div class="fhint">keys are verified, encrypted and never shown again — they never leave the server</div>
    ${intRow('anthropic', 'Model', 'An Anthropic API key runs the analysis (console.anthropic.com → API keys).')}
    ${intRow('fathom', 'Fathom', 'Fathom → Settings → API Access → generate a key. A webhook is registered for you.')}
    ${intRow('fireflies', 'Fireflies', 'Fireflies → Settings → Developer settings → API key. Then paste the webhook URL and secret shown here into the same screen.')}
    ${integrations.error ? `<div class="sub bad">${esc(integrations.error)}</div>` : ''}
  </div>
  <form class="calls-form" data-form="kb">
  <div class="fcols">
    <div class="fpanel"><h3>Company info</h3><div class="fhint">name, industry, markets, offer, pricing</div>
      <div class="calls-form"><div class="calls-row2"><label>Company${inp('company.name', kb.company.name)}</label><label>Industry${inp('company.industry', kb.company.industry)}</label></div>
      <label>Markets / who you sell to${inp('company.markets', kb.company.markets)}</label><label>The offer${ta('company.offer', kb.company.offer, 'What you sell, the promise, the delivery model')}</label><label>Pricing${inp('company.pricing', kb.company.pricing, { placeholder: 'e.g. $15K setup + 5% rev share' })}</label></div></div>
    <div class="fpanel"><h3>Context entries</h3><div class="fhint">help the analysis understand how you sell — sales process, common objections, what a great call sounds like</div>
      <div class="calls-form">${kb.context.map((c, i) => `<div class="calls-row3" style="grid-template-columns:1fr 2fr auto"><label>Title${inp(`context.${i}.title`, c.title)}</label><label>Entry${ta(`context.${i}.body`, c.body)}</label><button type="button" data-remove="context.${i}" ${ro}>✕</button></div>`).join('')}
      <div><button type="button" data-add="context" ${ro}>+ Add entry</button></div></div></div>
  </div>
  <div class="fpanel"><h3>Lead grading criteria</h3><div class="fhint">what the analysis looks for when scoring a prospect — points must total exactly 100</div>
    <div class="calls-form"><div class="calls-total ${total === 100 ? 'good' : 'bad'}">${esc(total)} / 100 pts${total === 100 ? '' : ' — adjust criteria so they total exactly 100'}</div>
    ${kb.leadCriteria.map((c, i) => `<div class="calls-row3"><label>Name${inp(`leadCriteria.${i}.name`, c.name)}</label><label>What the analysis should look for and how to award points${ta(`leadCriteria.${i}.description`, c.description)}</label><label>Points${inp(`leadCriteria.${i}.points`, c.points, { type: 'number', extra: 'min="1" max="100"' })}</label><button type="button" data-remove="leadCriteria.${i}" ${ro}>✕</button></div>`).join('')}
    <div><button type="button" data-add="leadCriteria" ${ro}>+ Add criterion</button></div></div></div>
  <div class="fpanel"><h3>Rep scorecard</h3><div class="fhint">how reps are evaluated on every call — pick the active scorecard, edit its criteria, or add one from a template</div>
    <div class="calls-form"><div class="calls-inline"><label style="min-width:240px">Active scorecard<select data-path="activeScorecardId" ${ro}>${kb.scorecards.map((s) => `<option value="${esc(s.id)}"${s.id === kb.activeScorecardId ? ' selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
      ${!ctx.demo && st.kbMeta?.templates?.length ? `<label>Add from template<select data-add-template="1" ${ro}><option value="">Choose…</option>${st.kbMeta.templates.map((t) => `<option value="${esc(t.id)}">${esc(t.name)} — ${esc(t.description)}</option>`).join('')}</select></label>` : ''}
      <button type="button" data-add="scorecard" ${ro}>+ New scorecard</button>${kb.scorecards.length > 1 ? `<button type="button" class="danger" data-remove="scorecard" ${ro}>Delete active</button>` : ''}</div>
    ${card ? `<div class="calls-row2"><label>Name${inp(`scorecards.${kb.scorecards.indexOf(card)}.name`, card.name)}</label><label>Description${inp(`scorecards.${kb.scorecards.indexOf(card)}.description`, card.description)}</label></div>
      <div class="calls-total">Total possible: ${esc(card.criteria.reduce((s, c) => s + (Number(c.max) || 0), 0))} pts across ${esc(card.criteria.length)} criteria</div>
      ${card.criteria.map((c, i) => `<div class="calls-row3"><label>Title${inp(`scorecards.${kb.scorecards.indexOf(card)}.criteria.${i}.title`, c.title)}</label><label>What strong performance looks like${ta(`scorecards.${kb.scorecards.indexOf(card)}.criteria.${i}.description`, c.description)}</label><label>Max${inp(`scorecards.${kb.scorecards.indexOf(card)}.criteria.${i}.max`, c.max, { type: 'number', extra: 'min="1" max="100"' })}</label><button type="button" data-remove="scorecards.${kb.scorecards.indexOf(card)}.criteria.${i}" ${ro}>✕</button></div>`).join('')}
      <div><button type="button" data-add="scorecards.${kb.scorecards.indexOf(card)}.criteria" ${ro}>+ Add criterion</button></div>` : ''}</div></div>
  <div class="fcols">
    <div class="fpanel"><h3>Avatars</h3><div class="fhint">customer types the analysis assigns calls to; new ones are proposed automatically when none fits</div>
      <div class="calls-form">${kb.avatars.map((a, i) => `<div class="calls-row3" style="grid-template-columns:1fr 1fr 2fr auto"><label>Name${inp(`avatars.${i}.name`, a.name)}</label><label>Who${inp(`avatars.${i}.who`, a.who)}</label><label>Description${ta(`avatars.${i}.description`, a.description)}</label><button type="button" data-remove="avatars.${i}" ${ro} title="${esc(a.callCount || 0)} calls">✕</button></div>`).join('') || '<div class="sub">None yet.</div>'}
      <div><button type="button" data-add="avatars" ${ro}>+ Add avatar</button></div></div></div>
    <div class="fpanel"><h3>Write-back to HYROS &amp; model</h3><div class="fhint">push each analyzed call's scores into HYROS as lead tags (opt-in); optional model override</div>
      <div class="calls-form"><label class="calls-check"><input type="checkbox" data-path="writeBack.enabled" ${kb.writeBack.enabled ? 'checked' : ''} ${ro}> Add tags to the matched lead (e.g. <span class="calls-code">${esc(kb.writeBack.tagPrefix)}-score-88</span>, <span class="calls-code">${esc(kb.writeBack.tagPrefix)}-hot</span>, avatar)</label>
      <label class="calls-check"><input type="checkbox" data-path="writeBack.createCalls" ${kb.writeBack.createCalls ? 'checked' : ''} ${ro}> Also log the call in HYROS (hyros_create_call — experimental)</label>
      <div class="calls-row2"><label>Tag prefix${inp('writeBack.tagPrefix', kb.writeBack.tagPrefix)}</label><label>Model override (blank = default)${inp('model', kb.model || '', { placeholder: 'leave blank' })}</label></div></div></div>
  </div>
  ${!ctx.demo ? `<div class="calls-inline" style="margin-top:4px"><button type="submit" class="primary" ${st.busy ? 'disabled' : ''}>Save knowledge base</button><span class="sub calls-status">${st.kbMeta?.problems?.length ? esc(st.kbMeta.problems.join(' · ')) : (kb.updatedAt ? `saved ${esc(ctx.fmt.datetime(kb.updatedAt))}` : 'not saved yet — defaults in use')}</span></div>` : ''}
  </form>`;
}

/* ---------- wiring ---------- */

function wire(ctx, st) {
  const root = ctx.root;
  if (typeof root.querySelectorAll !== 'function') return;
  const on = (sel, evt, fn) => root.querySelectorAll(sel).forEach((el) => el.addEventListener(evt, fn));
  on('[data-nav]', 'click', (e) => { const id = e.currentTarget.dataset.nav; if (e.currentTarget.dataset.tab) st.tab = id; else { st.view = id; st.callId = null; } st.err = null; render(ctx); if (id === 'list') loadIndex(ctx, st); });
  on('[data-open]', 'click', (e) => { st.view = 'detail'; st.callId = e.currentTarget.dataset.open; st.tab = 'overview'; st.err = null; render(ctx); });
  on('[data-filter]', 'input', (e) => { st.filters[e.currentTarget.dataset.filter] = e.currentTarget.value; render(ctx); const q = root.querySelector('[data-filter="q"]'); if (q && e.currentTarget.dataset.filter === 'q') { q.focus(); q.setSelectionRange(q.value.length, q.value.length); } });
  on('[data-filter]', 'change', (e) => { st.filters[e.currentTarget.dataset.filter] = e.currentTarget.value; render(ctx); });
  on('[data-journey]', 'click', (e) => ctx.openJourney(e.currentTarget.dataset.journey));
  on('[data-act="paste-toggle"]', 'click', () => { st.paste = !st.paste; render(ctx); });
  on('[data-act="reload"]', 'click', () => { st.fetchedAt = 0; st.cache.clear(); loadIndex(ctx, st, { force: true }); });
  on('[data-act="analyze-queued"]', 'click', async () => {
    const r = await post(ctx, st, '/api/calls', { action: 'analyze-queued' });
    st.fetchedAt = 0; await loadIndex(ctx, st, { force: true });
    if (r?.ok && r.remaining) st.msg = `${r.processed} analyzed, ${r.remaining} still queued — press again to continue.`;
    render(ctx);
  });
  on('[data-act="reanalyze"]', 'click', async () => { await post(ctx, st, '/api/calls', { action: 'analyze', id: st.callId }); st.cache.delete(st.callId); st.fetchedAt = 0; loadIndex(ctx, st, { force: true }); });
  on('[data-act="delete"]', 'click', async () => {
    if (typeof confirm === 'function' && !confirm('Delete this call and its analysis?')) return;
    st.busy = true; render(ctx);
    try { await ctx.api(`/api/calls?id=${encodeURIComponent(st.callId)}`, { method: 'DELETE' }); } catch (err) { st.err = err.message; }
    st.busy = false; st.cache.delete(st.callId); st.view = 'list'; st.callId = null; st.fetchedAt = 0; loadIndex(ctx, st, { force: true });
  });
  on('[data-act="outcome"]', 'change', async (e) => { const outcome = e.currentTarget.value; if (!outcome) return; await post(ctx, st, '/api/calls', { action: 'outcome', id: st.callId, outcome }); st.cache.delete(st.callId); st.fetchedAt = 0; loadIndex(ctx, st, { force: true }); });
  on('[data-act="avatar"]', 'change', async (e) => { const avatarId = e.currentTarget.value; if (!avatarId) return; await post(ctx, st, '/api/calls', { action: 'assign-avatar', id: st.callId, avatarId }); st.cache.delete(st.callId); st.fetchedAt = 0; loadIndex(ctx, st, { force: true }); });
  on('[data-form="paste"]', 'submit', async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    const v = (n) => (f.querySelector(`[name="${n}"]`)?.value || '').trim();
    const email = v('email');
    const r = await post(ctx, st, '/api/calls', { action: 'paste', title: v('title'), date: v('date') || null, rep: v('rep') || null, transcript: v('transcript'), attendees: email ? [{ name: null, email, external: true }] : [] });
    if (r?.ok) { st.paste = false; st.view = 'detail'; st.callId = r.id; st.tab = 'overview'; st.cache.delete(r.id); st.fetchedAt = 0; loadIndex(ctx, st, { force: true }); }
  });
  // setup
  on('[data-path]', 'input', (e) => { const el = e.currentTarget; if (!st.kb) return; setPath(st.kb, el.dataset.path, el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value); if (el.type === 'number' || el.type === 'checkbox') render(ctx); });
  on('select[data-path]', 'change', (e) => { setPath(st.kb, e.currentTarget.dataset.path, e.currentTarget.value); render(ctx); });
  on('[data-add]', 'click', (e) => {
    const what = e.currentTarget.dataset.add; const kb = st.kb;
    if (what === 'context') kb.context.push({ id: `ctx_${Date.now()}`, title: '', body: '' });
    else if (what === 'leadCriteria') kb.leadCriteria.push({ id: `crit-${Date.now()}`, name: '', description: '', points: 0 });
    else if (what === 'avatars') kb.avatars.push({ id: `av_${Date.now()}`, name: '', who: '', description: '', callCount: 0 });
    else if (what === 'scorecard') { const id = `card-${Date.now()}`; kb.scorecards.push({ id, name: 'New scorecard', description: '', criteria: [{ id: 'c1', title: '', description: '', max: 10 }] }); kb.activeScorecardId = id; }
    else if (what.endsWith('.criteria')) { const card = kb.scorecards[Number(what.split('.')[1])]; card.criteria.push({ id: `c${Date.now()}`, title: '', description: '', max: 10 }); }
    render(ctx);
  });
  on('[data-add-template]', 'change', (e) => {
    const t = (st.kbMeta?.templates || []).find((x) => x.id === e.currentTarget.value); if (!t) return;
    const id = st.kb.scorecards.some((s) => s.id === t.id) ? `${t.id}-${Date.now()}` : t.id;
    st.kb.scorecards.push({ ...JSON.parse(JSON.stringify(t)), id }); st.kb.activeScorecardId = id; render(ctx);
  });
  on('[data-remove]', 'click', (e) => {
    const path = e.currentTarget.dataset.remove; const kb = st.kb;
    if (path === 'scorecard') { kb.scorecards = kb.scorecards.filter((s) => s.id !== kb.activeScorecardId); kb.activeScorecardId = kb.scorecards[0]?.id; render(ctx); return; }
    const keys = path.split('.'); const idx = Number(keys.pop()); let cur = kb; for (const k of keys) cur = cur[k];
    if (Array.isArray(cur)) cur.splice(idx, 1);
    render(ctx);
  });
  on('[data-form="kb"]', 'submit', async (e) => {
    e.preventDefault();
    const r = await post(ctx, st, '/api/kb', { kb: st.kb });
    if (r?.ok) { st.kb = r.kb; st.kbMeta = { ...(st.kbMeta || {}), problems: [] }; st.msg = 'Knowledge base saved.'; }
    else if (r?.problems) st.kbMeta = { ...(st.kbMeta || {}), problems: r.problems };
    render(ctx);
  });
  on('[data-form="connect"]', 'submit', async (e) => {
    e.preventDefault();
    const f = e.currentTarget; const apiKey = f.querySelector('[name="apiKey"]')?.value || '';
    const r = await post(ctx, st, '/api/integrations', { kind: f.dataset.kind, apiKey });
    if (r?.ok) { st.integrations = null; st.kb = null; st.msg = `${f.dataset.kind} connected.`; loadSetup(ctx, st); }
  });
  on('[data-act="disconnect"]', 'click', async (e) => {
    const id = e.currentTarget.dataset.id;
    st.busy = true; render(ctx);
    try { await ctx.api(`/api/integrations?id=${encodeURIComponent(id)}`, { method: 'DELETE' }); } catch (err) { st.err = err.message; }
    st.busy = false; st.integrations = null; st.kb = null; loadSetup(ctx, st);
  });
  on('[data-act="backfill"]', 'click', async (e) => {
    const kind = e.currentTarget.dataset.kind;
    const days = Number(root.querySelector(`[data-backfill-days="${kind}"]`)?.value || 30);
    const r = await post(ctx, st, '/api/integrations', { action: 'backfill', kind, days });
    if (r?.ok) { st.msg = r.message; st.fetchedAt = 0; loadIndex(ctx, st, { force: true }); }
  });
}

/* ---------- render ---------- */

export function render(ctx) {
  const st = state(ctx.root);
  const raw = ctx.block;
  const b = blockOf(ctx, st);
  const rows = Array.isArray(b.rows) ? b.rows : [];
  const has = raw && typeof raw === 'object';
  const intro = `<div class="note"><b>Call Intelligence.</b> Sales calls from Fathom, Fireflies or paste, analyzed into a deal summary, lead score, rep scorecard, buying language, objections and avatar — each joined to its HYROS attribution.${statusLine(has ? raw : null, ctx)}${ctx.demo ? ' <span class="pill warn">demo</span>' : ''}</div>`;
  if (!has && ctx.demo) { ctx.root.innerHTML = `${intro}<div class="fpanel"><div class="empty">No call intelligence in this snapshot.</div></div>`; return; }
  let body = '';
  try {
    if (st.view === 'detail') body = detailView(ctx, st, b);
    else if (st.view === 'avatars') body = avatarsView(ctx, st, b);
    else if (st.view === 'sources') body = sourcesView(ctx, st, b);
    else if (st.view === 'setup') body = setupView(ctx, st);
    else body = listView(ctx, st, { ...b, rows });
  } catch (err) {
    body = `<div class="note err"><b>Could not render this view.</b> ${ctx.esc(err.message)}</div>`;
  }
  ctx.root.innerHTML = `${intro}${nav(ctx, st, { ...b, rows })}${body}`;
  wire(ctx, st);
  if (!ctx.demo && st.view !== 'setup') loadIndex(ctx, st);
}
