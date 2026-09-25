# Features — the plug-and-play contract

A **feature** is one tab of the dashboard, shipped as one folder under
`public/features/<id>/`. The core app knows nothing about individual
features: it reads `public/features/registry.js`, loads each folder, mounts
a tab and a section, runs each feature's server step during refresh, and
hands the feature a `ctx` object to render with. A feature folder can be
zipped, moved to another fork of this app (or any app that produces the
same block shape), and installed with one command.

```
public/features/<id>/
  feature.json   manifest (required)
  view.js        export render(ctx)         — the tab (required)
  demo.js        export demo(snapshot)      — the Demo account block (required unless mode: live)
  server.js      export build(ctx)          — the live data step run by /api/refresh (live/both)
  style.css      feature-scoped styles      — optional (manifest "style": true)
  SPEC.md        the portable spec          — required
```

Registry: `public/features/registry.js`
```js
export const FEATURES = ['funnel', 'adltv', 'scale', 'health'];   // tab order
```
Remove an id to unplug a feature without deleting it. Folders whose name
starts with `_` are ignored (`_template`).

## feature.json

| field | type | meaning |
|---|---|---|
| `id` | string | folder name; `^[a-z][a-z0-9-]{1,30}$`; the snapshot key (`snapshot[id]`) |
| `name` | string | human name (spec, errors) |
| `tab` | string | tab label |
| `version` | semver | bump on every change to the block shape |
| `description` | string | one sentence, shown as the tab tooltip |
| `mode` | `demo` \| `live` \| `both` | `demo`: tab only on the Demo account. `live`: only on real accounts. `both`: wherever the block exists |
| `demo` | boolean | `demo.js` present (required for `demo`/`both`) |
| `server` | boolean | `server.js` present — runs during refresh (**required for `live`/`both`**, see below) |
| `style` | boolean | `style.css` present — linked when the feature loads |
| `needs` | string[] | snapshot paths the view requires, e.g. `["ranges.30d"]`; the tab hides when one is missing. `needs` only ever *hides* a tab — it never shows one |
| `tools` | string[] | MCP tools `server.js` calls; the conformance check enforces the list (stub run + every `callTool('…')` string literal) |
| `author` | string | who to ask |

**When a tab shows.** A tab is visible when `snapshot[id]` exists **and**
every `needs` path resolves, filtered by `mode` (demo-only on the Demo
account, live-only on real accounts). On a real account only `server.js`
produces `snapshot[id]`, so a `live`/`both` feature without `"server":
true` could never appear — `validateManifest` rejects it. A live tab that
only reads the core snapshot still ships a `server.js`; it can return a tiny
block such as `{ built: ctx.now.toISOString() }`.

## The block

`snapshot[<id>]` is the feature's whole world. `server.js` produces it for
real accounts; `demo.js` produces it for the Demo account. **Same shape,
one view.** Document the shape in `SPEC.md` — that is the porting contract.

Conventions inside a block:
- `{ error: "message" }` when the step failed entirely; `errors: []` for
  partial problems; `{ skipped: "time budget" }` when there was no time.
- **The four states a view receives** (plus `null` when the snapshot has
  no block at all). Views must render all of them and never throw:

  | state | block | what the view says |
  |---|---|---|
  | fresh | `{ ...data }` | the data |
  | stale | `{ ...data, stale: true, skipped: "time budget" }` | the data, labelled as from a previous refresh (`fmt.datetime` of the block's own time — `checkedAt` or `window.end`) |
  | bare skipped | `{ skipped: "time budget" }` | "skipped — nothing computed yet, hit Refresh" |
  | error | `{ error: "message" }` | the error |

  The stale state comes from the runner: when a step cannot run and the
  previous snapshot has this block, the runner keeps that block and adds
  `stale: true` next to `skipped`. **A block is reusable when it has at
  least one key other than `skipped` / `error` / `stale`** — an empty result
  such as `{ checkedAt, rows: [] }` counts as data and will be shown again.
  Return a bare marker (`{ skipped }` / `{ error }`) to opt out of reuse.
  `scripts/feature-check.mjs` renders every view against all four states
  and `{}`; a stale render must contain the word "previous".
- `ctx.previous` (in `server.js`) is the block from the last snapshot *as
  stored* — it may itself carry `stale` / `skipped` markers from a skipped
  run. Strip them before syncing incrementally from it (the template's
  `dataOf(previous)`), and never copy them into the new block.
- Dates as `YYYY-MM-DD` strings; money as plain numbers in the account
  currency; nothing pre-formatted.
- **Size.** Keep a block small — a few hundred rows, well under 200 KB of
  JSON (the conformance check fails a demo block above that). The whole
  snapshot (core + every block) is one JSON document in KV and one download
  per page load. KV rejects values above its size limit, and today a
  rejected write is **silent**: `/api/refresh` still answers `ok: true`
  with `persisted: false`, nothing is stored, and the page keeps showing
  the previous snapshot as if the refresh had not happened — so an
  oversized feature block quietly freezes the core report too. Truncate
  and say so (`errors: ['showing first 250 rows']`) rather than growing.

## view.js — `render(ctx)`

Called every time the tab is shown, the account/range changes, or demo mode
toggles. Must be idempotent: build the HTML and assign
`ctx.root.innerHTML`; wire events with `ctx.root.querySelectorAll` after.
Must tolerate `ctx.block === null` and every block state in "The block"
above (fresh / stale / bare skipped / error / `{}`) — render a status line,
never throw. Read every field with a fallback (`b.rows || []`).

`ctx`:

| key | what |
|---|---|
| `root` | the feature's `<section>` |
| `snapshot` | the whole current snapshot (core + every feature block) |
| `block` | `snapshot[id]` or `null` |
| `demo` | `true` on the Demo account |
| `account`, `range`, `level` | current account id, report range key (`today`/`yesterday`/`7d`/`30d`), report level |
| `fmt` | `money(v)`, `int(v)`, `pct(v)`, `date(iso)`, `datetime(iso)` — honours the demo "no cents" rule |
| `esc(s)` | HTML-escape — use on every data string |
| `kpis(list)` | KPI tiles HTML: `[{ label, value, sub?, cls?: 'good'\|'bad' }]`; wrap in `<div class="kpis">`. `label`, `value` and `sub` are rendered as **escaped text** (no HTML inside them; pass data strings as-is) |
| `formatCell(col, value)` | the report's metric formatter (for catalog metrics) |
| `note(msg, isErr)` | the report-page notice bar |
| `openJourney(email)` | open the lead journey drawer for an email |
| `api(path, opts)` | password- and account-scoped fetch to this app's own **core** routes (`/api/drill`, `/api/snapshot`…) — never HYROS. Features cannot add routes (`api/` is off-limits), so this is for reusing what the core already serves; a feature's own live data arrives only through `server.js` during refresh |
| `selectView(id)` | switch tabs |
| `manifest` | this feature's manifest |

Shared markup kit (already styled): `.note`, `.kpis`/`.kpi`, `.fpanel` +
`h3` + `.fhint`, `.fcols` (2-up grid), `.fshare` bars, `.pill` (`.ok`,
`.bad`, `.stage`, `.warn`), `.clip.clip-l`, `.empty`, `.sub`, `.good`/`.bad`
text. Prefix feature-specific classes with the feature id. Colors and fonts
come from the tokens in `styles.css` (`UI-STYLE-GUIDE.md`).

## demo.js — `demo(snapshot)`

Pure and deterministic: seed a generator with `rng(n)` from
`public/demo.js` (also `jitter`, `round2`, `ymd`, `daysAgo`, `pick`).
Derive the seed from the feature id (the template sums the id's char
codes) so two features never share a random stream. Read the demo snapshot
(`snapshot.ranges['30d'].levels.campaign` …) so numbers reconcile with the
report. Return the block in exactly the shape `server.js` produces. Runs in
the browser and in Node (`make-seed`, `feature-check`), so no DOM and no
`fetch`.

## server.js — `build(ctx)`

Runs inside `/api/refresh` after the core snapshot (account, ad accounts,
ranges, CRM) is built, for every feature with `"server": true`, in registry
order, within the function's remaining time budget. Each step gets a fair
share of what is left (remaining time / steps still to run; the last one
gets the rest) as its `deadline`, so an expensive step cannot starve the
ones after it. Returns the block.

`ctx`: `callTool(name, args, { timeoutMs })`, `callToolPaged(name, args,
{ maxPages, pageSize })`, `snapshot` (core, including `warnings[]` —
`{ adAccountId, name, type, level, error, kind }` with `kind` ∈
`unsupported | rate_limited | error | truncated | time budget` — and
`ranges[key].skipped` when a range was not fetched), `previous` (this
feature's block from the last snapshot, markers included — use it to sync
incrementally), `deadline`, `timeLeft()` ms, `log(step)`, `env`
(`HYROS_CAC_CEILING`, optional), `now`, and — on a runner that offers a
slow lane — `timeouts` (`{ default: 15000, slow: 45000 }` ms, optional) and
`slowTimeout(marginMs = 2000)`, which returns the slow timeout clamped to the
step deadline minus the margin (never under 1 s). Call it instead of
re-deriving the lane from `timeouts`; when a runner has no `slowTimeout`,
stay on the default lane.

`ctx.timeouts` exists for the rare call that legitimately needs longer than
the 15 s contract (Tracking Health's script check, which makes HYROS fetch
every domain live). Read it defensively: `ctx.timeouts?.slow`, capped at
`ctx.timeLeft() - 2000` so the call still ends inside the step, and use it
for ONE call per step, run last so it cannot starve the cheap ones. When
`ctx.timeouts` is absent the runner has not declared a slow lane and the
call stays on the 15 s contract — that is what the conformance stub does,
so the "≤ 15 s" check below still holds for every feature. A step that
skips or fails such a call should say so in its block (Tracking Health's
`checks.script`), not leave the tile blank.

Rules: **`ctx.timeLeft()` governs** — check it before the FIRST call and
before every call after it (a spent budget must mean zero MCP calls; the
conformance check asserts it); 10 s is the *design target* for a feature,
but the actual share can be smaller or larger, so never assume it. Catch
every error into the block; out of time before the first call → return
`previous` stripped of markers with `stale: true, skipped`, or a bare
`{ skipped }`. List every tool you call in the manifest `tools`. No Node
built-ins, no packages, no required env vars. MCP errors carry `err.code`
∈ `auth | forbidden | rate_limited | NOT_CONFIGURED | undefined`; put
`err.message` in the block, and treat `rate_limited` as "try next refresh",
not as a reason to retry inside the step.

> **MCP limits (what a server step must respect)**
> - ≤ 50 ids / emails / tags per call (`ids`, `emails`, `tags` arrays).
> - `pageSize` ≤ 250; use `callToolPaged` with `maxPages` for more.
> - Per-call `timeoutMs` ≤ 15 000; the conformance check fails a larger one.
>   The only exception is `ctx.timeouts.slow` (above), which a runner grants
>   explicitly and which the stub never does.
> - One rate limit **per HYROS account** (every key of the account shares
>   it, per endpoint) — a feature that hammers one tool slows the core
>   refresh too. ~8 calls per step is the comfortable range.
> - `accessible_account_id` (agency → client) and the API key are already
>   applied to `callTool`; never pass or read them yourself.
> - `level` values are UPPERCASE and most report tools take a `{ request }`
>   wrapper — copy the exact argument shape from a working feature.

Account context (which HYROS key, agency client id) is already applied to
`callTool` — a feature never sees keys.

## Lifecycle

```
registry.js ─► loadFeatures() ─► tab + <section id="view-<id>"> + style.css link
                                   │
refresh ─► core snapshot ─► runFeatureSteps(): server.js build() ─► snapshot[id] ─► KV
Demo   ─► buildDemoSnapshot() ─► applyDemoFeatures(): demo.js demo() ─► snapshot[id]
tab shown ─► featureVisible(manifest, snapshot) ─► view.js render(ctx)
```

A broken feature (bad manifest, import error, render throw) is contained:
the tab is skipped or shows an inline error, and the rest of the dashboard
is unaffected.

## SPEC.md — the portable idea

Every feature carries a spec so the idea can be re-implemented in another
fork even if the code cannot be dropped in. Sections (see `_template/SPEC.md`):
Purpose · Data (tools, limits, what the demo fakes) · Block shape (JSON) ·
Rules honoured · Porting notes · Open limitations (which missing MCP
capability from `FINDINGS.md` would make it fully live).

## Export / import

```
node scripts/feature-pack.mjs <id>              # -> dist/features/<id>-<version>.zip
node scripts/feature-pack.mjs --install x.zip   # -> public/features/<id>/ + registry, runs the check
node scripts/feature-pack.mjs --list
```
The zip is the folder, nothing else. Installing into another fork of this
app is enough; installing into a different app means implementing the
block shape from `SPEC.md` and reusing `view.js` + `style.css`.

## Conformance — `npm run check` → `scripts/feature-check.mjs`

Manifest validity · required files · exports · no imports of `app.js`/`api/`
· no external `fetch` · no `Math.random` in demo · `demo()` deterministic
and ≤ 200 KB · `render()` runs against the demo snapshot, a missing block,
`{ skipped }`, `{ error }`, a stale block (must say "previous") and `{}` ·
`build()` runs against a stub MCP, only calls listed tools (stub run and
`callTool('…')` literals), keeps per-call timeouts ≤ 15 s, and makes zero
calls when the budget is spent. Also `node scripts/feature-unit-test.mjs`
for the pure-function tests (curve normaliser, view states, budget rules).

## Adding a feature, step by step

1. `cp -r public/features/_template public/features/<id>`; set `id`,
   `name`, `tab`, `mode`, `tools` in `feature.json`.
2. Design the block in `SPEC.md` first. Small, flat, documented.
3. `demo.js`: produce that block from the demo snapshot.
4. `view.js`: render it. Run `node scripts/devserver.mjs`, open the Demo
   account, look at the tab.
5. `server.js` (live features): produce the same block from the MCP.
   Check `FINDINGS.md` for the tools that exist and their limits.
6. Add the id to `registry.js`; `npm run check`.
7. Bump `version` whenever the block shape changes. Nothing checks it at
   runtime — an old snapshot meets the new view until the next refresh, so
   read new fields with fallbacks for one release.

## Features that need core routes

A feature's `server.js` runs only during `/api/refresh` and cannot add
routes, but a feature may *depend* on routes its fork adds under `api/`
(the Call Intelligence tab needs `/api/calls`, `/api/kb`,
`/api/integrations` and the `/api/ingest` webhook). When that is the case:

- the feature's `SPEC.md` "Porting notes" lists every core file another
  fork must copy, and the block shape still works without them (the tab
  renders from the snapshot; live actions fail with a message);
- the core hands what the feature needs into the snapshot before the
  feature steps run (`buildSnapshot({ callIntel })` → `snapshot.callIntel`)
  so `server.js` stays a pure copy with zero MCP calls;
- new account-scoped routes are added to `ACCOUNT_SCOPED` in
  `public/app.js` so `ctx.api(path)` carries `?account=`.
