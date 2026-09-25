/**
 * Call analysis — turns one transcript plus the account's knowledge base
 * into the structured analysis the Call Intelligence tab renders:
 *
 *   summary         overview, verdict, what the rep did well, what cost the close, next steps
 *   outcome         closed | follow_up | no_show | lost | unknown
 *   leadQuality     0–100 against the KB's lead grading criteria (points per criterion + evidence)
 *   repScorecard    points per criterion of the active scorecard + coaching
 *   buyingLanguage  hot | warm | cold, mindset, verbatim signals
 *   objections      each objection, whether/how it was handled, what would have been better
 *   prospect        demographics, psychographics, pain points, desires, verbatim language
 *   avatar          the existing avatar this call fits, or a proposed new one
 *
 * The prompt is built from the KB (api/_kb.js) so criteria and scorecards
 * are the user's own; the JSON schema pins every id to the KB so the model
 * cannot invent a criterion. Points are clamped and totals re-derived here,
 * never trusted from the model. Long transcripts are condensed in segments
 * first (each segment keeps its verbatim key quotes), never cut.
 */
import { complete } from './_llm.js';
import { OUTCOMES, activeScorecard, leadCriteriaTotal } from './_kb.js';

export const MAX_DIRECT_CHARS = 120000;   // one pass up to here (~30k tokens of transcript)
export const SEGMENT_CHARS = 80000;       // condensation segment size above that
const MAX_QUOTE = 240;

const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });
const obj = (properties) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const arr = (items) => ({ type: 'array', items });
const s = { type: 'string' };
const i = { type: 'integer' };
const b = { type: 'boolean' };
const en = (values) => ({ type: 'string', enum: values });

/** The structured-output schema, pinned to this KB's criteria, scorecard and avatars. */
export function analysisSchema(kb) {
  const criteriaIds = kb.leadCriteria.map((c) => c.id);
  const card = activeScorecard(kb);
  const cardIds = card ? card.criteria.map((c) => c.id) : ['overall'];
  const avatarIds = kb.avatars.map((a) => a.id);
  return obj({
    participants: obj({ rep: s, prospect: s, prospectEmail: nullable(s), company: nullable(s) }),
    summary: obj({
      overview: s,
      verdict: s,
      didWell: arr(obj({ title: s, detail: s })),
      costTheClose: arr(obj({ title: s, detail: s })),
      nextSteps: arr(s),
    }),
    outcome: en(OUTCOMES),
    outcomeEvidence: s,
    leadQuality: obj({
      factors: arr(obj({ id: en(criteriaIds), points: i, evidence: s })),
      rationale: s,
      closeProbability: i,
      pattern: nullable(obj({ name: s, implication: s })),
    }),
    repScorecard: obj({
      criteria: arr(obj({ id: en(cardIds), points: i, evidence: s, coaching: s })),
      summary: s,
    }),
    buyingLanguage: obj({
      temperature: en(['hot', 'warm', 'cold']),
      mindset: s,
      signals: arr(obj({ quote: s, kind: en(['commitment', 'ownership', 'internal_locus', 'urgency', 'hesitation', 'price', 'authority', 'skepticism', 'other']), note: s })),
    }),
    objections: arr(obj({ objection: s, handled: b, howHandled: s, better: s })),
    prospect: obj({
      demographics: obj({ role: s, businessType: s, ageRange: s, location: s, revenueRange: s }),
      psychographics: arr(s),
      painPoints: arr(s),
      desires: arr(s),
      language: arr(s),
    }),
    avatar: obj({
      existingId: avatarIds.length ? nullable(en(avatarIds)) : { type: 'null' },
      confidence: i,
      proposedNew: nullable(obj({ name: s, who: s, description: s })),
    }),
  });
}

const CONDENSE_SCHEMA = obj({
  notes: s,
  quotes: arr(obj({ t: s, speaker: s, text: s })),
});

export const mmss = (sec) => {
  if (!Number.isFinite(sec)) return '--:--';
  const m = Math.floor(sec / 60); const r = Math.floor(sec % 60);
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
};

/** The transcript as the model sees it: one line per utterance, timestamped when known. */
export function transcriptText(lines) {
  return (lines || []).map((l) => `[${mmss(l.t)}] ${l.speaker || 'Unknown'}: ${l.text}`).join('\n');
}

function section(title, body) { return body ? `\n## ${title}\n${body}\n` : ''; }

/** The system prompt: who we are, what to look for, and the exact rubric. */
export function systemPrompt(kb) {
  const co = kb.company || {};
  const card = activeScorecard(kb);
  const company = [
    co.name && `Company: ${co.name}`, co.industry && `Industry: ${co.industry}`, co.markets && `Markets: ${co.markets}`,
    co.offer && `Offer: ${co.offer}`, co.pricing && `Pricing: ${co.pricing}`,
  ].filter(Boolean).join('\n');
  const context = (kb.context || []).map((c) => `### ${c.title}\n${c.body}`).join('\n\n');
  const criteria = kb.leadCriteria.map((c) => `- ${c.id} — ${c.name} (0–${c.points} pts): ${c.description}`).join('\n');
  const scorecard = card ? `${card.name}${card.description ? ` — ${card.description}` : ''}\n${card.criteria.map((c) => `- ${c.id} — ${c.title} (0–${c.max} pts): ${c.description}`).join('\n')}` : '';
  const avatars = kb.avatars.length
    ? kb.avatars.map((a) => `- ${a.id} — ${a.name}: ${a.who}${a.description ? ` — ${a.description}` : ''}`).join('\n')
    : '(none yet — propose one when the prospect represents a recognisable customer type)';
  return `You are a senior sales analyst reviewing a recorded sales call for the company described below. You read the whole transcript, then produce a rigorous, evidence-backed analysis a sales leader can act on. Be direct and specific. Quote the transcript verbatim (with the [mm:ss] timestamp) whenever you make a claim about what someone said. Never invent facts that are not in the transcript; when something was not discussed, say so and score it accordingly.
${section('Company', company)}${section('How we sell (context from the team)', context)}
## Lead grading criteria (points total ${leadCriteriaTotal(kb)})
Score the PROSPECT, not the rep. Award points per criterion within its range, citing evidence.
${criteria}

## Rep scorecard: ${scorecard || 'overall (0–10)'}
Score the REP's performance per criterion within its range, cite evidence, and give one concrete coaching note per criterion.

## Outcome
closed = a purchase or signed commitment happened on the call · follow_up = a concrete next step or decision date was agreed · no_show = the prospect did not attend · lost = the prospect declined · unknown = none of these is clear.

## Buying language
temperature: hot = ready to buy, only logistics remain · warm = interested, real hesitation remains · cold = low intent or a poor fit. Signals are verbatim quotes classified by kind.

## Prospect intelligence
Demographics (role, business type, age range, location, revenue range — "unknown" when not stated), psychographics (beliefs, identity, motivations), pain points and desires in their own words, and up to 8 verbatim phrases that show how this person talks about their situation.

## Avatars
Existing avatars:
${avatars}
Pick the existing avatar this prospect matches (existingId) with a confidence 0–100, or set existingId to null and propose a new one (name, who, description) when none fits. Do not propose a new avatar when an existing one fits at 60+ confidence.

Output only the JSON the schema asks for.`;
}

/** The user turn: attendees + the transcript (or its condensed segments). */
export function userPrompt(call, body, { condensed = false } = {}) {
  const who = (call.attendees || []).map((a) => `${a.name || '?'}${a.email ? ` <${a.email}>` : ''}${a.external ? ' (external)' : ''}`).join(', ');
  const head = [
    `Call: ${call.title || 'untitled'}`,
    call.date ? `Date: ${call.date}` : null,
    call.durationS ? `Duration: ${mmss(call.durationS)}` : null,
    who ? `Attendees: ${who}` : null,
    call.recordedBy?.name ? `Recorded by: ${call.recordedBy.name}${call.recordedBy.email ? ` <${call.recordedBy.email}>` : ''} (usually the rep)` : null,
    call.vendorSummary ? `Note-taker summary: ${String(call.vendorSummary).slice(0, 4000)}` : null,
  ].filter(Boolean).join('\n');
  return `${head}\n\n${condensed ? '# Condensed transcript (segments with verbatim key quotes)' : '# Transcript'}\n${body}`;
}

/** Split the transcript text into segments of about SEGMENT_CHARS at line boundaries. */
export function segments(text, size = SEGMENT_CHARS) {
  const out = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if (cur.length + line.length + 1 > size && cur) { out.push(cur); cur = ''; }
    cur += (cur ? '\n' : '') + line;
  }
  if (cur) out.push(cur);
  return out;
}

const clampInt = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(v)) || 0));
const trim = (v, n = 600) => String(v ?? '').slice(0, n);
const list = (v, n, len = 400) => (Array.isArray(v) ? v : []).slice(0, n).map((x) => trim(x, len)).filter(Boolean);

export const scoreLabel = (score) => (score >= 85 ? 'Exceptional' : score >= 70 ? 'Strong' : score >= 50 ? 'Moderate' : 'Weak');

/** Clamp, re-derive totals and pin every id to the KB. The model's arithmetic is never trusted. */
export function normalizeAnalysis(raw, kb) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const byId = new Map((Array.isArray(r.leadQuality?.factors) ? r.leadQuality.factors : []).map((f) => [f?.id, f]));
  const factors = kb.leadCriteria.map((c) => {
    const f = byId.get(c.id);
    return { id: c.id, name: c.name, max: c.points, points: f ? clampInt(f.points, 0, c.points) : 0, evidence: f ? trim(f.evidence) : 'Not assessed.' };
  });
  const score = factors.reduce((sum, f) => sum + f.points, 0);
  const card = activeScorecard(kb);
  const cardBy = new Map((Array.isArray(r.repScorecard?.criteria) ? r.repScorecard.criteria : []).map((c) => [c?.id, c]));
  const criteria = (card ? card.criteria : [{ id: 'overall', title: 'Overall', max: 10 }]).map((c) => {
    const x = cardBy.get(c.id);
    return { id: c.id, title: c.title, max: c.max, points: x ? clampInt(x.points, 0, c.max) : 0, evidence: x ? trim(x.evidence) : 'Not assessed.', coaching: x ? trim(x.coaching) : '' };
  });
  const repTotal = criteria.reduce((sum, c) => sum + c.points, 0);
  const repMax = criteria.reduce((sum, c) => sum + c.max, 0);
  const temperature = ['hot', 'warm', 'cold'].includes(r.buyingLanguage?.temperature) ? r.buyingLanguage.temperature : 'warm';
  const outcome = OUTCOMES.includes(r.outcome) ? r.outcome : 'unknown';
  const existingId = kb.avatars.some((a) => a.id === r.avatar?.existingId) ? r.avatar.existingId : null;
  const proposed = !existingId && r.avatar?.proposedNew && typeof r.avatar.proposedNew === 'object' && r.avatar.proposedNew.name
    ? { name: trim(r.avatar.proposedNew.name, 80), who: trim(r.avatar.proposedNew.who, 300), description: trim(r.avatar.proposedNew.description, 2000) }
    : null;
  const demo = r.prospect?.demographics && typeof r.prospect.demographics === 'object' ? r.prospect.demographics : {};
  return {
    participants: { rep: trim(r.participants?.rep, 120), prospect: trim(r.participants?.prospect, 120), prospectEmail: r.participants?.prospectEmail ? trim(r.participants.prospectEmail, 200) : null, company: r.participants?.company ? trim(r.participants.company, 200) : null },
    summary: {
      overview: trim(r.summary?.overview, 3000), verdict: trim(r.summary?.verdict, 2000),
      didWell: (Array.isArray(r.summary?.didWell) ? r.summary.didWell : []).slice(0, 8).map((x) => ({ title: trim(x?.title, 120), detail: trim(x?.detail, 1200) })).filter((x) => x.title),
      costTheClose: (Array.isArray(r.summary?.costTheClose) ? r.summary.costTheClose : []).slice(0, 8).map((x) => ({ title: trim(x?.title, 120), detail: trim(x?.detail, 1200) })).filter((x) => x.title),
      nextSteps: list(r.summary?.nextSteps, 8),
    },
    outcome, outcomeEvidence: trim(r.outcomeEvidence, 600),
    leadQuality: {
      score, max: leadCriteriaTotal(kb), label: scoreLabel(score), factors, rationale: trim(r.leadQuality?.rationale, 2000),
      closeProbability: clampInt(r.leadQuality?.closeProbability, 0, 100),
      pattern: r.leadQuality?.pattern && typeof r.leadQuality.pattern === 'object' && r.leadQuality.pattern.name ? { name: trim(r.leadQuality.pattern.name, 120), implication: trim(r.leadQuality.pattern.implication, 800) } : null,
    },
    repScorecard: { scorecardId: card?.id || null, scorecardName: card?.name || 'Overall', total: repTotal, max: repMax, criteria, summary: trim(r.repScorecard?.summary, 2000) },
    buyingLanguage: {
      temperature, mindset: trim(r.buyingLanguage?.mindset, 300),
      signals: (Array.isArray(r.buyingLanguage?.signals) ? r.buyingLanguage.signals : []).slice(0, 12).map((x) => ({ quote: trim(x?.quote, MAX_QUOTE), kind: trim(x?.kind, 30) || 'other', note: trim(x?.note, 300) })).filter((x) => x.quote),
    },
    objections: (Array.isArray(r.objections) ? r.objections : []).slice(0, 10).map((x) => ({ objection: trim(x?.objection, 300), handled: Boolean(x?.handled), howHandled: trim(x?.howHandled, 800), better: trim(x?.better, 800) })).filter((x) => x.objection),
    prospect: {
      demographics: { role: trim(demo.role, 120), businessType: trim(demo.businessType, 120), ageRange: trim(demo.ageRange, 40), location: trim(demo.location, 120), revenueRange: trim(demo.revenueRange, 60) },
      psychographics: list(r.prospect?.psychographics, 8, 300), painPoints: list(r.prospect?.painPoints, 8, 300), desires: list(r.prospect?.desires, 8, 300), language: list(r.prospect?.language, 8, MAX_QUOTE),
    },
    avatar: { id: existingId, confidence: clampInt(r.avatar?.confidence, 0, 100), proposedNew: proposed },
  };
}

/**
 * Run the analysis: condense oversized transcripts segment by segment, then
 * one structured pass. Returns { analysis, model, usage, passes }.
 */
export async function analyzeTranscript({ call, kb, apiKey, model = null, log = () => {} }) {
  const full = transcriptText(call.transcript);
  if (!full.trim()) throw Object.assign(new Error('The transcript is empty.'), { code: 'empty_transcript', status: 400 });
  const system = systemPrompt(kb);
  const opts = { apiKey, ...(model ? { model } : {}) };
  let body = full;
  let condensed = false;
  let passes = 0;
  const usage = { input_tokens: 0, output_tokens: 0 };
  const add = (u) => { if (u) { usage.input_tokens += u.input_tokens || 0; usage.output_tokens += u.output_tokens || 0; } };
  if (full.length > MAX_DIRECT_CHARS) {
    const parts = segments(full);
    log(`condensing ${parts.length} segments`);
    const notes = [];
    for (let n = 0; n < parts.length; n += 1) {
      const r = await complete({ ...opts, effort: 'medium', maxTokens: 8000, schema: CONDENSE_SCHEMA,
        system: 'You condense one segment of a sales-call transcript for a later analysis pass. Keep every fact that matters to qualifying the prospect or judging the rep: goals, pains, numbers, objections, decisions, next steps, who the decision-maker is. Keep verbatim quotes (with their [mm:ss] timestamps) that show buying intent, hesitation, objections, pain or desire. Output JSON only.',
        user: `Segment ${n + 1} of ${parts.length}.\n\n${parts[n]}` });
      passes += 1; add(r.usage);
      const quotes = (r.json?.quotes || []).map((q) => `[${q.t}] ${q.speaker}: ${q.text}`).join('\n');
      notes.push(`### Segment ${n + 1}/${parts.length}\n${r.json?.notes || ''}\n\nKey quotes:\n${quotes}`);
    }
    body = notes.join('\n\n');
    condensed = true;
  }
  log('analysis pass');
  const r = await complete({ ...opts, schema: analysisSchema(kb), system, user: userPrompt(call, body, { condensed }), maxTokens: 16000, effort: 'high' });
  passes += 1; add(r.usage);
  return { analysis: normalizeAnalysis(r.json, kb), model: r.model, usage, passes, condensed };
}
