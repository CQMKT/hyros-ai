/**
 * Call Intelligence — server step. Makes NO MCP calls: the analyses are
 * produced when a call arrives (api/ingest.js, api/calls.js → api/_analyze.js)
 * and kept in KV; the refresh hands the compact index in as
 * `ctx.snapshot.callIntel` (api/refresh.js reads it for the account). This
 * step copies it into the feature block so the tab works from the one
 * snapshot document like every other tab. The view refreshes the index
 * live through ctx.api('/api/calls') so new calls show between refreshes.
 */
const MARKERS = ['skipped', 'error', 'stale'];
const dataOf = (block) => (block && typeof block === 'object'
  ? Object.fromEntries(Object.entries(block).filter(([k]) => !MARKERS.includes(k))) : {});

export async function build(ctx) {
  const now = ctx.now instanceof Date ? ctx.now : new Date();
  const built = now.toISOString();
  const intel = ctx.snapshot?.callIntel;
  if (intel && typeof intel === 'object' && Array.isArray(intel.rows)) {
    return { rows: intel.rows, updatedAt: intel.updatedAt || null, truncated: Boolean(intel.truncated), dropped: intel.dropped || 0, avatars: Array.isArray(intel.avatars) ? intel.avatars : [], built };
  }
  // No index yet (nothing analyzed, or the runner did not hand one in): keep
  // the previous rows so the tab never goes blank, else an honest empty block.
  const prev = dataOf(ctx.previous);
  if (Array.isArray(prev.rows)) return { ...prev, built };
  return { rows: [], updatedAt: null, truncated: false, dropped: 0, avatars: [], built };
}
