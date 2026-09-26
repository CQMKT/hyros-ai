/**
 * Payment Links — server step. No MCP calls: transactions are recorded when
 * the thank-you page loads or a Stripe/Whop webhook arrives (api/ty.js,
 * api/ingest.js) and kept in KV; the refresh hands links + the newest
 * transactions in as `ctx.snapshot.payIntel` (api/refresh.js). This step
 * copies them into the block so the tab works from the one snapshot; the
 * view re-pulls live data through ctx.api('/api/paylinks').
 */
const MARKERS = ['skipped', 'error', 'stale'];
const dataOf = (block) => (block && typeof block === 'object'
  ? Object.fromEntries(Object.entries(block).filter(([k]) => !MARKERS.includes(k))) : {});

export async function build(ctx) {
  const now = ctx.now instanceof Date ? ctx.now : new Date();
  const built = now.toISOString();
  const p = ctx.snapshot?.payIntel;
  if (p && typeof p === 'object' && Array.isArray(p.rows)) {
    return { links: Array.isArray(p.links) ? p.links : [], rows: p.rows, totals: p.totals || null, updatedAt: p.updatedAt || null, truncated: Boolean(p.truncated), built };
  }
  const prev = dataOf(ctx.previous);
  if (Array.isArray(prev.rows)) return { ...prev, built };
  return { links: [], rows: [], totals: null, updatedAt: null, truncated: false, built };
}
