/**
 * Call store — recorded calls and their analyses, per account, in KV:
 *
 *   aihyros:acct:<id>:call:<callId>   one call: transcript + analysis (read on demand)
 *   aihyros:acct:<id>:calls:index     compact rows for the tab and the snapshot (≤ INDEX_MAX)
 *
 * A call arrives from a note-taker webhook (api/ingest.js), a backfill
 * (api/_integrations.js) or a pasted transcript (api/calls.js), always as
 * `status: 'queued'`; api/_analyze.js moves it to analyzing → done | error.
 * The index is what /api/refresh copies into the snapshot (snapshot.callIntel)
 * so the Call Intelligence tab works from the one-document snapshot like
 * every other tab; details are fetched through /api/calls?id=.
 */
import { createHash, randomBytes } from 'node:crypto';
import { kvRaw, storeConfigured } from './_store.js';

export const INDEX_MAX = 300;
const callKey = (accountId, id) => `aihyros:acct:${accountId}:call:${id}`;
const indexKey = (accountId) => `aihyros:acct:${accountId}:calls:index`;
const CALL_TTL_S = 60 * 60 * 24 * 365; // a year; the index is what is kept "forever"

export const callIdFor = (source, externalId) => `c_${createHash('sha256').update(`${source}:${externalId}`).digest('hex').slice(0, 12)}`;
export const newCallId = () => `c_${randomBytes(6).toString('hex')}`;
const ID_SHAPE = /^c_[0-9a-f]{12}$/;
export const validCallId = (id) => ID_SHAPE.test(String(id || ''));

const str = (v, n = 400) => (v === null || v === undefined ? '' : String(v)).slice(0, n);

/* ---------------- transcripts ---------------- */

const TS = /^\[?(\d{1,2}):(\d{2})(?::(\d{2}))?\]?\s*/;
const SPEAKER = /^([A-Za-z][^:]{0,60}?)\s*:\s+(.*)$/;

/** Seconds from "hh:mm:ss" / "mm:ss" (null when unparseable). */
export function parseTimestamp(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const m = String(v).trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) { const n = Number(v); return Number.isFinite(n) ? n : null; }
  return m[3] !== undefined ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : Number(m[1]) * 60 + Number(m[2]);
}

/**
 * A pasted transcript, one utterance per line, in any of the common shapes:
 *   [00:12:03] Jay: text · 12:03 Jay: text · Jay (12:03): text · Jay: text · plain text
 * Consecutive plain lines join the previous speaker's utterance.
 */
export function parsePastedTranscript(text) {
  const lines = [];
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line) continue;
    let t = null;
    const ts = line.match(TS);
    if (ts) { t = parseTimestamp(ts[0].replace(/[[\]\s]/g, '')); line = line.slice(ts[0].length); }
    const paren = line.match(/^([^:(]{1,60}?)\s*\((\d{1,2}:\d{2}(?::\d{2})?)\)\s*:\s*(.*)$/);
    if (paren) { lines.push({ t: parseTimestamp(paren[2]), speaker: paren[1].trim(), text: paren[3].trim() }); continue; }
    const sp = line.match(SPEAKER);
    if (sp) { lines.push({ t, speaker: sp[1].trim(), text: sp[2].trim() }); continue; }
    if (lines.length && t === null) lines[lines.length - 1].text += ` ${line}`;
    else lines.push({ t, speaker: 'Unknown', text: line });
  }
  return lines;
}

/** Coerce any transcript-ish array into [{ t, speaker, text }]. */
export function normalizeTranscript(items) {
  return (Array.isArray(items) ? items : []).map((l) => ({
    t: parseTimestamp(l?.t ?? l?.timestamp ?? l?.start_time ?? l?.startTime ?? null),
    speaker: str(l?.speaker?.display_name ?? l?.speaker_name ?? l?.speakerName ?? l?.speaker ?? 'Unknown', 80) || 'Unknown',
    text: str(l?.text, 4000),
  })).filter((l) => l.text);
}

export const durationOf = (lines) => {
  const ts = (lines || []).map((l) => l.t).filter((t) => Number.isFinite(t));
  return ts.length ? Math.max(...ts) : null;
};

/* ---------------- records ---------------- */

/**
 * A call record as stored. `source` names where it came from; `externalId`
 * is the vendor's id (dedupe key); `attendees` carry `external` for people
 * outside the recording account (the prospect side).
 */
export function newCall({ id, source, externalId = null, title, date, durationS = null, attendees = [], recordedBy = null, rep = null, transcript, vendorSummary = null, url = null, raw = null }) {
  const lines = normalizeTranscript(transcript);
  const now = new Date().toISOString();
  return {
    id: id || (externalId ? callIdFor(source, externalId) : newCallId()),
    source: str(source, 20) || 'paste', externalId: externalId ? str(externalId, 120) : null,
    title: str(title, 200) || 'Untitled call',
    date: date ? new Date(date).toISOString() : now,
    durationS: Number.isFinite(Number(durationS)) && Number(durationS) > 0 ? Math.round(Number(durationS)) : durationOf(lines),
    attendees: (Array.isArray(attendees) ? attendees : []).slice(0, 20).map((a) => ({ name: str(a?.name, 120) || null, email: a?.email ? str(a.email, 200).toLowerCase() : null, external: Boolean(a?.external) })).filter((a) => a.name || a.email),
    recordedBy: recordedBy && (recordedBy.name || recordedBy.email) ? { name: str(recordedBy.name, 120) || null, email: recordedBy.email ? str(recordedBy.email, 200).toLowerCase() : null } : null,
    rep: rep ? str(rep, 120) : null,
    transcript: lines,
    vendorSummary: vendorSummary ? str(vendorSummary, 8000) : null,
    url: url ? str(url, 500) : null,
    raw: raw && typeof raw === 'object' ? { ...raw } : null,
    status: 'queued', error: null,
    createdAt: now, updatedAt: now, analyzedAt: null,
    analysis: null, attribution: null, writeBack: null, model: null, usage: null,
  };
}

/** The compact row the index and the snapshot carry (≈ 600 bytes). */
export function indexRowOf(call) {
  const a = call.analysis;
  const short = (list, n = 3, len = 90) => (Array.isArray(list) ? list : []).slice(0, n).map((x) => str(x, len));
  return {
    id: call.id, source: call.source, title: call.title, date: call.date, durationS: call.durationS,
    rep: a?.participants?.rep || call.rep || call.recordedBy?.name || null,
    prospect: a?.participants?.prospect || (call.attendees || []).find((x) => x.external)?.name || null,
    leadEmail: call.attribution?.email || a?.participants?.prospectEmail || (call.attendees || []).find((x) => x.external && x.email)?.email || null,
    outcome: a?.outcome || null,
    leadScore: a ? a.leadQuality.score : null, leadMax: a ? a.leadQuality.max : null,
    repScore: a ? a.repScorecard.total : null, repMax: a ? a.repScorecard.max : null,
    temperature: a?.buyingLanguage?.temperature || null,
    avatarId: a?.avatar?.id || null, avatarName: a?.avatar?.name || null,
    painPoints: short(a?.prospect?.painPoints), desires: short(a?.prospect?.desires), language: short(a?.prospect?.language, 3, 160),
    attribution: call.attribution && !call.attribution.error && call.attribution.matched ? {
      firstSource: call.attribution.firstSource?.name || null, lastSource: call.attribution.lastSource?.name || null,
      category: call.attribution.firstSource?.category || null, ad: call.attribution.firstSource?.ad || null, stage: call.attribution.stage || null,
    } : null,
    status: call.status, error: call.error ? str(call.error, 200) : null,
    analyzedAt: call.analyzedAt || null,
  };
}

/** What the API hands the browser: everything except the vendor's raw payload. */
export function publicCall(call) {
  if (!call) return null;
  const { raw, ...rest } = call;
  return rest;
}

/* ---------------- KV ---------------- */

async function readJson(key) {
  const raw = await kvRaw(['GET', key]);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export async function readCall(accountId, id) {
  if (!storeConfigured() || !validCallId(id)) return null;
  return readJson(callKey(accountId, id));
}

export async function writeCall(accountId, call) {
  call.updatedAt = new Date().toISOString();
  return (await kvRaw(['SET', callKey(accountId, call.id), JSON.stringify(call), 'EX', String(CALL_TTL_S)])) !== null;
}

export async function readIndex(accountId) {
  const idx = storeConfigured() && accountId ? await readJson(indexKey(accountId)) : null;
  return { rows: Array.isArray(idx?.rows) ? idx.rows : [], updatedAt: idx?.updatedAt || null, truncated: Boolean(idx?.truncated), dropped: idx?.dropped || 0 };
}

/** Newest INDEX_MAX rows by date; older rows fall off and are counted in `dropped`. */
export function capIndex(rows, max = INDEX_MAX) {
  const sorted = [...rows].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  return { rows: sorted.slice(0, max), dropped: Math.max(0, sorted.length - max) };
}

/** Replace (or add) one call's row in the index. Read-modify-write; last writer wins. */
export async function upsertIndex(accountId, call) {
  const idx = await readIndex(accountId);
  const row = indexRowOf(call);
  const { rows, dropped } = capIndex([...idx.rows.filter((r) => r.id !== row.id), row]);
  const next = { rows, updatedAt: new Date().toISOString(), truncated: idx.truncated || dropped > 0, dropped: idx.dropped + dropped };
  await kvRaw(['SET', indexKey(accountId), JSON.stringify(next)]);
  return next;
}

export async function removeFromIndex(accountId, id) {
  const idx = await readIndex(accountId);
  const next = { ...idx, rows: idx.rows.filter((r) => r.id !== id), updatedAt: new Date().toISOString() };
  await kvRaw(['SET', indexKey(accountId), JSON.stringify(next)]);
  return next;
}

/** Store a new call (queued) and index it. An existing id is left alone unless `replace`. */
export async function saveNewCall(accountId, call, { replace = false } = {}) {
  const existing = await readCall(accountId, call.id);
  if (existing && !replace) return { call: existing, duplicate: true };
  await writeCall(accountId, call);
  await upsertIndex(accountId, call);
  return { call, duplicate: false };
}

export async function setStatus(accountId, id, status, error = null) {
  const call = await readCall(accountId, id);
  if (!call) return null;
  call.status = status; call.error = error;
  await writeCall(accountId, call);
  await upsertIndex(accountId, call);
  return call;
}

export async function deleteCall(accountId, id) {
  if (!validCallId(id)) return false;
  await kvRaw(['DEL', callKey(accountId, id)]);
  await removeFromIndex(accountId, id);
  return true;
}

/** Every call key of an account (factory reset uses wipeAll; account removal uses this). */
export async function deleteAccountCalls(accountId) {
  let cursor = '0';
  for (let guard = 0; guard < 100; guard += 1) {
    const r = await kvRaw(['SCAN', cursor, 'MATCH', `aihyros:acct:${accountId}:call*`, 'COUNT', '200']);
    if (!Array.isArray(r)) break;
    const [next, keys] = r;
    if (Array.isArray(keys) && keys.length) await kvRaw(['DEL', ...keys]);
    cursor = String(next);
    if (cursor === '0') break;
  }
  await kvRaw(['DEL', indexKey(accountId), `aihyros:acct:${accountId}:kb`, `aihyros:acct:${accountId}:integrations`]);
}
