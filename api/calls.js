/**
 * /api/calls — the Call Intelligence tab's backend (password-gated, account-scoped).
 *
 *   GET                     the index: rows + avatars + integration status
 *   GET  ?id=<callId>       one call with its transcript and analysis
 *   POST {action:'paste', title, transcript, date?, attendees?, rep?, analyze?}
 *                           store a pasted transcript (and analyze it, default true)
 *   POST {action:'analyze', id}            (re-)analyze one call
 *   POST {action:'analyze-queued', ids?}   analyze queued calls within the function budget
 *   POST {action:'outcome', id, outcome}   override the outcome by hand
 *   POST {action:'assign-avatar', id, avatarId}
 *   DELETE ?id=<callId>
 *
 * Analysis runs inside this function (Vercel Fluid compute, up to 300 s);
 * a long queue is processed across calls — the response says what is left.
 */
import { checkAccess, deny } from './_auth.js';
import { accountFromReq } from './_accounts.js';
import { storeConfigured, storeReadOnly } from './_store.js';
import { readIndex, readCall, publicCall, newCall, saveNewCall, deleteCall, parsePastedTranscript, validCallId, writeCall, upsertIndex } from './_calls.js';
import { analyzeCall, analyzeQueued } from './_analyze.js';
import { readKb, OUTCOMES } from './_kb.js';
import { readIntegrations } from './_integrations.js';
import { REFRESH_MAX_S, REFRESH_BUDGET_MS } from './_budget.js';
import { logEvent } from './_log.js';

export const maxDuration = REFRESH_MAX_S;

const fail = (message, status, code) => Object.assign(new Error(message), { status, code });

function guardWrites() {
  if (!storeConfigured()) throw fail('Storage is not set up — calls cannot be stored.', 503, 'needs_storage');
  if (storeReadOnly()) throw fail('This is a preview deployment (read-only) — use the production URL.', 409, 'read_only');
}

export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  const access = await checkAccess(req);
  if (!access.ok) return deny(res, access);
  const accountId = await accountFromReq(req);
  if (!accountId) return res.status(503).json({ ok: false, error: 'not_configured', message: 'No HYROS account is connected yet — add one from the account menu.' });
  const url = new URL(req.url, `http://${req.headers.host || 'local'}`);
  const started = Date.now();

  try {
    if (req.method === 'GET') {
      const id = url.searchParams.get('id');
      if (id) {
        if (!validCallId(id)) return res.status(400).json({ ok: false, error: 'bad_request', message: 'Bad call id.' });
        const call = await readCall(accountId, id);
        if (!call) return res.status(404).json({ ok: false, error: 'not_found' });
        return res.status(200).json({ ok: true, account: accountId, call: publicCall(call) });
      }
      const [index, kb, integrations] = await Promise.all([readIndex(accountId), readKb(accountId), readIntegrations(accountId)]);
      return res.status(200).json({
        ok: true, account: accountId, ...index,
        avatars: kb.avatars, activeScorecardId: kb.activeScorecardId, writeBack: kb.writeBack,
        connected: Object.fromEntries(['anthropic', 'fathom', 'fireflies'].map((k) => [k, integrations.some((i) => i.kind === k)])),
        readOnly: storeReadOnly(),
      });
    }

    if (req.method === 'DELETE') {
      guardWrites();
      const id = url.searchParams.get('id');
      const ok = await deleteCall(accountId, id);
      return res.status(ok ? 200 : 400).json({ ok, error: ok ? undefined : 'bad_request' });
    }

    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
    guardWrites();
    const body = req.body || {};
    const steps = [];
    const log = (s) => steps.push(s);

    if (body.action === 'paste') {
      const lines = parsePastedTranscript(body.transcript);
      if (lines.length < 2) throw fail('Paste a transcript with at least two lines (one utterance per line, "Speaker: text").', 400, 'bad_request');
      const call = newCall({
        source: 'paste', title: body.title || 'Pasted call', date: body.date || null, durationS: body.durationS || null,
        attendees: Array.isArray(body.attendees) ? body.attendees : [], rep: body.rep || null, transcript: lines,
      });
      const { duplicate } = await saveNewCall(accountId, call);
      let stored = call;
      if (body.analyze !== false && !duplicate) stored = await analyzeCall(accountId, call.id, { log });
      return res.status(200).json({ ok: true, id: call.id, status: stored.status, error: stored.error || undefined, duplicate, steps, ms: Date.now() - started });
    }
    if (body.action === 'analyze') {
      if (!validCallId(body.id)) throw fail('Bad call id.', 400, 'bad_request');
      const call = await analyzeCall(accountId, body.id, { log, force: true });
      return res.status(200).json({ ok: true, id: call.id, status: call.status, error: call.error || undefined, steps, ms: Date.now() - started });
    }
    if (body.action === 'analyze-queued') {
      const r = await analyzeQueued(accountId, { budgetMs: REFRESH_BUDGET_MS - (Date.now() - started), log, ids: Array.isArray(body.ids) ? body.ids.filter(validCallId) : null });
      return res.status(200).json({ ok: true, ...r, steps, ms: Date.now() - started });
    }
    if (body.action === 'outcome') {
      if (!validCallId(body.id) || !OUTCOMES.includes(body.outcome)) throw fail('Bad call id or outcome.', 400, 'bad_request');
      const call = await readCall(accountId, body.id);
      if (!call?.analysis) throw fail('That call has no analysis to override.', 404, 'not_found');
      call.analysis.outcome = body.outcome; call.analysis.outcomeOverride = true;
      await writeCall(accountId, call); await upsertIndex(accountId, call);
      return res.status(200).json({ ok: true, id: call.id, outcome: body.outcome });
    }
    if (body.action === 'assign-avatar') {
      if (!validCallId(body.id)) throw fail('Bad call id.', 400, 'bad_request');
      const [call, kb] = await Promise.all([readCall(accountId, body.id), readKb(accountId)]);
      if (!call?.analysis) throw fail('That call has no analysis.', 404, 'not_found');
      const av = kb.avatars.find((a) => a.id === body.avatarId) || null;
      call.analysis.avatar = { ...call.analysis.avatar, id: av?.id || null, name: av?.name || null, confidence: av ? 100 : 0, proposedNew: null, manual: true };
      await writeCall(accountId, call); await upsertIndex(accountId, call);
      return res.status(200).json({ ok: true, id: call.id, avatarId: av?.id || null });
    }
    return res.status(400).json({ ok: false, error: 'bad_request', message: 'Unknown action.' });
  } catch (err) {
    logEvent('calls.error', { accountId, action: req.body?.action || req.method, code: err.code || err.name || 'error', status: err.status || 500 });
    return res.status(err.status || 500).json({ ok: false, error: err.code || err.name || 'error', message: err.message });
  }
}
