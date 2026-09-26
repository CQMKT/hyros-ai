/**
 * Payment Links — the Demo account's block: three links and ~40 transactions
 * over the last 30 days whose buyers are demo CRM leads, half of them paying
 * with a different email than they opted in with (the case this feature
 * fixes) and marked linked in HYROS. Deterministic (seeded rng, never
 * Math.random); same shape as server.js.
 */
import { rng, pick, daysAgo } from '../../demo.js';

const FEATURE_ID = 'paylinks';
const seedFor = (id) => [...id].reduce((s, ch) => s + ch.charCodeAt(0), 0);

const LINKS = [
  { id: 'pl_demo1', token: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', source: 'stripe', name: 'Sales Accelerator — Setup', description: 'One-time onboarding fee', amountCents: 1500000, currency: 'usd', interval: null, stripeId: 'plink_demo1', url: 'https://buy.stripe.com/demo_1', active: true, imported: false, createdAt: daysAgo(40).toISOString(), updatedAt: daysAgo(40).toISOString() },
  { id: 'pl_demo2', token: 'b2c3d4e5f60718293a4b5c6d7e8f90a1', source: 'stripe', name: 'Closer Placement — Monthly', description: 'Revenue share floor', amountCents: 299700, currency: 'usd', interval: 'month', stripeId: 'plink_demo2', url: 'https://buy.stripe.com/demo_2', active: true, imported: true, createdAt: daysAgo(35).toISOString(), updatedAt: daysAgo(35).toISOString() },
  { id: 'pl_demo3', token: 'c3d4e5f60718293a4b5c6d7e8f90a1b2', source: 'whop', name: 'Community — Annual', description: 'Whop membership', amountCents: 99700, currency: 'usd', interval: 'year', whopPlanId: 'plan_demo', url: 'https://whop.com/checkout/plan_demo', active: true, imported: false, createdAt: daysAgo(20).toISOString(), updatedAt: daysAgo(20).toISOString() },
];
const OTHER_DOMAINS = ['gmail.com', 'icloud.com', 'outlook.com', 'yahoo.com'];

export const DEMO_SETTINGS = {
  template: 'light', headline: 'Thank You for Your Purchase!', message: 'Your payment was successful. We appreciate your business!',
  logoUrl: '', brand: 'Scale Ecom', accent: '', showOrder: true, showEmail: true, redirectUrl: 'https://scaleecom.example/welcome', countdownS: 8,
  domain: 'confirm.scaleecom.example', trackingScript: '<script>\n/* your HYROS universal script goes here */\n</script>', trackingSource: 'pasted', notifyUrl: '', updatedAt: null,
};

export function demo(snapshot) {
  const r = rng(seedFor(FEATURE_ID));
  const leads = (snapshot?.crm?.leads || []).slice(0, 60);
  const rows = [];
  for (let i = 0; i < 40; i += 1) {
    const lead = leads[(i * 7) % Math.max(1, leads.length)] || { email: `buyer${i}@demo.test`, name: `Buyer ${i}` };
    const link = LINKS[i % 5 === 0 ? 2 : i % 3 === 0 ? 1 : 0];
    const different = r() < 0.5;
    const first = String(lead.name || 'buyer').split(' ')[0].toLowerCase();
    const email = different ? `${first}${Math.floor(r() * 90 + 10)}@${pick(r, OTHER_DOMAINS)}` : lead.email;
    const d = daysAgo(Math.floor(r() * 30)); d.setUTCHours(9 + Math.floor(r() * 10), Math.floor(r() * 60), 0, 0);
    const failed = r() < 0.08;
    const refunded = !failed && r() < 0.05;
    const checked = !failed && r() < 0.85;
    const linked = checked && (different ? r() < 0.9 : r() < 0.97);
    const id = `t_${(0x1000000000 + i * 104729).toString(16).padStart(16, '0').slice(0, 16)}`;
    rows.push({
      id, source: link.source, linkId: link.id, created: d.toISOString(), email, name: lead.name || null,
      amountCents: link.amountCents, currency: link.currency, status: failed ? 'failed' : refunded ? 'refunded' : 'paid', mode: link.interval ? 'subscription' : 'payment',
      via: failed ? ['webhook'] : (r() < 0.8 ? ['page', 'webhook'] : ['webhook']), emailPassed: !failed && r() < 0.92,
      hyros: checked ? { checkedAt: d.toISOString(), found: linked || r() < 0.5, firstSource: linked ? (lead.firstSource?.name || 'Prospecting — Broad') : null, stage: linked ? (lead.stage || 'Customer') : null, linked } : null,
      failure: failed ? pick(r, ['card_declined', 'insufficient_funds', 'expired_card']) : null, refundedCents: refunded ? link.amountCents : 0, livemode: true,
    });
  }
  rows.sort((a, b) => b.created.localeCompare(a.created));
  const built = daysAgo(0); built.setUTCHours(9, 5, 0, 0);
  return { links: LINKS.map((l) => ({ ...l })), rows, totals: null, updatedAt: built.toISOString(), truncated: false, built: built.toISOString() };
}
