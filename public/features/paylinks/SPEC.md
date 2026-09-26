# Payment Links — feature spec

**id** `paylinks` · **mode** both · **version** 1.0.0

## Purpose
Fix the different-email attribution gap. A prospect opts in or books with
one email; the rep drops a Stripe (or Whop) payment link into the call; the
buyer pays on the processor's hosted page — where the HYROS script cannot
run — with another email. HYROS never sees that email inside the browser
session that carries the ad clicks, so the sale is unattributed. This tab
creates (or imports) payment links whose after-payment redirect lands on a
thank-you page this deployment hosts, resolves the paying email from the
Checkout Session, puts it in the page URL (`&email=`) and renders the page
with the account's HYROS universal script in the `<head>` — the same
mechanism as Pingit (pingitnow.com). The transaction log then reads the
buyer back from HYROS to show whether the link happened.

## Data
- **This feature's `server.js` makes no MCP calls.** Transactions are
  recorded by core routes this fork adds (see "Porting notes"): the public
  page `api/ty.js` (`/ty?l=<token>&session_id=…`), the webhook receiver
  `api/ingest.js` (`src=stripe|whop`) and the dashboard route
  `api/paylinks.js`. The refresh hands `ctx.snapshot.payIntel` in; the step
  copies it.
- HYROS: `hyros_get_leads { request: { emails, pageSize: 50 } }` (≤ 50
  emails) for the "Verify in HYROS" check; optionally
  `hyros_get_account_tracking_script` to fetch the universal script (its
  reply shape is undocumented — the pasted script is the reliable path).
- Stripe: `/v1/products`, `/v1/prices`, `/v1/payment_links` (+ `line_items`),
  `/v1/checkout/sessions/{id}?expand[]=line_items`, `/v1/webhook_endpoints`;
  `Stripe-Signature` verification. Whop: `GET /api/v1/payments/{id}`;
  webhook HMAC (header framing confirmed at first live delivery).
- Demo: 3 links, 40 transactions from the demo CRM's leads, half paid with a
  different email; `DEMO_SETTINGS` for the read-only Setup view.
- **MCP limits reminder** (FEATURES.md "MCP limits"): ≤ 50 emails per call;
  `pageSize` ≤ 250; per-call timeouts ≤ 15 s; one rate limit per HYROS
  account; `accessible_account_id` and the key are applied by the core.

## Block shape (`snapshot.paylinks`)
```json
{
  "links": [{ "id": "pl_x", "token": "32 hex", "source": "stripe | whop", "name": "", "description": "", "amountCents": 150000, "currency": "usd", "interval": null, "stripeId": "plink_…", "url": "https://buy.stripe.com/…", "active": true, "imported": false, "createdAt": "ISO" }],
  "rows": [{ "id": "t_16hex", "source": "stripe", "linkId": "pl_x", "created": "ISO", "email": "", "name": "", "amountCents": 100, "currency": "usd",
             "status": "paid | unpaid | failed | refunded | expired", "mode": "payment | subscription", "via": ["page", "webhook"], "emailPassed": true,
             "hyros": { "checkedAt": "ISO", "found": true, "firstSource": "", "stage": "", "linked": true }, "failure": null, "refundedCents": 0, "livemode": true }],
  "totals": { "transactions": 0, "paid": 0, "failed": 0, "refunded": 0, "revenueCents": 0, "emailPassed": 0, "checked": 0, "linked": 0, "found": 0 },
  "updatedAt": "ISO", "truncated": false, "built": "ISO"
}
```
`emailPassed` means the page rendered with the buyer's email in its URL (the
script could read it). `hyros.linked` means the paying email now exists in
HYROS as a lead with a first source. Money is in the transaction's own
currency (cents); the view formats it with `Intl`, not `ctx.fmt.money`,
because a link may be priced in a currency other than the account's.

## The thank-you page (`/ty`)
1. Stripe redirects to `/ty?l=<token>&session_id={CHECKOUT_SESSION_ID}`.
2. The token names the account and link; the Checkout Session is retrieved
   with the account's Stripe key; the transaction is recorded.
3. One 302 to the same URL with `&email=<buyer>` appended.
4. The page renders with the pasted HYROS script in `<head>`, the email, the
   order details and an optional countdown redirect. A hidden
   `<input type="email">` carries the email as a second capture path.
Unknown tokens or sessions render a neutral thank-you page (never an error
to a buyer). `X-Robots-Tag: noindex`, `Cache-Control: no-store`.

## View states
fresh · stale (`{ ...data, stale: true, skipped }` → "showing the previous
result") · bare `{ skipped }` · `{ error }` · `null` / `{}` — the view never
throws. Live accounts re-pull through `ctx.api('/api/paylinks')`.

## Rules honoured
- Totals and shares re-derived from rows (`rollup.js`); nothing incremented.
- Every data string escaped with `ctx.esc`; the only raw HTML on the public
  page is the owner's own `<script>` block, validated to reference
  `hyros.com`, ≤ 4 KB, no other tags.
- Keys (Stripe, Whop) encrypted like HYROS keys, never returned; webhook
  deliveries signature-verified; the page's link token is random per link.

## Porting notes
Another fork installs the folder plus: `api/_stripe.js`, `api/_whop.js`,
`api/_paylinks.js`, `api/ty.js`, `api/paylinks.js`, the `stripe`/`whop`
kinds in `api/_integrations.js`, the `handlePayment` branch in
`api/ingest.js`, the `payIntel` hand-off in `api/refresh.js` →
`api/_snapshot.js`, `/api/paylinks` in `ACCOUNT_SCOPED` (`public/app.js`),
and the `/ty` rewrite + function entries in `vercel.json`. A different app
must produce the block above and can reuse `view.js`, `rollup.js` and
`style.css`.

## Open limitations
- Whop's hosted checkout does not document what it appends on redirect;
  the Whop page reads `payment_id` when present, otherwise the webhook is
  the record of truth and the page is neutral. Confirm live.
- HYROS merges the two emails on its own schedule; "Verify in HYROS"
  reports what HYROS returns now (FINDINGS.md "Lead attribution is exposed
  — only for tracked-click leads").
- Dunning / retry sequences are Stripe's job (Smart Retries); failed
  payments are listed, not retried.
