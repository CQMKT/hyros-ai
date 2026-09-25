/**
 * The analysis pipeline for one call, end to end:
 *
 *   1. transcript + knowledge base → structured analysis (api/_analysis.js, the model)
 *   2. the prospect's email → HYROS lead (hyros_get_leads {emails}) → first/last
 *      source, stage: the call now carries its ad attribution (bottom of the
 *      funnel joined back to the top)
 *   3. avatars: assign the existing one or add the proposed one to the KB
 *   4. optional write-back into HYROS: lead tags (ai-score-88, ai-hot, …) and
 *      a call record — only when the KB's writeBack is switched on
 *   5. store the call and its index row
 *
 * Every step after the model is best-effort: a failed join or write-back is
 * recorded on the call, never fails the analysis. `analyzeQueued` walks the
 * queue inside a time budget so a Vercel function never dies mid-analysis.
 */
import { readCall, writeCall, upsertIndex, readIndex } from './_calls.js';
import { readKb, patchKb, newId, MAX_AVATARS } from './_kb.js';
import { integrationKey } from './_integrations.js';
import { analyzeTranscript } from './_analysis.js';
import { asAccount } from './_accounts.js';
import { callTool } from './_mcp.js';
import { parseHyrosDate } from './_dates.js';
import { logEvent } from './_log.js';

/** Roughly what one analysis needs; a queued run never starts one with less. */
export const ANALYSIS_RESERVE_MS = 150000;

const flatSource = (src) => (src && typeof src === 'object' ? {
  name: src.name || null, tag: src.tag || null, organic: Boolean(src.organic),
  ad: src.sourceLinkAd?.name || src.ad || null, category: src.category?.name || src.category || null,
  trafficSource: src.trafficSource?.name || src.trafficSource || null, clickDate: parseHyrosDate(src.clickDate) || null,
} : null);

/** Emails worth looking up: the external side of the call, never the rep or the recording account. */
export function prospectEmails(call, analysis) {
  const skip = new Set([call.recordedBy?.email].filter(Boolean));
  const out = [];
  const push = (e) => { const v = String(e || '').trim().toLowerCase(); if (v && v.includes('@') && !skip.has(v) && !out.includes(v)) out.push(v); };
  push(analysis?.participants?.prospectEmail);
  for (const a of (call.attendees || []).filter((x) => x.external)) push(a.email);
  if (!out.length) for (const a of call.attendees || []) push(a.email);
  return out.slice(0, 10);
}

/** Look the prospect up in HYROS (as the account). Returns the attribution block, never throws. */
export async function joinAttribution(accountId, emails) {
  if (!emails.length) return { matched: false, reason: 'no prospect email on the call' };
  try {
    const body = await asAccount(accountId, () => callTool('hyros_get_leads', { request: { emails, pageSize: 50 } }, { timeoutMs: 15000 }));
    const leads = Array.isArray(body) ? body : body?.result || [];
    const lead = leads.find((l) => emails.includes(String(l.email || '').toLowerCase())) || leads[0];
    if (!lead) return { matched: false, reason: 'no HYROS lead with that email', emails };
    return {
      matched: true, email: String(lead.email || '').toLowerCase(), leadId: lead.id || null,
      name: [lead.firstName, lead.lastName].filter(Boolean).join(' ') || null,
      joined: parseHyrosDate(lead.creationDate) || null, stage: lead.currentStage?.name || null,
      firstSource: flatSource(lead.firstSource), lastSource: flatSource(lead.lastSource),
      tags: (Array.isArray(lead.tags) ? lead.tags : []).slice(0, 20),
    };
  } catch (err) {
    return { matched: false, error: err.message, code: err.code || null, emails };
  }
}

/** Tags the write-back adds to the lead: score band, temperature, outcome, avatar. */
export function writeBackTags(analysis, kb) {
  const p = kb.writeBack?.tagPrefix || 'ai';
  const tags = [`${p}-score-${analysis.leadQuality.score}`, `${p}-lead-${analysis.leadQuality.label.toLowerCase()}`, `${p}-${analysis.buyingLanguage.temperature}`, `${p}-${analysis.outcome.replace('_', '-')}`];
  const av = kb.avatars.find((a) => a.id === analysis.avatar.id);
  if (av) tags.push(`${p}-avatar-${String(av.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30)}`);
  return tags;
}

const CALL_STATUS = { closed: 'QUALIFIED', follow_up: 'QUALIFIED', lost: 'NOT_QUALIFIED', no_show: 'NO_SHOW', unknown: 'UNKNOWN' };

/** Push tags (and optionally a call record) into HYROS. Best effort; the result lands on the call. */
export async function writeBack(accountId, call, analysis, attribution, kb) {
  if (!kb.writeBack?.enabled) return null;
  if (!attribution?.matched) return { ok: false, skipped: 'no matched HYROS lead' };
  const out = { ok: true, tags: writeBackTags(analysis, kb), at: new Date().toISOString() };
  try {
    await asAccount(accountId, () => callTool('hyros_add_tags_to_leads', { request: { emails: [attribution.email], tags: out.tags } }, { timeoutMs: 15000 }));
  } catch (err) { out.ok = false; out.error = `tags: ${err.message}`; }
  if (kb.writeBack.createCalls) {
    try {
      const r = await asAccount(accountId, () => callTool('hyros_create_call', { request: { email: attribution.email, callDate: call.date, status: CALL_STATUS[analysis.outcome] || 'UNKNOWN', name: call.title } }, { timeoutMs: 15000 }));
      out.call = { requestId: r?.requestId || r?.request_id || null };
    } catch (err) { out.ok = false; out.error = `${out.error ? `${out.error}; ` : ''}call: ${err.message}`; }
  }
  return out;
}

/** Add the proposed avatar (or bump the matched one) in the KB; returns the avatar id used. */
async function settleAvatar(accountId, analysis) {
  let id = analysis.avatar.id;
  let name = null;
  await patchKb(accountId, (kb) => {
    if (id) {
      const a = kb.avatars.find((x) => x.id === id);
      if (a) { a.callCount = (a.callCount || 0) + 1; name = a.name; }
      return kb;
    }
    const p = analysis.avatar.proposedNew;
    if (!p) return kb;
    const same = kb.avatars.find((x) => x.name.toLowerCase() === p.name.toLowerCase());
    if (same) { same.callCount = (same.callCount || 0) + 1; id = same.id; name = same.name; return kb; }
    if (kb.avatars.length >= MAX_AVATARS) return kb;
    const fresh = { id: newId('av'), name: p.name, who: p.who, description: p.description, callCount: 1, createdAt: new Date().toISOString() };
    kb.avatars.push(fresh); id = fresh.id; name = fresh.name;
    return kb;
  });
  return { id, name };
}

/**
 * Analyze one stored call. Returns the updated call (status done or error).
 * Never throws for a model/vendor failure — the error is stored on the call —
 * but does throw on an unknown call id.
 */
export async function analyzeCall(accountId, callId, { log = () => {}, force = false } = {}) {
  const started = Date.now();
  const call = await readCall(accountId, callId);
  if (!call) throw Object.assign(new Error('Unknown call.'), { status: 404, code: 'not_found' });
  if (call.status === 'done' && !force) return call;
  const kb = await readKb(accountId);
  const apiKey = await integrationKey(accountId, 'anthropic');
  const failWith = async (message, code) => {
    call.status = 'error'; call.error = message;
    await writeCall(accountId, call); await upsertIndex(accountId, call);
    logEvent('call.analysis.failed', { accountId, callId, code, ms: Date.now() - started });
    return call;
  };
  if (!apiKey) return failWith('No Anthropic API key is connected — add one under Call Intelligence → Setup → Integrations.', 'llm_auth');
  call.status = 'analyzing'; call.error = null;
  await writeCall(accountId, call); await upsertIndex(accountId, call);

  let result;
  try {
    result = await analyzeTranscript({ call, kb, apiKey, model: kb.model || null, log });
  } catch (err) {
    return failWith(err.message, err.code || 'llm_error');
  }
  const analysis = result.analysis;
  log('attribution');
  const attribution = await joinAttribution(accountId, prospectEmails(call, analysis));
  log('avatar');
  try { const av = await settleAvatar(accountId, analysis); analysis.avatar.id = av.id; analysis.avatar.name = av.name; }
  catch (err) { analysis.avatar.error = err.message; }
  log('write-back');
  const wb = await writeBack(accountId, call, analysis, attribution, kb);

  call.analysis = analysis; call.attribution = attribution; call.writeBack = wb;
  call.model = result.model; call.usage = result.usage; call.passes = result.passes; call.condensed = result.condensed;
  call.status = 'done'; call.error = null; call.analyzedAt = new Date().toISOString();
  await writeCall(accountId, call);
  await upsertIndex(accountId, call);
  logEvent('call.analysis.ok', { accountId, callId, ms: Date.now() - started, passes: result.passes, score: analysis.leadQuality.score, matched: attribution.matched, writeBack: wb ? wb.ok : null });
  return call;
}

/**
 * Analyze queued calls, newest first, while the budget allows a full
 * analysis. Returns what happened so the UI can loop.
 */
export async function analyzeQueued(accountId, { budgetMs, log = () => {}, ids = null } = {}) {
  const deadline = Date.now() + budgetMs;
  const idx = await readIndex(accountId);
  const queue = idx.rows.filter((r) => r.status === 'queued' && (!ids || ids.includes(r.id)));
  const done = [];
  for (const row of queue) {
    if (deadline - Date.now() < ANALYSIS_RESERVE_MS) { done.push({ id: row.id, skipped: 'time budget' }); continue; }
    try {
      const c = await analyzeCall(accountId, row.id, { log: (s) => log(`${row.id}: ${s}`) });
      done.push({ id: row.id, status: c.status, error: c.error || undefined });
    } catch (err) { done.push({ id: row.id, status: 'error', error: err.message }); }
  }
  return { processed: done.filter((d) => d.status).length, remaining: done.filter((d) => d.skipped).length, results: done };
}
