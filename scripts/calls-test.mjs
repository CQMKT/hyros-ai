/**
 * Call Intelligence — end-to-end tests against three mocks: an in-memory
 * Upstash-style KV (so api/_store.js runs its real code), the mock MCP
 * (scripts/mock-mcp.mjs) for the attribution join and the write-back, and
 * the mock model API (scripts/mock-llm.mjs) that answers from the schema
 * it is sent. Also a stub Fathom API for connecting an integration.
 *
 *   node scripts/calls-test.mjs
 *
 * Covers: knowledge-base validation (100-point rule), transcript parsing,
 * webhook signature verification (both vendors, known answers), the LLM
 * client's error mapping, schema pinning + clamping, the call store and
 * index cap, the whole analyze pipeline (attribution, avatar proposal,
 * write-back tags), the ingest handler (signed delivery, replay, bad
 * signature), the /api/calls and /api/kb route contracts, the server step,
 * the rollups, and the refresh hand-off (vercel.json, ACCOUNT_SCOPED).
 */
import { createServer } from 'node:http';
import { createHmac, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { startMock, calls as mcpCalls, mock as mcp } from './mock-mcp.mjs';
import { startMockLlm, mock as llm, requests as llmRequests } from './mock-llm.mjs';

let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${extra}`}`);
  if (!ok) failures += 1;
};

/* ---------- an Upstash-shaped KV on localhost ---------- */
const kvStore = new Map();
const globToRe = (g) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
function kvExec(cmd) {
  const [op, ...args] = cmd.map(String);
  switch (op.toUpperCase()) {
    case 'GET': return kvStore.get(args[0]) ?? null;
    case 'SET': {
      const [key, value, ...opts] = args;
      if (opts.includes('NX') && kvStore.has(key)) return null;
      kvStore.set(key, value); return 'OK';
    }
    case 'DEL': { let n = 0; for (const k of args) if (kvStore.delete(k)) n += 1; return n; }
    case 'SCAN': { const m = args.indexOf('MATCH'); const re = m >= 0 ? globToRe(args[m + 1]) : /.*/; return ['0', [...kvStore.keys()].filter((k) => re.test(k))]; }
    default: return null;
  }
}
const kvServer = await new Promise((resolve) => {
  const s = createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    let result = null;
    try { result = kvExec(JSON.parse(body)); } catch { result = null; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ result }));
  });
  s.listen(4324, '127.0.0.1', () => resolve(s));
});

/* ---------- a stub Fathom API (connect + webhook registration + backfill) ---------- */
const FATHOM_SECRET = `whsec_${randomBytes(24).toString('base64')}`;
const fathomServer = await new Promise((resolve) => {
  const s = createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    const reply = (status, payload) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); };
    if (req.headers['x-api-key'] !== 'fathom-key') return reply(401, { message: 'unauthorized' });
    if (req.method === 'POST' && req.url === '/webhooks') return reply(201, { id: 'wh_1', secret: FATHOM_SECRET, ...JSON.parse(body) });
    if (req.method === 'DELETE') return reply(204, {});
    if (req.url.startsWith('/meetings')) return reply(200, { items: req.url.includes('include_transcript=true') ? [fathomMeeting('rec-backfill-1', 'Backfilled call')] : [], next_cursor: null });
    reply(404, {});
  });
  s.listen(4326, '127.0.0.1', () => resolve(s));
});

const fathomMeeting = (id, title) => ({
  recording_id: id, title, meeting_title: title, url: `https://fathom.video/calls/${id}`, share_url: `https://fathom.video/share/${id}`,
  recording_start_time: '2026-09-20T15:00:00Z', recording_end_time: '2026-09-20T15:45:00Z',
  calendar_invitees: [{ name: 'Jay Moreno', email: 'jay@ourco.test', is_external: false }, { name: 'Lead One', email: 'lead1@example.test', is_external: true }],
  recorded_by: { name: 'Jay Moreno', email: 'jay@ourco.test' },
  transcript: [
    { speaker: { display_name: 'Jay Moreno', matched_calendar_invitee_email: 'jay@ourco.test' }, text: 'Thanks for jumping on. What made you book?', timestamp: '00:00:03' },
    { speaker: { display_name: 'Lead One', matched_calendar_invitee_email: 'lead1@example.test' }, text: 'I want a sales manager who owns the process. I love it, this is the best offer I have seen.', timestamp: '00:00:20' },
    { speaker: { display_name: 'Jay Moreno', matched_calendar_invitee_email: 'jay@ourco.test' }, text: 'So what would you need to see to say yes today?', timestamp: '00:30:00' },
  ],
  default_summary: 'Lead One wants a sales manager; follow-up tomorrow.',
});

process.env.KV_REST_API_URL = 'http://127.0.0.1:4324';
process.env.KV_REST_API_TOKEN = 'test-token';
process.env.HYROS_MCP_URL = 'http://127.0.0.1:4325/mcp';
process.env.LLM_API_URL = 'http://127.0.0.1:4323/';
process.env.FATHOM_API_URL = 'http://127.0.0.1:4326';
delete process.env.ACCOUNT_KEY_SECRET; delete process.env.CRON_SECRET; delete process.env.REPORT_PASSWORD; delete process.env.VERCEL_ENV;

const mcpServer = await startMock(4325);
const llmServer = await startMockLlm(4323);

const kb = await import('../api/_kb.js');
const store = await import('../api/_calls.js');
const llmMod = await import('../api/_llm.js');
const analysis = await import('../api/_analysis.js');
const integrations = await import('../api/_integrations.js');
const analyze = await import('../api/_analyze.js');
const setup = await import('../api/_setup.js');
const accounts = await import('../api/_accounts.js');
const rollup = await import('../public/features/calls/rollup.js');
const callsRoute = (await import('../api/calls.js')).default;
const kbRoute = (await import('../api/kb.js')).default;
const integrationsRoute = (await import('../api/integrations.js')).default;
const ingestRoute = (await import('../api/ingest.js')).default;
const { build: buildCallsStep } = await import('../public/features/calls/server.js');

const PASSWORD = 'call-intel-pass';
const fakeRes = () => { const r = { code: 200, body: null, headers: {} }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; r.setHeader = (k, v) => { r.headers[k] = v; }; return r; };
const fakeReq = ({ method = 'GET', url = '/', body = undefined, headers = {} } = {}) => ({ method, url, body, headers: { host: 'test.local', 'x-report-key': PASSWORD, ...headers } });
const streamReq = ({ url, body, headers }) => Object.assign(Readable.from([Buffer.from(body)]), { method: 'POST', url, headers: { host: 'test.local', 'content-type': 'application/json', ...headers } });

try {
  console.log('\nKnowledge base');
  {
    const d = kb.defaultKb();
    check('default KB validates (criteria total 100, templates present)', kb.validateKb(d).length === 0 && d.scorecards.length === 4, kb.validateKb(d).join('; '));
    const broken = kb.normalizeKb({ ...d, leadCriteria: d.leadCriteria.map((c) => ({ ...c, points: 10 })) });
    check('a KB whose criteria total 60 is flagged', /total 60/.test(kb.validateKb(broken)[0] || ''), kb.validateKb(broken).join('; '));
    const n = kb.normalizeKb({ company: { name: 'X' }, leadCriteria: [{ name: 'Only One', description: 'd', points: '100' }], scorecards: [{ name: 'Mine', criteria: [{ title: 'A', max: '5' }] }], avatars: [{ name: 'Av', who: 'w' }], writeBack: { enabled: 'yes', tagPrefix: 'My Prefix!' } });
    check('normalizeKb coerces numbers, slugs ids and prefixes', n.leadCriteria[0].points === 100 && n.leadCriteria[0].id === 'only-one' && n.scorecards[0].criteria[0].max === 5 && n.writeBack.tagPrefix === 'my-prefix' && n.writeBack.enabled === true, JSON.stringify(n.writeBack));
    let rejected = null;
    try { await kb.writeKb('acc_000000000000', broken); } catch (err) { rejected = err; }
    check('writeKb refuses a KB that does not total 100 (400 kb_invalid)', rejected?.status === 400 && rejected?.code === 'kb_invalid' && rejected.problems?.length > 0);
  }

  console.log('\nTranscript parsing');
  {
    const lines = store.parsePastedTranscript('[00:12:03] Jay: hello there\n12:30 Bram: hi\nJay (13:05): ok\nBram: plain\ncontinued line\n');
    check('four common line shapes parse into utterances', lines.length === 4 && lines[0].t === 723 && lines[1].t === 750 && lines[2].t === 785 && lines[3].text === 'plain continued line', JSON.stringify(lines));
    check('durationOf takes the last timestamp', store.durationOf(lines) === 785);
    const c = store.newCall({ source: 'paste', title: 'T', transcript: lines, attendees: [{ name: 'B', email: 'B@X.test', external: true }] });
    check('newCall lower-cases emails and derives duration', c.attendees[0].email === 'b@x.test' && c.durationS === 785 && c.status === 'queued' && /^c_[0-9a-f]{12}$/.test(c.id));
    check('callIdFor is stable per source + external id', store.callIdFor('fathom', '123') === store.callIdFor('fathom', '123') && store.callIdFor('fathom', '123') !== store.callIdFor('fireflies', '123'));
    const many = Array.from({ length: 305 }, (_, i) => ({ id: `c_${String(i).padStart(12, '0')}`, date: new Date(Date.UTC(2026, 0, 1) + i * 3600000).toISOString() }));
    const capped = store.capIndex(many);
    check('capIndex keeps the newest 300 and counts the dropped', capped.rows.length === 300 && capped.dropped === 5 && capped.rows[0].id === many[304].id);
  }

  console.log('\nWebhook signatures');
  {
    const body = '{"recording_id":"rec-1","title":"x"}';
    const id = 'msg_1'; const ts = String(Math.floor(Date.now() / 1000));
    const sig = createHmac('sha256', Buffer.from(FATHOM_SECRET.slice(6), 'base64')).update(`${id}.${ts}.${body}`).digest('base64');
    check('Fathom: a correctly signed delivery verifies', integrations.verifyFathom({ 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': `v1,${sig}` }, body, FATHOM_SECRET).ok);
    check('Fathom: a tampered body is refused', !integrations.verifyFathom({ 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': `v1,${sig}` }, `${body} `, FATHOM_SECRET).ok);
    check('Fathom: a stale timestamp is refused', /tolerance/.test(integrations.verifyFathom({ 'webhook-id': id, 'webhook-timestamp': String(Number(ts) - 900), 'webhook-signature': `v1,${sig}` }, body, FATHOM_SECRET).reason));
    const ff = createHmac('sha256', 'ffsecret').update(body).digest('hex');
    check('Fireflies: hex HMAC verifies (with or without sha256= prefix)', integrations.verifyFireflies({ 'x-hub-signature': ff }, body, 'ffsecret').ok && integrations.verifyFireflies({ 'x-hub-signature': `sha256=${ff}` }, body, 'ffsecret').ok);
    check('Fireflies: wrong secret is refused', !integrations.verifyFireflies({ 'x-hub-signature': ff }, body, 'other').ok);
  }

  console.log('\nModel client');
  {
    check('probeKey accepts a working key', (await llmMod.probeKey('llm-key-0001')).ok);
    let e = null; try { await llmMod.probeKey('dead-llm-key'); } catch (err) { e = err; }
    check('a rejected key is llm_auth', e?.code === 'llm_auth', e?.message);
    llm.refuseNext = true; e = null; try { await llmMod.complete({ apiKey: 'llm-key-0001', user: 'x', schema: { type: 'object', additionalProperties: false, required: ['a'], properties: { a: { type: 'string' } } } }); } catch (err) { e = err; }
    check('a refusal is llm_refusal', e?.code === 'llm_refusal', e?.message);
    llm.truncateNext = true; e = null; try { await llmMod.complete({ apiKey: 'llm-key-0001', user: 'x', schema: { type: 'object', additionalProperties: false, required: ['a'], properties: { a: { type: 'string' } } } }); } catch (err) { e = err; }
    check('max_tokens is llm_truncated', e?.code === 'llm_truncated', e?.message);
    llm.failNext = { status: 429 }; e = null; try { await llmMod.complete({ apiKey: 'llm-key-0001', user: 'x' }); } catch (err) { e = err; }
    check('HTTP 429 is llm_rate_limited', e?.code === 'llm_rate_limited');
    const r = await llmMod.complete({ apiKey: 'llm-key-0001', user: 'x', schema: { type: 'object', additionalProperties: false, required: ['a'], properties: { a: { type: 'string', enum: ['yes', 'no'] } } } });
    const last = llmRequests[llmRequests.length - 1].body;
    check('structured requests carry output_config.format + adaptive thinking and parse to json', r.json?.a === 'yes' && last.output_config?.format?.type === 'json_schema' && last.thinking?.type === 'adaptive' && last.model === llmMod.DEFAULT_MODEL, JSON.stringify(last.output_config));
  }

  console.log('\nAnalysis schema + normalisation');
  {
    const d = kb.defaultKb();
    const schema = analysis.analysisSchema(d);
    check('criteria and scorecard ids are pinned as enums', JSON.stringify(schema.properties.leadQuality.properties.factors.items.properties.id.enum) === JSON.stringify(d.leadCriteria.map((c) => c.id)) && schema.properties.repScorecard.properties.criteria.items.properties.id.enum.includes('discovery'));
    check('avatar.existingId is null-only when no avatars exist', schema.properties.avatar.properties.existingId.type === 'null');
    const norm = analysis.normalizeAnalysis({ outcome: 'closed', leadQuality: { factors: [{ id: 'authority', points: 99, evidence: 'e' }, { id: 'nope', points: 50 }], closeProbability: 400 }, repScorecard: { criteria: [{ id: 'discovery', points: -3 }] }, buyingLanguage: { temperature: 'boiling', signals: [] }, avatar: { existingId: 'ghost', confidence: 50, proposedNew: { name: 'New Type', who: 'w', description: 'd' } } }, d);
    check('points are clamped to the criterion max, unknown ids dropped, score re-derived', norm.leadQuality.score === 15 && norm.leadQuality.factors.length === d.leadCriteria.length && norm.repScorecard.criteria[0].points === 0 && norm.leadQuality.closeProbability === 100, JSON.stringify(norm.leadQuality.score));
    check('unknown temperature / avatar id fall back; a proposed avatar survives', norm.buyingLanguage.temperature === 'warm' && norm.avatar.id === null && norm.avatar.proposedNew?.name === 'New Type');
    const seg = analysis.segments('a\n'.repeat(50000), 20000);
    check('segments split at line boundaries', seg.length === 5 && seg.every((s) => s.length <= 20000));
    check('scoreLabel bands', analysis.scoreLabel(88) === 'Exceptional' && analysis.scoreLabel(70) === 'Strong' && analysis.scoreLabel(50) === 'Moderate' && analysis.scoreLabel(49) === 'Weak');
  }

  console.log('\nStore + pipeline (in-memory KV, mock MCP, mock model)');
  const state = await setup.setPassword(PASSWORD);
  check('setup: password stored, KV configured', state.state === 'ready' && state.storage);
  const added = await accounts.addAccount('mock-key-0001');
  const accountId = added.account.id;
  check('a HYROS account is registered against the mock MCP', /^acc_/.test(accountId));
  {
    const c = store.newCall({ source: 'paste', title: 'Paste 1', transcript: store.parsePastedTranscript('Jay: hi\nLead: hello, I love it'), attendees: [{ name: 'Lead One', email: 'lead1@example.test', external: true }] });
    const saved = await store.saveNewCall(accountId, c);
    const idx = await store.readIndex(accountId);
    check('saveNewCall stores the call and indexes it as queued', !saved.duplicate && idx.rows.length === 1 && idx.rows[0].status === 'queued' && idx.rows[0].leadEmail === 'lead1@example.test');
    check('saving the same id again is a duplicate', (await store.saveNewCall(accountId, c)).duplicate === true);

    // No model key yet: the analysis fails honestly.
    const noKey = await analyze.analyzeCall(accountId, c.id);
    check('without a model key the call is marked error with a helpful message', noKey.status === 'error' && /Anthropic API key/.test(noKey.error));

    const it = await integrations.addIntegration(accountId, { kind: 'anthropic', apiKey: 'llm-key-0001', origin: 'https://test.local' });
    check('the model key is probed, encrypted and listed without key material', it.kind === 'anthropic' && it.keyEnc && !JSON.stringify(integrations.publicIntegration(it)).includes('llm-key-0001'));

    llm.answer = { participants: { rep: 'Jay', prospect: 'Lead One', prospectEmail: 'lead1@example.test', company: null }, outcome: 'follow_up',
      leadQuality: { factors: [{ id: 'authority', points: 15, evidence: 'full decision-maker' }, { id: 'desire', points: 18, evidence: 'clear' }], closeProbability: 78, pattern: null },
      buyingLanguage: { temperature: 'hot', mindset: 'Buyer', signals: [{ quote: 'I love it', kind: 'commitment', note: 'strong' }] },
      avatar: { existingId: null, confidence: 90, proposedNew: { name: 'The Burnt-Out Scaler', who: 'coach', description: 'maxed out' } } };
    const done = await analyze.analyzeCall(accountId, c.id, { force: true });
    check('the pipeline produces a done call with a re-derived score', done.status === 'done' && done.analysis.leadQuality.score === 33 && done.analysis.leadQuality.label === 'Weak' && done.analysis.buyingLanguage.temperature === 'hot', JSON.stringify({ status: done.status, error: done.error, score: done.analysis?.leadQuality?.score }));
    check('attribution joined the prospect to the HYROS lead (first source, stage)', done.attribution?.matched && done.attribution.firstSource?.name === 'Prospecting Broad' && done.attribution.stage === 'Lead', JSON.stringify(done.attribution));
    check('hyros_get_leads was called with the prospect email under { request }', mcpCalls.some((x) => x.name === 'hyros_get_leads' && x.args?.request?.emails?.[0] === 'lead1@example.test'));
    const kbNow = await kb.readKb(accountId);
    check('the proposed avatar was added to the KB and assigned to the call', kbNow.avatars.length === 1 && kbNow.avatars[0].name === 'The Burnt-Out Scaler' && done.analysis.avatar.id === kbNow.avatars[0].id && kbNow.avatars[0].callCount === 1);
    check('write-back is off by default (nothing pushed)', done.writeBack === null && !mcpCalls.some((x) => x.name === 'hyros_add_tags_to_leads'));
    const row = (await store.readIndex(accountId)).rows[0];
    check('the index row carries score, temperature, avatar and attribution', row.status === 'done' && row.leadScore === 33 && row.temperature === 'hot' && row.avatarName === 'The Burnt-Out Scaler' && row.attribution?.firstSource === 'Prospecting Broad');

    // Write-back on: tags and (experimental) call record go to HYROS.
    await kb.writeKb(accountId, { ...kbNow, writeBack: { enabled: true, tagPrefix: 'ai', createCalls: true } });
    llm.answer.avatar = { existingId: kbNow.avatars[0].id, confidence: 95, proposedNew: null };
    const again = await analyze.analyzeCall(accountId, c.id, { force: true });
    const tagCall = mcpCalls.find((x) => x.name === 'hyros_add_tags_to_leads');
    check('write-back adds score/temperature/outcome/avatar tags to the matched lead', again.writeBack?.ok === true && tagCall?.args?.request?.emails?.[0] === 'lead1@example.test' && again.writeBack.tags.includes('ai-score-33') && again.writeBack.tags.includes('ai-hot') && again.writeBack.tags.includes('ai-follow-up') && again.writeBack.tags.some((t) => t.startsWith('ai-avatar-')), JSON.stringify(again.writeBack));
    check('write-back logs the call in HYROS when enabled', mcpCalls.some((x) => x.name === 'hyros_create_call' && x.args?.request?.status === 'QUALIFIED') && again.writeBack.call?.requestId === 'req-call-1');
    check('an existing avatar is bumped, not duplicated', (await kb.readKb(accountId)).avatars.length === 1 && (await kb.readKb(accountId)).avatars[0].callCount === 2);
    await kb.writeKb(accountId, { ...(await kb.readKb(accountId)), writeBack: { enabled: false, tagPrefix: 'ai', createCalls: false } });

    // Attribution failure is recorded, never fatal.
    mcp.failNext({ tool: 'hyros_get_leads', status: 500, body: 'boom' });
    const c2 = store.newCall({ source: 'paste', title: 'Paste 2', transcript: store.parsePastedTranscript('Jay: hi\nLead: hmm'), attendees: [{ email: 'lead2@example.test', external: true }] });
    await store.saveNewCall(accountId, c2);
    const r2 = await analyze.analyzeCall(accountId, c2.id);
    check('a failed HYROS lookup lands on the call as attribution.error; the analysis still completes', r2.status === 'done' && r2.attribution?.matched === false && Boolean(r2.attribution.error), JSON.stringify(r2.attribution));
    mcp.reset();

    // A model failure marks the call error with the code's message.
    llm.failNext = { status: 529 };
    const c3 = store.newCall({ source: 'paste', title: 'Paste 3', transcript: store.parsePastedTranscript('Jay: hi\nLead: hmm') });
    await store.saveNewCall(accountId, c3);
    const r3 = await analyze.analyzeCall(accountId, c3.id);
    check('a model outage marks the call as error (retryable later)', r3.status === 'error' && /injected 529/.test(r3.error), r3.error);
    const q = await analyze.analyzeQueued(accountId, { budgetMs: 1000 });
    check('analyzeQueued skips everything when the budget cannot fit one analysis', q.processed === 0);
    await store.deleteCall(accountId, c3.id);
    check('deleteCall removes the record and its index row', (await store.readCall(accountId, c3.id)) === null && !(await store.readIndex(accountId)).rows.some((r) => r.id === c3.id));
  }

  console.log('\nRoutes: /api/calls, /api/kb, /api/integrations');
  {
    let res = fakeRes(); await callsRoute(fakeReq({ url: `/api/calls?account=${accountId}` }), res);
    check('GET /api/calls answers the index with avatars and connection status', res.code === 200 && res.body.rows.length === 2 && res.body.avatars.length === 1 && res.body.connected.anthropic === true && !JSON.stringify(res.body).includes('llm-key-0001'), JSON.stringify(res.body).slice(0, 200));
    res = fakeRes(); await callsRoute(fakeReq({ url: `/api/calls?account=${accountId}`, headers: { 'x-report-key': 'wrong' } }), res);
    check('GET /api/calls without the password is 401', res.code === 401);
    res = fakeRes(); await callsRoute(fakeReq({ method: 'POST', url: `/api/calls?account=${accountId}`, body: { action: 'paste', title: 'Route paste', transcript: 'Jay: hi\nLead: I am ready', analyze: false } }), res);
    const pasted = res.body;
    check('POST paste (analyze:false) stores a queued call', res.code === 200 && pasted.ok && pasted.status === 'queued', JSON.stringify(pasted));
    res = fakeRes(); await callsRoute(fakeReq({ url: `/api/calls?account=${accountId}&id=${pasted.id}` }), res);
    check('GET /api/calls?id= returns the call without the vendor raw payload', res.code === 200 && res.body.call.id === pasted.id && !('raw' in res.body.call));
    res = fakeRes(); await callsRoute(fakeReq({ method: 'POST', url: `/api/calls?account=${accountId}`, body: { action: 'analyze-queued' } }), res);
    check('POST analyze-queued processes the queued call', res.code === 200 && res.body.processed === 1 && res.body.results[0].status === 'done', JSON.stringify(res.body.results));
    res = fakeRes(); await callsRoute(fakeReq({ method: 'POST', url: `/api/calls?account=${accountId}`, body: { action: 'outcome', id: pasted.id, outcome: 'closed' } }), res);
    check('POST outcome overrides the outcome', res.code === 200 && (await store.readIndex(accountId)).rows.find((r) => r.id === pasted.id)?.outcome === 'closed');
    res = fakeRes(); await callsRoute(fakeReq({ method: 'POST', url: `/api/calls?account=${accountId}`, body: { action: 'paste', transcript: 'one line only' } }), res);
    check('POST paste with a one-line transcript is a 400', res.code === 400);
    res = fakeRes(); await callsRoute(fakeReq({ method: 'DELETE', url: `/api/calls?account=${accountId}&id=${pasted.id}` }), res);
    check('DELETE removes the call', res.code === 200 && res.body.ok);

    res = fakeRes(); await kbRoute(fakeReq({ url: `/api/kb?account=${accountId}` }), res);
    check('GET /api/kb returns the KB, templates and no problems', res.code === 200 && res.body.kb.leadCriteria.length === 6 && res.body.templates.length === 4 && res.body.problems.length === 0);
    const kbFromGet = res.body.kb;
    res = fakeRes(); await kbRoute(fakeReq({ method: 'POST', url: `/api/kb?account=${accountId}`, body: { kb: { ...kbFromGet, leadCriteria: [{ id: 'a', name: 'A', description: 'd', points: 40 }] } } }), res);
    check('POST /api/kb rejects criteria that do not total 100 with problems[]', res.code === 400 && res.body.problems?.length > 0, JSON.stringify(res.body));

    res = fakeRes(); await integrationsRoute(fakeReq({ method: 'POST', url: `/api/integrations?account=${accountId}`, body: { kind: 'fathom', apiKey: 'fathom-key' } }), res);
    check('connecting Fathom probes the key, registers the webhook and returns the webhook URL', res.code === 200 && res.body.item.webhookRegistered && /\/api\/ingest\?src=fathom&t=[0-9a-f]{32}$/.test(res.body.item.webhookUrl), JSON.stringify(res.body));
    const webhookUrl = res.body.item.webhookUrl;
    res = fakeRes(); await integrationsRoute(fakeReq({ method: 'POST', url: `/api/integrations?account=${accountId}`, body: { kind: 'fathom', apiKey: 'bad' } }), res);
    check('a rejected vendor key is a 400 bad_key', res.code === 400 && res.body.error === 'bad_key');
    res = fakeRes(); await integrationsRoute(fakeReq({ url: `/api/integrations?account=${accountId}` }), res);
    check('GET /api/integrations lists both without secrets', res.code === 200 && res.body.items.length === 2 && !JSON.stringify(res.body.items).includes('fathom-key') && !JSON.stringify(res.body.items).includes(FATHOM_SECRET));
    res = fakeRes(); await integrationsRoute(fakeReq({ method: 'POST', url: `/api/integrations?account=${accountId}`, body: { action: 'backfill', kind: 'fathom', days: 30 } }), res);
    check('backfill queues the vendor\'s recent meetings', res.code === 200 && res.body.added === 1 && (await store.readIndex(accountId)).rows.some((r) => r.title === 'Backfilled call' && r.status === 'queued'), JSON.stringify(res.body));

    console.log('\nIngest (webhook)');
    const t = new URL(webhookUrl).searchParams.get('t');
    const meeting = fathomMeeting('rec-live-1', 'Live webhook call');
    const body = JSON.stringify(meeting);
    const sign = (b, ts = Math.floor(Date.now() / 1000)) => ({ 'webhook-id': 'msg_x', 'webhook-timestamp': String(ts), 'webhook-signature': `v1,${createHmac('sha256', Buffer.from(FATHOM_SECRET.slice(6), 'base64')).update(`msg_x.${ts}.${b}`).digest('base64')}` });
    llm.answer = { participants: { rep: 'Jay Moreno', prospect: 'Lead One', prospectEmail: null, company: null }, outcome: 'follow_up', leadQuality: { factors: [{ id: 'authority', points: 15, evidence: 'e' }], closeProbability: 70, pattern: null }, avatar: { existingId: null, confidence: 10, proposedNew: null } };
    res = fakeRes(); await ingestRoute(streamReq({ url: `/api/ingest?src=fathom&t=${t}`, body, headers: sign(body) }), res);
    check('a signed Fathom delivery is stored and analyzed inline (no waitUntil locally)', res.code === 200 && res.body.ok && res.body.status === 'done', JSON.stringify(res.body));
    const live = (await store.readIndex(accountId)).rows.find((r) => r.title === 'Live webhook call');
    check('the webhook call joined its external attendee to HYROS', live?.status === 'done' && live.leadEmail === 'lead1@example.test' && live.attribution?.firstSource === 'Prospecting Broad' && live.source === 'fathom', JSON.stringify(live));
    res = fakeRes(); await ingestRoute(streamReq({ url: `/api/ingest?src=fathom&t=${t}`, body, headers: sign(body) }), res);
    check('a redelivery is acknowledged as a duplicate, not re-analyzed', res.code === 200 && res.body.duplicate === true);
    res = fakeRes(); await ingestRoute(streamReq({ url: `/api/ingest?src=fathom&t=${t}`, body, headers: { ...sign(body), 'webhook-signature': 'v1,AAAA' } }), res);
    check('a bad signature is refused with 401', res.code === 401 && res.body.error === 'bad_signature');
    res = fakeRes(); await ingestRoute(streamReq({ url: `/api/ingest?src=fathom&t=${'0'.repeat(32)}`, body, headers: sign(body) }), res);
    check('an unknown token is a 404', res.code === 404);
    const noTranscript = JSON.stringify({ ...meeting, recording_id: 'rec-2', transcript: [] });
    res = fakeRes(); await ingestRoute(streamReq({ url: `/api/ingest?src=fathom&t=${t}`, body: noTranscript, headers: sign(noTranscript) }), res);
    check('a delivery without a transcript is acknowledged and ignored with advice', res.code === 200 && /no transcript/.test(res.body.ignored));

    res = fakeRes(); await integrationsRoute(fakeReq({ method: 'DELETE', url: `/api/integrations?account=${accountId}&id=${(await integrations.readIntegrations(accountId)).find((i) => i.kind === 'fathom').id}` }), res);
    check('disconnecting Fathom removes it and its token', res.code === 200 && (await integrations.findByToken(t)) === null);
  }

  console.log('\nServer step, rollups, refresh hand-off');
  {
    const idx = await store.readIndex(accountId);
    const blk = await buildCallsStep({ snapshot: { callIntel: { ...idx, avatars: [{ id: 'a', name: 'A' }] } }, previous: null, timeLeft: () => 5000, now: new Date('2026-09-25T10:00:00Z') });
    check('server.js copies the index handed in as snapshot.callIntel', blk.rows.length === idx.rows.length && blk.avatars.length === 1 && blk.built === '2026-09-25T10:00:00.000Z');
    const prev = await buildCallsStep({ snapshot: {}, previous: { rows: [{ id: 'x' }], stale: true, skipped: 'time budget' }, timeLeft: () => 5000, now: new Date() });
    check('without an index the step keeps the previous rows (markers stripped)', prev.rows.length === 1 && !('stale' in prev));
    const rows = [
      { status: 'done', leadScore: 80, repScore: 40, repMax: 50, temperature: 'hot', outcome: 'closed', attribution: { firstSource: 'A' }, rep: 'R1', painPoints: ['x'] },
      { status: 'done', leadScore: 60, repScore: 20, repMax: 50, temperature: 'warm', outcome: 'lost', attribution: { firstSource: 'A' }, rep: 'R1', painPoints: ['x'] },
      { status: 'done', leadScore: 40, repScore: 10, repMax: 50, temperature: 'cold', outcome: 'follow_up', attribution: null, rep: 'R2', painPoints: ['y'] },
      { status: 'queued' },
    ];
    const k = rollup.kpis(rows);
    check('kpis: ratios re-derived from counts (close rate 1/3, hot 1/3, avg lead 60)', k.analyzed === 3 && k.queued === 1 && Math.round(k.closeRate * 100) === 33 && Math.round(k.hotShare * 100) === 33 && k.avgLead === 60 && k.attributed === 2, JSON.stringify(k));
    const src = rollup.bySource(rows);
    check('bySource groups matched calls only', src.length === 1 && src[0].key === 'A' && src[0].calls === 2 && src[0].closeRate === 0.5);
    check('topItems counts case-insensitively', rollup.topItems([['X'], ['x'], ['y']])[0].n === 2);

    const vercelJson = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
    check('vercel.json gives calls/ingest 300 s and bundles public/features/**', vercelJson.functions['api/calls.js']?.maxDuration === 300 && vercelJson.functions['api/ingest.js']?.maxDuration === 300 && vercelJson.functions['api/calls.js'].includeFiles === 'public/features/**');
    const appJs = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
    check('app.js scopes /api/calls, /api/kb and /api/integrations to the selected account', /ACCOUNT_SCOPED = new Set\(\[[^\]]*'\/api\/calls'[^\]]*'\/api\/kb'[^\]]*'\/api\/integrations'/.test(appJs));
    const snapSrc = await readFile(new URL('../api/_snapshot.js', import.meta.url), 'utf8');
    check('buildSnapshot accepts callIntel and exposes it to feature steps', /callIntel = null/.test(snapSrc) && /warnings, callIntel, (payIntel, )?account/.test(snapSrc));
    check('removing an account deletes its calls, KB and integrations', await (async () => { await accounts.removeAccount(accountId); return [...kvStore.keys()].every((key) => !key.includes(`:${accountId}:`)); })(), [...kvStore.keys()].filter((key) => key.includes(accountId)).join(', '));
  }
} finally {
  kvServer.close(); fathomServer.close(); mcpServer.close(); llmServer.close();
}

console.log(failures ? `\n${failures} call-intelligence check(s) failed.` : '\nAll call-intelligence checks passed.');
process.exit(failures ? 1 : 0);
