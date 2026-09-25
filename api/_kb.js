/**
 * Knowledge base — what the call analysis knows about YOUR business, per
 * account, kept in KV under `aihyros:acct:<id>:kb`:
 *
 *   company        name, industry, markets, offer, pricing (free text)
 *   context        extra entries that help the analysis understand how you sell
 *   leadCriteria   lead grading criteria; points MUST total exactly 100
 *   scorecards     rep scorecards (templates + your own); one is active
 *   avatars        customer avatars the analysis assigns calls to (and proposes)
 *   writeBack      push scores back into HYROS as lead tags / calls (opt-in)
 *   model          optional LLM model override (null = the app default)
 *
 * Nothing here is secret: keys live in api/_integrations.js. Everything is
 * validated on write (validateKb) so a broken KB can never reach the prompt.
 */
import { kvRaw, storeConfigured } from './_store.js';

const kbKey = (accountId) => `aihyros:acct:${accountId}:kb`;

export const OUTCOMES = ['closed', 'follow_up', 'no_show', 'lost', 'unknown'];
export const OUTCOME_LABEL = { closed: 'Closed', follow_up: 'Follow up scheduled', no_show: 'No show', lost: 'Lost', unknown: 'Unknown' };

export const DEFAULT_LEAD_CRITERIA = [
  { id: 'authority', name: 'Authority', points: 15, description: 'Is the prospect the decision-maker? Full points when no partner, board or approval is needed and they control the timeline; zero when someone else decides.' },
  { id: 'desire', name: 'Desire Clarity', points: 20, description: 'How specific and vivid is the outcome they want? Full points for a concrete, measurable goal they state in their own words; low when it is vague ("grow", "do better").' },
  { id: 'pain', name: 'Pain Awareness', points: 20, description: 'Do they name the cost of the problem (money, time, stress) and own it? Full points when they quantify it; low when the rep had to suggest the pain.' },
  { id: 'urgency', name: 'Urgency', points: 15, description: 'Is there a reason to act now (deadline, launch, bleeding cash)? Full points for a hard date or an active loss; zero for "someday".' },
  { id: 'budget', name: 'Budget & Ability', points: 15, description: 'Can they pay? Full points when funds are confirmed or the investment is clearly within reach; zero when price is the whole conversation.' },
  { id: 'fit', name: 'Fit', points: 15, description: 'Are they the customer the offer is built for (business type, stage, mindset)? Full points for a textbook fit; zero when the offer would not work for them.' },
];

export const SCORECARD_TEMPLATES = [
  { id: 'bant', name: 'BANT Qualification', description: 'Budget, Authority, Need, Timeline — did the rep establish all four?', criteria: [
    { id: 'budget', title: 'Budget', description: 'Confirmed the prospect can invest and discussed the number without flinching.', max: 10 },
    { id: 'authority', title: 'Authority', description: 'Identified every decision-maker and what they need to say yes.', max: 10 },
    { id: 'need', title: 'Need', description: 'Uncovered the real problem, its cost, and why it is unsolved today.', max: 10 },
    { id: 'timeline', title: 'Timeline', description: 'Established when they must have this solved and what happens if they do not.', max: 10 },
  ] },
  { id: 'meddic', name: 'MEDDIC', description: 'Metrics, Economic Buyer, Decision Criteria, Decision Process, Identify Pain, Champion.', criteria: [
    { id: 'metrics', title: 'Metrics', description: 'Quantified the outcome the prospect expects (revenue, hours, cost).', max: 10 },
    { id: 'economic-buyer', title: 'Economic Buyer', description: 'Confirmed who controls the money and their view.', max: 10 },
    { id: 'decision-criteria', title: 'Decision Criteria', description: 'Learned how they will judge options and shaped the criteria.', max: 10 },
    { id: 'decision-process', title: 'Decision Process', description: 'Mapped the steps and people between now and a signed deal.', max: 10 },
    { id: 'pain', title: 'Identify Pain', description: 'Surfaced the pain that drives the purchase and its cost of inaction.', max: 10 },
    { id: 'champion', title: 'Champion', description: 'Found or built an internal advocate who sells when the rep is not in the room.', max: 10 },
  ] },
  { id: 'challenger', name: 'Challenger Sale', description: 'Teaching, Tailoring, Taking Control.', criteria: [
    { id: 'teach', title: 'Teaching', description: 'Reframed how the prospect sees their problem with an insight they did not have.', max: 10 },
    { id: 'tailor', title: 'Tailoring', description: 'Connected the message to this person\'s role, business and priorities.', max: 10 },
    { id: 'control', title: 'Taking Control', description: 'Led the conversation, held on price and pushed for a decision respectfully.', max: 10 },
  ] },
  { id: 'high-ticket', name: 'High-Ticket Close', description: 'Discovery, belief work, objection handling, and the close.', criteria: [
    { id: 'discovery', title: 'Discovery Depth', description: 'Asked layered questions until the prospect\'s situation, goal and gap were explicit.', max: 10 },
    { id: 'belief', title: 'Belief Work', description: 'Built belief in the solution, the rep and the prospect\'s own ability to succeed.', max: 10 },
    { id: 'value', title: 'Value Before Price', description: 'Anchored on outcome and cost of inaction before any number was named.', max: 10 },
    { id: 'objections', title: 'Objection Handling', description: 'Isolated, acknowledged and resolved objections instead of discounting or retreating.', max: 10 },
    { id: 'close', title: 'The Close', description: 'Asked for the decision, handled "let me think", and either closed or set a real next step.', max: 10 },
  ] },
];

export const DEFAULT_SCORECARD_ID = 'high-ticket';
export const MAX_AVATARS = 30;
export const MAX_CONTEXT = 30;

export const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'item';
export const newId = (prefix) => `${prefix}_${Math.random().toString(36).slice(2, 10)}`;

const str = (v, max = 4000) => (v === null || v === undefined ? '' : String(v)).slice(0, max);
const int = (v, fallback = 0) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? n : fallback; };

export function defaultKb() {
  return {
    version: 1,
    company: { name: '', industry: '', markets: '', offer: '', pricing: '' },
    context: [],
    leadCriteria: DEFAULT_LEAD_CRITERIA.map((c) => ({ ...c })),
    scorecards: SCORECARD_TEMPLATES.map((s) => ({ ...s, criteria: s.criteria.map((c) => ({ ...c })) })),
    activeScorecardId: DEFAULT_SCORECARD_ID,
    avatars: [],
    writeBack: { enabled: false, tagPrefix: 'ai', createCalls: false },
    model: null,
    updatedAt: null,
  };
}

/** Coerce whatever is stored (or posted) into the KB shape; never throws. */
export function normalizeKb(raw) {
  const d = defaultKb();
  const r = raw && typeof raw === 'object' ? raw : {};
  const company = { ...d.company };
  for (const k of Object.keys(company)) company[k] = str(r.company?.[k], 2000);
  const context = (Array.isArray(r.context) ? r.context : []).slice(0, MAX_CONTEXT)
    .map((e) => ({ id: str(e?.id) || newId('ctx'), title: str(e?.title, 120), body: str(e?.body, 6000) }))
    .filter((e) => e.title || e.body);
  const usedIds = new Set();
  const uniq = (id) => { let out = id; let n = 2; while (usedIds.has(out)) out = `${id}-${n++}`; usedIds.add(out); return out; };
  let leadCriteria = (Array.isArray(r.leadCriteria) ? r.leadCriteria : d.leadCriteria).slice(0, 20)
    .map((c) => ({ id: uniq(slug(c?.id || c?.name)), name: str(c?.name, 80), description: str(c?.description, 1500), points: int(c?.points) }))
    .filter((c) => c.name);
  if (!leadCriteria.length) leadCriteria = d.leadCriteria;
  let scorecards = (Array.isArray(r.scorecards) ? r.scorecards : d.scorecards).slice(0, 12).map((s) => {
    const seen = new Set();
    const cid = (id) => { let out = id; let n = 2; while (seen.has(out)) out = `${id}-${n++}`; seen.add(out); return out; };
    return {
      id: slug(s?.id || s?.name), name: str(s?.name, 80), description: str(s?.description, 1500),
      criteria: (Array.isArray(s?.criteria) ? s.criteria : []).slice(0, 20)
        .map((c) => ({ id: cid(slug(c?.id || c?.title)), title: str(c?.title, 80), description: str(c?.description, 1500), max: int(c?.max, 10) }))
        .filter((c) => c.title),
    };
  }).filter((s) => s.name && s.criteria.length);
  if (!scorecards.length) scorecards = d.scorecards;
  const activeScorecardId = scorecards.some((s) => s.id === r.activeScorecardId) ? r.activeScorecardId : scorecards[0].id;
  const avatars = (Array.isArray(r.avatars) ? r.avatars : []).slice(0, MAX_AVATARS)
    .map((a) => ({ id: str(a?.id) || newId('av'), name: str(a?.name, 80), who: str(a?.who, 300), description: str(a?.description, 2000), callCount: Math.max(0, int(a?.callCount)), createdAt: str(a?.createdAt) || null }))
    .filter((a) => a.name);
  const wb = r.writeBack && typeof r.writeBack === 'object' ? r.writeBack : {};
  const tagPrefix = slug(wb.tagPrefix || 'ai').slice(0, 20) || 'ai';
  return {
    version: 1, company, context, leadCriteria, scorecards, activeScorecardId, avatars,
    writeBack: { enabled: Boolean(wb.enabled), tagPrefix, createCalls: Boolean(wb.createCalls) },
    model: str(r.model, 60) || null,
    updatedAt: str(r.updatedAt) || null,
  };
}

export const leadCriteriaTotal = (kb) => (kb.leadCriteria || []).reduce((s, c) => s + (Number(c.points) || 0), 0);
export const activeScorecard = (kb) => (kb.scorecards || []).find((s) => s.id === kb.activeScorecardId) || kb.scorecards?.[0] || null;

/** Problems that make a KB unusable for scoring (empty = fine). */
export function validateKb(kb) {
  const problems = [];
  const total = leadCriteriaTotal(kb);
  if (total !== 100) problems.push(`Lead grading criteria total ${total} pts — adjust them so they total exactly 100.`);
  for (const c of kb.leadCriteria || []) {
    if (!(c.points >= 1 && c.points <= 100)) problems.push(`Lead criterion "${c.name}": points must be between 1 and 100.`);
    if (!c.description) problems.push(`Lead criterion "${c.name}": describe what the analysis should look for.`);
  }
  for (const s of kb.scorecards || []) {
    for (const c of s.criteria) if (!(c.max >= 1 && c.max <= 100)) problems.push(`Scorecard "${s.name}", "${c.title}": max points must be between 1 and 100.`);
  }
  return problems;
}

export async function readKb(accountId) {
  if (!storeConfigured() || !accountId) return normalizeKb(null);
  const raw = await kvRaw(['GET', kbKey(accountId)]);
  if (!raw) return normalizeKb(null);
  try { return normalizeKb(JSON.parse(raw)); } catch { return normalizeKb(null); }
}

/** Validate then store. Throws { status: 400, code: 'kb_invalid', problems } on a broken KB. */
export async function writeKb(accountId, raw) {
  const kb = normalizeKb(raw);
  const problems = validateKb(kb);
  if (problems.length) throw Object.assign(new Error(problems[0]), { status: 400, code: 'kb_invalid', problems });
  kb.updatedAt = new Date().toISOString();
  const ok = (await kvRaw(['SET', kbKey(accountId), JSON.stringify(kb)])) !== null;
  if (!ok) throw Object.assign(new Error('Could not save the knowledge base (KV write failed or read-only preview).'), { status: 502, code: 'kv' });
  return kb;
}

/** Update part of the KB without a full validate (avatar counters, proposed avatars). */
export async function patchKb(accountId, fn) {
  const kb = await readKb(accountId);
  const next = normalizeKb(fn(kb) || kb);
  next.updatedAt = new Date().toISOString();
  await kvRaw(['SET', kbKey(accountId), JSON.stringify(next)]);
  return next;
}
