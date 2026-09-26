/**
 * Payment Links — pure rollups over transaction rows. Shared by the view,
 * the demo and the server. Money stays in cents in the transaction's own
 * currency (a Stripe link can be priced in any currency); `formatMoney`
 * renders it. Ratios are re-derived from counts, never averaged.
 */
export const STATUS_LABEL = { paid: 'Paid', unpaid: 'Processing', failed: 'Failed', refunded: 'Refunded', expired: 'Expired' };
export const isPaid = (r) => r && (r.status === 'paid' || r.status === 'refunded');

export function formatMoney(cents, currency = 'usd') {
  const n = (Number(cents) || 0) / 100;
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: String(currency || 'usd').toUpperCase(), maximumFractionDigits: 2 }).format(n); }
  catch { return `${n.toFixed(2)} ${String(currency || 'usd').toUpperCase()}`; }
}

/** Totals for a set of rows (re-derived every time). */
export function totals(rows) {
  const all = Array.isArray(rows) ? rows : [];
  const paid = all.filter(isPaid);
  const checked = all.filter((r) => r.hyros);
  const currencies = [...new Set(paid.map((r) => r.currency || 'usd'))];
  return {
    transactions: all.length, paid: paid.length, failed: all.filter((r) => r.status === 'failed').length, refunded: all.filter((r) => r.status === 'refunded').length,
    revenueCents: paid.reduce((s, r) => s + (r.amountCents || 0) - (r.refundedCents || 0), 0), currency: currencies.length === 1 ? currencies[0] : (currencies[0] || 'usd'), mixed: currencies.length > 1,
    avgOrderCents: paid.length ? Math.round(paid.reduce((s, r) => s + (r.amountCents || 0), 0) / paid.length) : null,
    emailPassed: paid.filter((r) => r.emailPassed).length, emailShare: paid.length ? paid.filter((r) => r.emailPassed).length / paid.length : null,
    checked: checked.length, linked: checked.filter((r) => r.hyros.linked).length, found: checked.filter((r) => r.hyros.found).length,
    linkedShare: checked.length ? checked.filter((r) => r.hyros.linked).length / checked.length : null,
  };
}

/** Per link: sales, revenue, linked share. Links without rows still appear. */
export function byLink(rows, links) {
  const all = Array.isArray(rows) ? rows : [];
  return (Array.isArray(links) ? links : []).map((l) => {
    const mine = all.filter((r) => r.linkId === l.id);
    const t = totals(mine);
    return { link: l, calls: mine.length, sales: t.paid, revenueCents: t.revenueCents, currency: l.currency || t.currency, failed: t.failed, linkedShare: t.linkedShare, lastSaleAt: mine.filter(isPaid)[0]?.created || null };
  }).sort((a, b) => b.revenueCents - a.revenueCents || b.sales - a.sales);
}

/** Sales and revenue per day for the last `days` days (oldest first). */
export function byDay(rows, days = 14, now = new Date()) {
  const out = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(now); d.setUTCDate(d.getUTCDate() - i);
    const ymd = d.toISOString().slice(0, 10);
    const mine = (rows || []).filter((r) => isPaid(r) && String(r.created || '').startsWith(ymd));
    out.push({ day: ymd, sales: mine.length, revenueCents: mine.reduce((s, r) => s + (r.amountCents || 0), 0) });
  }
  return out;
}

/** HYROS check outcome buckets for paid rows. */
export function hyrosBuckets(rows) {
  const paid = (rows || []).filter(isPaid);
  return {
    linked: paid.filter((r) => r.hyros?.linked).length,
    foundOnly: paid.filter((r) => r.hyros && r.hyros.found && !r.hyros.linked).length,
    missing: paid.filter((r) => r.hyros && !r.hyros.found).length,
    unchecked: paid.filter((r) => !r.hyros).length,
  };
}

export const newestFirst = (rows) => [...(rows || [])].sort((a, b) => String(b.created || '').localeCompare(String(a.created || '')));
