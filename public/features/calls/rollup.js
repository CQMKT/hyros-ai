/**
 * Call Intelligence — pure rollups over the index rows. Shared by the tab
 * (view.js), the demo generator and the server (api/), so the numbers a
 * user sees are computed one way. No DOM, no fetch, no state.
 *
 * An index row (see SPEC.md): { id, source, title, date, durationS, rep,
 *   prospect, leadEmail, outcome, leadScore, leadMax, repScore, repMax,
 *   temperature, avatarId, avatarName, painPoints[], desires[], language[],
 *   attribution: { firstSource, lastSource, category, ad, stage } | null,
 *   status: queued | analyzing | done | error, error }
 */
export const OUTCOMES = ['closed', 'follow_up', 'no_show', 'lost', 'unknown'];
export const OUTCOME_LABEL = { closed: 'Closed', follow_up: 'Follow up', no_show: 'No show', lost: 'Lost', unknown: 'Unknown' };
export const TEMPERATURES = ['hot', 'warm', 'cold'];
export const STATUS_LABEL = { queued: 'Queued', analyzing: 'Analyzing', done: 'Analyzed', error: 'Failed' };

export const scoreLabel = (score) => (score >= 85 ? 'Exceptional' : score >= 70 ? 'Strong' : score >= 50 ? 'Moderate' : 'Weak');
export const isDone = (r) => r && r.status === 'done' && Number.isFinite(r.leadScore);

const avg = (nums) => (nums.length ? nums.reduce((s, n) => s + n, 0) / nums.length : null);
const pct = (part, whole) => (whole ? part / whole : null);

/** Headline numbers for a set of rows. Ratios are re-derived from counts, never averaged. */
export function kpis(rows) {
  const all = Array.isArray(rows) ? rows : [];
  const done = all.filter(isDone);
  const decided = done.filter((r) => r.outcome === 'closed' || r.outcome === 'lost' || r.outcome === 'follow_up');
  return {
    total: all.length,
    analyzed: done.length,
    queued: all.filter((r) => r.status === 'queued' || r.status === 'analyzing').length,
    failed: all.filter((r) => r.status === 'error').length,
    avgLead: avg(done.map((r) => r.leadScore)),
    avgRepPct: avg(done.filter((r) => r.repMax > 0).map((r) => r.repScore / r.repMax)),
    hotShare: pct(done.filter((r) => r.temperature === 'hot').length, done.length),
    closeRate: pct(decided.filter((r) => r.outcome === 'closed').length, decided.length),
    closed: done.filter((r) => r.outcome === 'closed').length,
    attributed: done.filter((r) => r.attribution && r.attribution.firstSource).length,
  };
}

/** Count of rows per outcome, every outcome present. */
export function outcomeCounts(rows) {
  const out = Object.fromEntries(OUTCOMES.map((o) => [o, 0]));
  for (const r of (rows || []).filter(isDone)) out[OUTCOMES.includes(r.outcome) ? r.outcome : 'unknown'] += 1;
  return out;
}

/** Group analyzed rows by a key and roll each group up the same way. */
export function groupBy(rows, keyOf, nameOf = (r, k) => k) {
  const groups = new Map();
  for (const r of (rows || []).filter(isDone)) {
    const key = keyOf(r);
    if (key === null || key === undefined || key === '') continue;
    const g = groups.get(key) || { key, name: nameOf(r, key), rows: [] };
    g.rows.push(r);
    groups.set(key, g);
  }
  return [...groups.values()].map((g) => {
    const k = kpis(g.rows);
    return { key: g.key, name: g.name, calls: g.rows.length, avgLead: k.avgLead, closeRate: k.closeRate, closed: k.closed, hotShare: k.hotShare, avgRepPct: k.avgRepPct, rows: g.rows };
  }).sort((a, b) => b.calls - a.calls || (b.avgLead || 0) - (a.avgLead || 0));
}

/** By first source (the ad set / source HYROS credited the lead's first click to). */
export const bySource = (rows) => groupBy(rows, (r) => r.attribution?.firstSource || null);
/** By source category (HYROS's "Campaign" level). */
export const byCategory = (rows) => groupBy(rows, (r) => r.attribution?.category || null);
/** By rep (who ran the call). */
export const byRep = (rows) => groupBy(rows, (r) => r.rep || null);
/** By avatar; `avatars` supplies names for ids the rows only reference. */
export const byAvatar = (rows, avatars = []) => groupBy(rows, (r) => r.avatarId || null,
  (r, id) => r.avatarName || avatars.find((a) => a.id === id)?.name || id);

/** Most frequent strings in a list of lists (case-insensitive), with counts. */
export function topItems(lists, n = 6) {
  const counts = new Map();
  for (const l of lists || []) for (const item of (Array.isArray(l) ? l : [])) {
    const key = String(item).trim().toLowerCase();
    if (!key) continue;
    const cur = counts.get(key) || { text: String(item).trim(), n: 0 };
    cur.n += 1;
    counts.set(key, cur);
  }
  return [...counts.values()].sort((a, b) => b.n - a.n).slice(0, n);
}

/** Sort rows newest first (ISO dates compare as strings). */
export const newestFirst = (rows) => [...(rows || [])].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
