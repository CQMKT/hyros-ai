/**
 * Call Intelligence — the Demo account's block. Twelve synthetic sales
 * calls with full analyses, three avatars, every prospect an email from the
 * demo CRM so the attribution join reconciles with the report. Pure and
 * deterministic (seeded rng, never Math.random); same shape as server.js
 * plus `calls` (full analyses by id) so the detail view needs no API.
 */
import { rng, pick, daysAgo } from '../../demo.js';

const FEATURE_ID = 'calls';
const seedFor = (id) => [...id].reduce((s, ch) => s + ch.charCodeAt(0), 0);

const REPS = ['Jay Moreno', 'Ali Reyes', 'Dana Whitfield'];
const AVATARS = [
  { id: 'av_burnout', name: 'The Burnt-Out Scaler', who: 'Coach / course creator, 30–45, already proven their offer works', description: 'Has done $500K+ in launches but is maxing out personal capacity: fulfilment, sales calls and ads all run through them. Wants a system and a team, fears losing control of quality.' },
  { id: 'av_grinder', name: 'The Relentless Grinder', who: 'Owner-operator, mid-30s to late-40s, hustle identity', description: 'Has won and lost in business before, works 70-hour weeks and equates effort with results. Skeptical of "done for you" promises, respects operators who have been in the trenches.' },
  { id: 'av_cautious', name: 'The Cautious Operator', who: 'Contractor / service business owner, $200K–$1M, first-time investing in growth', description: 'Profitable but stuck in tactical execution. Needs proof, references and a clear ROI path before spending; decisions often involve a spouse or partner.' },
];
const SOURCES_FOR_AVATAR = { av_burnout: 0, av_grinder: 1, av_cautious: 2 };

const PAINS = [
  ['Sales calls eat 25 hours a week', 'Fulfilment quality drops when I am not on it', 'Ads are profitable but I cannot scale delivery'],
  ['Working 70 hours and still plateaued', 'Hired two closers who both quit', 'Every launch feels like starting from zero'],
  ['Cash flow swings month to month', 'No idea which marketing actually works', 'Afraid of spending on the wrong thing again'],
];
const DESIRES = [
  ['A sales manager who owns the process', 'Two full days a week away from the business', 'A million-dollar month without more hours'],
  ['A system that survives without me', 'Predictable pipeline every week', 'Respect as an operator, not a hustler'],
  ['A clear path from $600K to $1.5M', 'Proof before I commit', 'Time with my family back'],
];
const LANGUAGE = [
  ['I love it, this is probably the best offer I have seen', 'I want to make sure I give you guys everything you need', 'I move with speed, I am not someone who sits on things'],
  ['I have been burned before, so show me', 'I do not need motivation, I need a machine', 'If it works, I am all in'],
  ['I need to run it past my wife', 'What happens if it does not work?', 'Walk me through the numbers again'],
];
const OBJECTIONS = [
  { objection: 'Never done rev share at 3%', handled: true, howHandled: 'Reframed around the million-a-month goal: at a million, 5% is $50K a month.', better: 'Establish full value before naming any number; the discount created resistance rather than urgency.' },
  { objection: 'I want to think about it overnight', handled: false, howHandled: 'Rep said "take your time" and booked a follow-up.', better: 'Isolate what specifically needs evaluating; the prospect had already said he moves fast.' },
  { objection: 'Price is higher than the last agency', handled: true, howHandled: 'Compared cost of the last agency\'s missed quarter to the fee.', better: 'Anchor on the cost of inaction earlier so price lands as an investment.' },
  { objection: 'Need to check with my partner', handled: false, howHandled: 'Accepted at face value.', better: 'Offer to bring the partner onto a 15-minute call while momentum is high.' },
];
const SIGNALS = {
  hot: [['I love it. Like, actually. This is probably the best offer.', 'commitment', 'Enthusiasm plus evaluation — strong buying signal.'], ['I want to make sure I 100% give you guys everything you need.', 'ownership', 'Already seeing themselves in the engagement.'], ['I move with speed. Always everything I do.', 'internal_locus', 'Action-oriented identity; counters "need to think".']],
  warm: [['It makes sense on paper, I just need to see it work for someone like me.', 'skepticism', 'Wants proof; belief work not finished.'], ['If we did this, when would we start?', 'commitment', 'Forward-looking question — interest is real.'], ['I am not going to decide today.', 'hesitation', 'Timeline objection, not a fit objection.']],
  cold: [['I am really just gathering information right now.', 'hesitation', 'Low intent stated up front.'], ['My partner handles anything over five grand.', 'authority', 'The decision-maker is not on the call.'], ['That is a lot more than I expected.', 'price', 'Price objection before value was built.']],
};
const CRITERIA = [['authority', 'Authority', 15], ['desire', 'Desire Clarity', 20], ['pain', 'Pain Awareness', 20], ['urgency', 'Urgency', 15], ['budget', 'Budget & Ability', 15], ['fit', 'Fit', 15]];
const CARD = [['discovery', 'Discovery Depth'], ['belief', 'Belief Work'], ['value', 'Value Before Price'], ['objections', 'Objection Handling'], ['close', 'The Close']];
const scoreLabel = (s) => (s >= 85 ? 'Exceptional' : s >= 70 ? 'Strong' : s >= 50 ? 'Moderate' : 'Weak');

function analysisFor(r, i, lead, avatarIdx, rep) {
  const av = AVATARS[avatarIdx];
  const temperature = avatarIdx === 0 ? (r() < 0.75 ? 'hot' : 'warm') : avatarIdx === 1 ? (r() < 0.5 ? 'warm' : 'hot') : (r() < 0.55 ? 'warm' : 'cold');
  const base = temperature === 'hot' ? 0.85 : temperature === 'warm' ? 0.65 : 0.4;
  const factors = CRITERIA.map(([id, name, max]) => {
    const points = Math.max(0, Math.min(max, Math.round(max * (base + (r() - 0.5) * 0.4))));
    return { id, name, max, points, evidence: `${name}: ${points >= max * 0.7 ? 'clearly established' : 'only partly established'} in the call (see transcript).` };
  });
  const score = factors.reduce((s, f) => s + f.points, 0);
  const outcome = temperature === 'hot' ? (r() < 0.55 ? 'closed' : 'follow_up') : temperature === 'warm' ? (r() < 0.7 ? 'follow_up' : 'lost') : (r() < 0.5 ? 'lost' : 'follow_up');
  const criteria = CARD.map(([id, title]) => {
    const points = Math.max(2, Math.min(10, Math.round(10 * (0.55 + (r() - 0.5) * 0.6))));
    return { id, title, max: 10, points, evidence: `${title} scored ${points}/10 on this call.`, coaching: points < 7 ? `Tighten ${title.toLowerCase()}: one more layered question before moving on.` : `Keep doing this — ${title.toLowerCase()} was a strength.` };
  });
  const total = criteria.reduce((s, c) => s + c.points, 0);
  const prospect = lead.name;
  const objs = [pick(r, OBJECTIONS), pick(r, OBJECTIONS)].filter((o, k, a) => a.findIndex((x) => x.objection === o.objection) === k);
  return {
    participants: { rep, prospect, prospectEmail: lead.email, company: null },
    summary: {
      overview: `${rep} spoke with ${prospect} about the offer. The call ended with ${outcome === 'closed' ? 'a verbal yes and payment details agreed' : outcome === 'follow_up' ? 'a follow-up scheduled — the prospect will confirm within two days' : 'the prospect declining for now'}.`,
      verdict: temperature === 'hot' ? `Strong lead (engaged, motivated, high intent)${outcome !== 'closed' ? ', but the rep accepted a follow-up when a close was available' : ''}.` : temperature === 'warm' ? 'Real interest with unresolved belief — one more proof point would have moved it.' : 'Low intent and the decision-maker was not on the call; qualify harder next time.',
      didWell: [{ title: 'Anchored on the scale vision', detail: 'Framed the offer around the prospect\'s stated goal rather than the current numbers.' }, { title: 'Built proof through vulnerability', detail: 'Shared a first-hand story that created instant credibility.' }],
      costTheClose: outcome === 'closed' ? [] : [{ title: objs[0]?.objection || 'Accepted "need to think" at face value', detail: objs[0]?.better || 'No probing for what specifically needed evaluation.' }],
      nextSteps: outcome === 'closed' ? ['Send the agreement today', 'Book the onboarding call'] : ['Send a 3-line recap with the two proof points', 'Confirm the decision date in writing'],
    },
    outcome, outcomeEvidence: 'Stated at the end of the call.',
    leadQuality: { score, max: 100, label: scoreLabel(score), factors, rationale: `${prospect} ${temperature === 'hot' ? 'is a highly qualified buyer with clear motivation and full authority; hesitation is logistics, not psychology' : temperature === 'warm' ? 'is interested and a fit, but belief in the outcome is not settled' : 'is early and not the decision-maker'}.`, closeProbability: Math.round(score * 0.85), pattern: temperature === 'hot' ? { name: 'High Self-Efficacy + High Solution Belief', implication: 'Lay-down buyer: the only barrier is logistics.' } : null },
    repScorecard: { scorecardId: 'high-ticket', scorecardName: 'High-Ticket Close', total, max: 50, criteria, summary: `${total}/50 on the High-Ticket Close scorecard.` },
    buyingLanguage: { temperature, mindset: temperature === 'hot' ? 'Buyer mentality' : temperature === 'warm' ? 'Evaluating' : 'Browsing', signals: SIGNALS[temperature].map(([quote, kind, note]) => ({ quote, kind, note })) },
    objections: objs,
    prospect: {
      demographics: { role: av.who.split(',')[0], businessType: av.who.split(',')[0], ageRange: avatarIdx === 0 ? '30–45' : avatarIdx === 1 ? '35–48' : '38–52', location: pick(r, ['Austin, TX', 'Miami, FL', 'Phoenix, AZ', 'Toronto, ON', 'Denver, CO']), revenueRange: avatarIdx === 2 ? '$200K–$1M' : '$500K–$2M' },
      psychographics: avatarIdx === 0 ? ['Identity tied to being the expert', 'Values speed and decisiveness', 'Fears losing quality when delegating'] : avatarIdx === 1 ? ['Effort equals worth', 'Distrusts easy promises', 'Respects operators'] : ['Risk-averse', 'Family-first decisions', 'Needs numbers before feelings'],
      painPoints: PAINS[avatarIdx], desires: DESIRES[avatarIdx], language: LANGUAGE[avatarIdx],
    },
    avatar: { id: av.id, name: av.name, confidence: 70 + Math.round(r() * 28), proposedNew: null },
  };
}

function transcriptFor(r, rep, prospect, temperature) {
  const lines = [
    [0, rep, `Hey ${prospect.split(' ')[0]}, thanks for jumping on. Before we get into anything — what made you book this call?`],
    [18, prospect, temperature === 'cold' ? 'Honestly I am really just gathering information right now.' : 'I have been looking for someone who actually wants to scale to a million a month. I might even step out of the day-to-day and put someone in there to manage it for me.'],
    [61, rep, 'Got it. And right now, what is the thing that is actually capping you?'],
    [74, prospect, pick(r, ['Sales calls eat twenty-five hours a week and fulfilment slips when I am not on it.', 'I hired two closers, both quit inside ninety days. Every launch feels like starting over.', 'Cash flow swings every month and I could not tell you which marketing works.'])],
    [130, rep, 'If we take that off your plate and the pipeline is predictable, what does a good quarter look like?'],
    [150, prospect, pick(r, ['At a million a month, five percent is fifty grand. That is the number.', 'Two full days a week away from the business without the wheels coming off.', 'A clear path from six hundred to one and a half — with proof.'])],
    [420, rep, 'Let me show you how we run this with the other offer owners, then you tell me if it fits.'],
    [1680, prospect, temperature === 'hot' ? 'I love it. Like, actually. This is probably the best offer.' : temperature === 'warm' ? 'It makes sense on paper. I just need to see it work for someone like me.' : 'My partner handles anything over five grand, I would need to bring this to her.'],
    [1712, rep, 'So what would you need to see to say yes today?'],
    [1730, prospect, temperature === 'hot' ? 'I want to take the rest of the day, make sure I can 100% give you guys my heart and soul. I will text you tonight or tomorrow morning.' : temperature === 'warm' ? 'A reference I can call, and I am not going to decide today.' : 'Walk me through the numbers again and send it over.'],
    [1750, rep, temperature === 'hot' ? 'Take your time, man. I will send the recap now.' : 'Fair. I will send two references and a one-page recap within the hour.'],
  ];
  return lines.map(([t, speaker, text]) => ({ t, speaker, text }));
}

export function demo(snapshot) {
  const r = rng(seedFor(FEATURE_ID));
  const leads = (snapshot?.crm?.leads || []).slice(0, 40);
  const adsets = snapshot?.ranges?.['30d']?.levels?.adset || [];
  const rows = [];
  const calls = {};
  const counts = { av_burnout: 0, av_grinder: 0, av_cautious: 0 };
  for (let i = 0; i < 12; i += 1) {
    const lead = leads[(i * 3) % Math.max(1, leads.length)] || { email: `prospect${i}@demo.test`, name: `Prospect ${i}`, firstSource: null, stage: 'Lead' };
    const avatarIdx = i % 3 === 0 ? 0 : i % 3 === 1 ? (r() < 0.6 ? 1 : 0) : 2;
    const rep = REPS[i % REPS.length];
    const analysis = analysisFor(r, i, lead, avatarIdx, rep);
    counts[AVATARS[avatarIdx].id] += 1;
    const dayOffset = Math.floor(i * 2.3 + r() * 2);
    const date = daysAgo(dayOffset); date.setUTCHours(15 + (i % 4), 0, 0, 0);
    const durationS = 1800 + Math.round(r() * 1500);
    const src = lead.firstSource || (adsets.length ? { name: adsets[SOURCES_FOR_AVATAR[AVATARS[avatarIdx].id] % adsets.length].name, tag: null, ad: null } : null);
    const category = adsets.find((a) => a.name === src?.name)?._category || null;
    const attribution = src ? { matched: true, email: lead.email, leadId: lead.email, name: lead.name, joined: lead.joined || null, stage: lead.stage || null, firstSource: { name: src.name, tag: src.tag || null, organic: false, ad: src.ad || null, category, trafficSource: null, clickDate: lead.joined || null }, lastSource: { name: src.name, tag: src.tag || null, organic: false, ad: src.ad || null, category, trafficSource: null, clickDate: lead.joined || null }, tags: lead.tags || [] } : { matched: false, reason: 'no prospect email on the call' };
    const id = `c_${(1000000000 + i * 7919).toString(16).padStart(12, '0').slice(0, 12)}`;
    const title = `Strategy Call — ${lead.name}`;
    const status = i === 11 ? 'queued' : 'done';
    const call = {
      id, source: i % 4 === 0 ? 'fathom' : i % 4 === 1 ? 'fireflies' : 'paste', externalId: null, title, date: date.toISOString(), durationS,
      attendees: [{ name: rep, email: `${rep.split(' ')[0].toLowerCase()}@demo.hyros.com`, external: false }, { name: lead.name, email: lead.email, external: true }],
      recordedBy: { name: rep, email: `${rep.split(' ')[0].toLowerCase()}@demo.hyros.com` }, rep,
      transcript: transcriptFor(r, rep, lead.name, analysis.buyingLanguage.temperature), vendorSummary: null, url: null,
      status, error: null, createdAt: date.toISOString(), updatedAt: date.toISOString(), analyzedAt: status === 'done' ? date.toISOString() : null,
      analysis: status === 'done' ? analysis : null, attribution: status === 'done' ? attribution : null,
      writeBack: status === 'done' && i % 2 === 0 ? { ok: true, tags: [`ai-score-${analysis.leadQuality.score}`, `ai-${analysis.buyingLanguage.temperature}`], at: date.toISOString() } : null,
      model: status === 'done' ? 'demo' : null, usage: null,
    };
    calls[id] = call;
    const a = call.analysis;
    rows.push({
      id, source: call.source, title, date: call.date, durationS, rep, prospect: lead.name, leadEmail: lead.email,
      outcome: a ? a.outcome : null, leadScore: a ? a.leadQuality.score : null, leadMax: a ? 100 : null, repScore: a ? a.repScorecard.total : null, repMax: a ? 50 : null,
      temperature: a ? a.buyingLanguage.temperature : null, avatarId: a ? a.avatar.id : null, avatarName: a ? a.avatar.name : null,
      painPoints: a ? a.prospect.painPoints.slice(0, 3) : [], desires: a ? a.prospect.desires.slice(0, 3) : [], language: a ? a.prospect.language.slice(0, 3) : [],
      attribution: a && attribution.matched ? { firstSource: attribution.firstSource.name, lastSource: attribution.lastSource.name, category, ad: attribution.firstSource.ad, stage: attribution.stage } : null,
      status, error: null, analyzedAt: call.analyzedAt,
    });
  }
  rows.sort((a, b) => b.date.localeCompare(a.date));
  const built = daysAgo(0); built.setUTCHours(9, 5, 0, 0);
  return {
    rows, updatedAt: built.toISOString(), truncated: false, dropped: 0,
    avatars: AVATARS.map((a) => ({ ...a, callCount: counts[a.id], createdAt: null })),
    built: built.toISOString(),
    calls,
  };
}

/** The read-only knowledge base the Setup sub-tab shows on the Demo account (same shape as /api/kb). */
export const DEMO_KB = {
  version: 1,
  company: { name: 'Scale Ecom', industry: 'Growth consulting for online course & coaching businesses', markets: 'US / Canada, offer owners doing $500K–$5M', offer: 'A done-with-you sales team: we place and manage closers on a revenue share so the founder gets out of the sales seat.', pricing: '$15K setup + 3–5% revenue share' },
  context: [{ id: 'ctx_1', title: 'Sales process', body: 'Discovery → belief work → offer → close on the call; a follow-up is a loss unless a decision date is set.' }],
  leadCriteria: CRITERIA.map(([id, name, points]) => ({ id, name, points, description: `How clearly ${name.toLowerCase()} was established by the prospect.` })),
  scorecards: [{ id: 'high-ticket', name: 'High-Ticket Close', description: 'Discovery, belief work, objection handling, and the close.', criteria: CARD.map(([id, title]) => ({ id, title, description: `What strong ${title.toLowerCase()} looks like.`, max: 10 })) }],
  activeScorecardId: 'high-ticket',
  avatars: AVATARS.map((a) => ({ ...a, callCount: 4, createdAt: null })),
  writeBack: { enabled: true, tagPrefix: 'ai', createCalls: false },
  model: null, updatedAt: null,
};
