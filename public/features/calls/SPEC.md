# Call Intelligence — feature spec

**id** `calls` · **mode** both · **version** 1.0.0

## Purpose
Close the loop from the bottom of the funnel back to the top. Every sales
call recorded by Fathom or Fireflies (or pasted in) is analyzed into a deal
summary, a 0–100 lead score against the account's own grading criteria, a
rep scorecard, buying-language signals, objections, prospect intelligence
(demographics, psychographics, pain points, desires, verbatim language) and
an avatar. The prospect's email is matched to the HYROS lead, so each call
carries its first/last source and stage — which ad sets produce buyers who
can actually be closed, and which reps close them. Scores can be pushed
back into HYROS as lead tags.

## Data
- **This feature's `server.js` makes no MCP calls.** Analyses happen when a
  call arrives, in core routes this fork adds (see "Porting notes"):
  `api/ingest.js` (webhooks), `api/calls.js` (paste, re-analyze),
  `api/_analyze.js` (the pipeline). The refresh hands the compact index in
  as `ctx.snapshot.callIntel`; the step copies it into the block.
- The pipeline uses `hyros_get_leads { request: { emails, pageSize: 50 } }`
  (≤ 50 emails) for the attribution join and, when write-back is on,
  `hyros_add_tags_to_leads { request: { emails, tags } }` and
  `hyros_create_call { request: { email, callDate, status, name } }`. The
  two write tools' argument shapes are not documented by HYROS (mcp.txt
  lists the names only); FINDINGS.md tracks what the live MCP accepts.
- Model: the Anthropic Messages API over plain `fetch`, structured JSON
  output pinned to the knowledge base (criteria ids, scorecard ids, avatar
  ids are enums). Transcripts above ~120k characters are condensed in
  segments first, never truncated.
- The demo generates 12 calls with full analyses from the demo CRM's leads
  (seed: char codes of `calls`), three avatars, one queued call.
- **MCP limits reminder** (FEATURES.md "MCP limits"): ≤ 50 ids / emails /
  tags per call; `pageSize` ≤ 250; per-call timeouts ≤ 15 s; one rate limit
  per HYROS account; `accessible_account_id` and the API key are applied by
  the core (`asAccount`) — never passed by hand.

## Block shape (`snapshot.calls`)
```json
{
  "rows": [{
    "id": "c_0123456789ab", "source": "fathom | fireflies | paste", "title": "", "date": "ISO", "durationS": 2940,
    "rep": "", "prospect": "", "leadEmail": "",
    "outcome": "closed | follow_up | no_show | lost | unknown",
    "leadScore": 88, "leadMax": 100, "repScore": 38, "repMax": 50, "temperature": "hot | warm | cold",
    "avatarId": "av_x", "avatarName": "", "painPoints": [""], "desires": [""], "language": [""],
    "attribution": { "firstSource": "", "lastSource": "", "category": "", "ad": "", "stage": "" },
    "status": "queued | analyzing | done | error", "error": null, "analyzedAt": "ISO"
  }],
  "updatedAt": "ISO", "truncated": false, "dropped": 0,
  "avatars": [{ "id": "av_x", "name": "", "who": "", "description": "", "callCount": 3 }],
  "built": "ISO",
  "calls": { "c_…": "full call record (demo only; live details come from /api/calls?id=)" }
}
```
The index keeps the newest 300 rows; `dropped` counts the rest. A full
call record (`/api/calls?id=`) is `{ id, source, title, date, durationS,
attendees[], recordedBy, rep, transcript: [{ t, speaker, text }],
vendorSummary, url, status, error, analysis, attribution, writeBack,
model, usage, analyzedAt }` where `analysis` is:
```json
{
  "participants": { "rep": "", "prospect": "", "prospectEmail": null, "company": null },
  "summary": { "overview": "", "verdict": "", "didWell": [{ "title": "", "detail": "" }], "costTheClose": [{ "title": "", "detail": "" }], "nextSteps": [""] },
  "outcome": "follow_up", "outcomeEvidence": "",
  "leadQuality": { "score": 88, "max": 100, "label": "Exceptional", "factors": [{ "id": "authority", "name": "", "max": 15, "points": 15, "evidence": "" }], "rationale": "", "closeProbability": 78, "pattern": { "name": "", "implication": "" } },
  "repScorecard": { "scorecardId": "high-ticket", "scorecardName": "", "total": 38, "max": 50, "criteria": [{ "id": "", "title": "", "max": 10, "points": 8, "evidence": "", "coaching": "" }], "summary": "" },
  "buyingLanguage": { "temperature": "hot", "mindset": "", "signals": [{ "quote": "", "kind": "commitment", "note": "" }] },
  "objections": [{ "objection": "", "handled": true, "howHandled": "", "better": "" }],
  "prospect": { "demographics": { "role": "", "businessType": "", "ageRange": "", "location": "", "revenueRange": "" }, "psychographics": [""], "painPoints": [""], "desires": [""], "language": [""] },
  "avatar": { "id": "av_x", "name": "", "confidence": 84, "proposedNew": null }
}
```

## View states
The view renders every state the runner can hand it: fresh · stale
(`{ ...data, stale: true, skipped }` → "showing the previous result") ·
bare `{ skipped }` · `{ error }` · `null` / `{}`. It never throws. On live
accounts it re-pulls the index through `ctx.api('/api/calls')` so calls
that arrived since the last refresh appear without a Refresh.

## Rules honoured
- Ratios (close rate, hot share, avg rep %) are re-derived from counts in
  `rollup.js`, shared by view, demo and server; money via `ctx.fmt`.
- Every data string goes through `ctx.esc`; the model's numbers are clamped
  and totals re-derived server-side (`normalizeAnalysis`), never trusted.
- Errors land inside the block / on the call; a missing block renders an
  empty state; `server.js` returns the previous rows (marked stale by the
  runner) when the index is unavailable.
- Keys (model, Fathom, Fireflies) are AES-256-GCM encrypted like HYROS keys
  and never reach the browser; webhook deliveries are signature-verified.

## Porting notes
Another fork of this app installs the folder and needs the core routes this
fork adds: `api/_llm.js`, `api/_analysis.js`, `api/_calls.js`,
`api/_kb.js`, `api/_integrations.js`, `api/_analyze.js`, `api/calls.js`,
`api/kb.js`, `api/integrations.js`, `api/ingest.js`, the `callIntel` hand-off
in `api/refresh.js` → `api/_snapshot.js`, the three routes added to
`ACCOUNT_SCOPED` in `public/app.js`, and the `functions` entries in
`vercel.json`. A different app must produce the block above and can reuse
`view.js`, `rollup.js` and `style.css` unchanged; the Setup sub-tab expects
`/api/kb` and `/api/integrations` with the shapes in those files.

## Open limitations
- `hyros_add_tags_to_leads` and `hyros_create_call` request shapes are
  undocumented (FINDINGS.md "Undocumented behaviour the app relies on");
  write-back is opt-in and records its result on each call.
- Attribution needs a tracked-click lead (FINDINGS.md "Lead attribution is
  exposed — only for tracked-click leads"); calls with prospects HYROS never
  saw show "no HYROS lead".
- Google Calendar is not a transcript source; it is not integrated yet.
- Background analysis after a webhook relies on Vercel's `waitUntil`
  (Fluid compute). Without it the analysis runs before the 200, which a
  vendor may treat as a timeout and redeliver — redeliveries are deduped.
