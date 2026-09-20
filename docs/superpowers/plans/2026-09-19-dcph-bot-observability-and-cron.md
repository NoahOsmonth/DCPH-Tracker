# Plan 6 — Observability, the eval gate and cron wiring (Phase 6)

**Spec:** `docs/superpowers/specs/2026-09-19-dcph-bot-agentic-remaster-design.md` §12, Phase 6 —
"`ai_request_log` queries surfaced, eval harness wired into CI, `SYSTEM_DOCS.md` and `.env.example`
updated to match reality."

**Depends on:** Plans 1–4 (gateway, corpus/retrieval, persistence/memory, agentic pipeline) and
Plan 5 Tasks 1–7 (the UI message stream, feedback, the client view model, the rendering). Plan 5's
§9 lists exactly what this phase consumes.

**Status:** planned. Written 2026-09-20, after Plan 5 Tasks 1–7 closed. Plan 5 Tasks 8–11 (the
widget, drawer, memory panel, a11y) remain blocked on precondition P1 — the user's uncommitted
`components/chat/ChatWidget.tsx` — and are **not** part of this plan.

---

## 1. What ships

The pipeline has been writing a rich request log since Phase 1 and **nothing has ever read it**.
This phase builds the read side: a bounded, tested store over `ai_request_log` and
`ai_message_feedback`, an operator surface that renders it, and the retention policy that keeps it
from growing without bound. It also gives the golden evals their own named CI signal instead of
letting them hide inside `npm run test`, and it brings `SYSTEM_DOCS.md` and `.env.example` back in
line with what the code actually does.

Two smaller pieces close debts the earlier phases recorded and deferred to here: `report.evicted`
from `assembleMessages`, which no layer currently carries past the pipeline, and the response-cache
question, which Phase 4 §9 explicitly deferred "to Phase 6 with the log data".

Nothing in Phases 1–5 changes behaviour. The new surface is read-only except for one retention
delete, which is bounded, dry-runnable and off unless a cron explicitly runs it.

## 2. Global constraints

1. **Free tiers only, still.** This phase adds no model call and no provider. The observability
   surface is SQL through the service-role client, and the eval gate runs offline.
2. **`service_role` is server-only, and internal tables stay unreachable from a browser.**
   `ai_request_log` and `ai_message_feedback` both have RLS enabled with no policies; every read
   here goes through `createAdminClient()`. The operator surface is gated on the `admin` role or on
   `CRON_SECRET`, never on being signed in.
3. **`CRON_SECRET` is sent via `Authorization: Bearer` only — never in a query string.** That rule is
   already stated in `app/api/sync/route.ts` and is restated here because this phase adds routes
   that a cron calls.
4. **Every query is bounded.** A window parameter is capped, a row limit is capped, and no query is
   unbounded by default. An observability surface that can table-scan a growing log is a
   denial-of-service on its own database.
5. **Migrations are additive only.** This phase adds **no** migration: the log has carried
   `plan_source`, `tools` and `citations_valid` since `20260919130000`, and feedback has its table
   since `20260919140000`. Retention deletes rows, not schema, and is not a migration.
6. **The evals are the quality gate, and they must stay offline.** `lib/__tests__/retrieval-eval.test.ts`
   and `lib/__tests__/pipeline-eval.test.ts` touch no database, no network, no model and no timer.
   The CI step this phase adds runs exactly those files and nothing else.
7. **A green suite must stay green.** Every task's gate is the full suite (both vitest projects),
   `tsc`, lint and build, exactly as Plans 4 and 5 ran them.
8. **Tests never touch a network, a database, a model or a real timer.** The store is a port with an
   injected client, as `lib/ai/feedback/store.ts` and `lib/ai/memory` already are.
9. **No new npm dependency.** No observability vendor, no metrics library, no chart library.
10. **The in-flight workstream is not swept.** `components/chat/ChatWidget.tsx` and the nine files
    staged with it belong to the user. This phase touches none of them; if a task needs one, it
    stops and reports.
11. **Git discipline.** `git add -- <paths>` then `git commit --only -m "..." -- <paths>`. Never
    `git add -A`, never `git commit -a`, never `--amend`.
12. **Style.** No semicolons, double quotes, 2-space indent.

## 3. Baseline at the start of this plan

Verified at Plan 5 Task 7's close (`5146632`):

- **Tests:** 1,345 / 84 files (node 1,250 / 79, dom 95 / 5). The node count includes the user's
  untracked `lib/__tests__/characters-graph-engine.test.ts` (7 tests) from another workstream.
- **Gates:** `npx tsc --noEmit` exit 0; `npm run lint` 0 errors / 14 pre-existing warnings;
  `npm run build` succeeds with four `/api/ai-chat*` routes; `/community/chat` first load 110 kB.
- **Evals:** retrieval 0.9833 (59/60) and pipeline-level 1.0000 (60/60), both gating at
  `RECALL_GATE` (0.85) from inside `npm run test`.
- **The log is write-only.** `ai_request_log` is written by `lib/ai/request-log.ts` and read by
  nothing. Nineteen columns: `id`, `user_id`, `conversation_id`, `target_id`, `outcome`, `plan_ms`,
  `retrieve_ms`, `ttft_ms`, `total_ms`, `attempts`, `doc_count`, `cache_hit` (always `false` — see
  D6), `degraded_reason`, `prompt_tokens`, `completion_tokens`, `created_at`, plus Phase 4's
  `plan_source`, `tools` and `citations_valid`. Two indexes exist: `(created_at desc)` and
  `(user_id, created_at desc)`, which is what makes a windowed read bounded.
- **`ai_message_feedback`** exists (migration committed, **not applied**) with `message_id`,
  `user_id`, `value` (`1`/`-1`), `note`, `created_at`, and `forMessages(ids)` already written for
  this phase.
- **`report.evicted`** is produced by `assembleMessages` and read by nobody: `PipelineResult` does
  not carry it, so the route cannot send it and the UI cannot render it.
- **Cron:** `vercel.json` declares two entries, both hitting `/api/sync`. `CRON_SECRET` is verified
  by a private `headerMatchesSecret` inside `app/api/sync/route.ts` — the only copy in the repo.
- **CI:** `.github/workflows/ci.yml` runs typecheck, lint, `npm run test` and build, with build-time
  placeholder Supabase env vars and a comment that the `.next/` output must never be deployed.
- **`app/admin.tsx`** is a 24-line stub. `app/api/admin/route.ts` is the admin-role gate pattern:
  `isSameOrigin` → rate limit → `getUser()` → `profiles.role === "admin"`.

## 4. Architecture of the new path

```text
operator (browser)                          cron (Vercel)
  GET /admin/ai  (server component)           GET /api/admin/ai-observability
      │ admin role in profiles                    │ Authorization: Bearer CRON_SECRET
      └──────────────┬──────────────────────────────┘
                     ▼
        lib/ai/observability/store.ts          the read side, bounded
          summary({ sinceMs, untilMs })          counts by outcome / degraded_reason /
          recent({ limit, cursor })              plan_source, latency, citation rate
          └─ createAdminClient()  ── SQL ──►  ai_request_log
        lib/ai/feedback/store.ts forMessages() ►  ai_message_feedback

  GET /api/admin/ai-retention                cron, CRON_SECRET, dry_run default
      └─ delete rows older than RETENTION_DAYS, bounded per run

  npm run test:eval  →  the two golden evals, own CI step, prints the measured numbers
```

Three properties this shape exists to keep:

1. **One read side, two callers.** The admin page and the cron route call the same store, so the
   number a human reads and the number a machine reads cannot disagree.
2. **The store owns the bounds.** The window, the row limit and the retention age are constants in
   one module, not parameters a caller can widen.
3. **Reads never change behaviour.** Nothing in this phase is on the answer path; a failure in any
   of it must be invisible to a chat request.

## 5. Deviations and decisions taken here

**D1 — A server component, not a client fetch, for the operator page.** `app/admin/ai/page.tsx`
reads the store directly with the service-role client after checking the admin role. A client
component fetching an API route would add a round trip, a loading state and a second place the auth
check could be forgotten. The JSON route exists for the cron and for any future tooling, not for the
page.

**D2 — Admin role *or* `CRON_SECRET`, and the secret wins no privileges.** The route accepts either,
because a cron has no session. The secret is compared in constant time against a SHA-256 digest of
the header, exactly as `app/api/sync/route.ts` does, and never read from a query string. The two
paths are otherwise identical — the secret does not unlock a wider query.

**D3 — Retention deletes, and it is the only write in this phase.** `ai_request_log` grows one row
per chat request forever. A bounded, `dry_run`-by-default delete of rows older than a configurable
age is the honest fix; the alternative — an unbounded table on a free-tier database — is how the
observability feature becomes the outage. `ai_message_feedback` is **not** pruned: it is small
(one row per message per user) and it is the quality signal, which is the thing worth keeping.

**D4 — The eval gate is a separate named CI step, not a new test file.** The evals already run
inside `npm run test` and already fail the build on a regression. What they do not do is *show their
number*, so a slow erosion toward the gate is invisible in the log. The step runs the same two files
through a `test:eval` script and prints the measured recall, and the suite keeps its own copy of the
assertion so the gate cannot be removed by deleting a CI line.

**D5 — `report.evicted` is plumbed, not recomputed.** The pipeline already computes which documents
were dropped; this phase carries it out (`PipelineResult.evicted`) and renders it in the activity
trace's expanded view. Recomputing it anywhere would be a second answer to the same question. The
protocol field is **optional and additive**, so `PROTOCOL_VERSION` does not move — `protocol.ts`'s
own rule is that the version bumps when a payload changes shape, not when an optional field appears.

**D6 — The response cache stays unimplemented, and that is the Phase 6 answer.** Phase 4 §9 deferred
the decision here. The evidence for caching would be a log showing the same question asked
repeatedly within a short window; the log has never been read and the deployed project has none of
the `20260919*` migrations applied, so there is no such evidence and inventing a cache now would be
a correctness risk (stale answers, per-user data in a shared entry) bought with no measured need.
The decision is recorded in `SYSTEM_DOCS.md` with the trigger that would reopen it, and Task 6
carries it out. Note that **`ai_request_log.cache_hit` already exists** (`20260919090000` defines it
`boolean not null default false`) and nothing ever sets it, so a future cache needs no migration —
only the code that would write it. Task 6 must say that, not claim the column was skipped.

**D7 — No chart library, no new palette.** The operator page renders numbers and short tables in the
existing tokens. A sparkline is not worth a dependency (constraint 9).

## 6. Task index

| # | Task | Files | Commit |
| --- | --- | --- | --- |
| 1 | The named eval gate | `package.json`, `.github/workflows/ci.yml`, the two eval tests | `test(ai): give the golden evals their own CI gate` |
| 2 | The request-log read side | `lib/ai/observability/store.ts` + test | `feat(ai): read the request log` |
| 3 | The operator surface | `app/admin/ai/page.tsx`, `app/api/admin/ai-observability/route.ts` + tests | `feat(admin): surface the AI request log` |
| 4 | Surface `report.evicted` | `lib/ai/pipeline/assemble.ts`, `index.ts`, `lib/ai/stream/protocol.ts`, `app/api/ai-chat/route.ts`, `components/chat/ActivityTrace.tsx` + tests | `feat(ai): carry evicted evidence to the reader` |
| 5 | Cron wiring and retention | `lib/cron-auth.ts` + test, `app/api/admin/ai-retention/route.ts` + test, `app/api/admin/ingest-corpus/route.ts`, `app/api/sync/route.ts`, `vercel.json` | `feat(admin): wire the AI crons and log retention` |
| 6 | Documentation and the cache decision | `SYSTEM_DOCS.md`, `.env.example` | `docs(ai): document the observability surface` |

---

### Task 1 — The named eval gate

**Files:** `package.json`, `.github/workflows/ci.yml`, `lib/__tests__/retrieval-eval.test.ts`,
`lib/__tests__/pipeline-eval.test.ts`

1. `package.json` gains `"test:eval": "vitest run lib/__tests__/retrieval-eval.test.ts
   lib/__tests__/pipeline-eval.test.ts"`. It is a *narrowing* of `npm run test`, not a replacement:
   the suite still runs both files (constraint 6, D4).
2. Both eval files print their measured value as a single line a CI log shows —
   `retrieval recall@5 0.9833 (59/60) ≥ 0.85` and the pipeline equivalent — and keep the existing
   `expect(...).toBeGreaterThanOrEqual(RECALL_GATE)` assertion unchanged. The print must come from
   the test that already computes the number, never from a second computation.
3. `.github/workflows/ci.yml` gains a step named **"Eval gate (recall)"** running `npm run test:eval`
   after "Test", with a comment naming what it protects (the retrieval and pipeline evals are the
   quality gate; the step exists so their number is visible).
4. A guard test asserts the two eval files are the ones `test:eval` names, so renaming an eval file
   cannot silently leave the CI step running nothing.

**Rule:** the step must not need a database, a network or a secret. It runs with the workflow's
existing placeholder env vars and nothing else.

**Commit:** `test(ai): give the golden evals their own CI gate`
**Delta:** `package.json` + `ci.yml` + 2 eval files, +1 guard test.

---

### Task 2 — The request-log read side

**Files:** `lib/ai/observability/store.ts` (new) + `lib/__tests__/observability-store.test.ts`

1. A port + a Supabase adapter with an **injected structural client** + a policy layer, in the shape
   `lib/ai/feedback/store.ts` already establishes. The port is a faithful view of the table; the
   policy layer owns the bounds.
2. `summary({ sinceMs, untilMs })` answers the operator's questions from one window:
   request count, counts by `outcome`, counts by `degraded_reason` (null as its own bucket),
   counts by `plan_source`, `citations_valid` true/false/null counts, and latency from
   `retrieve_ms` / `ttft_ms` / `total_ms` (count, and the values needed for a p50/p95 — compute the
   percentile in the policy layer from a bounded sample rather than inventing a SQL percentile).
3. `recent({ limit })` returns the newest rows, bounded by a constant, with the fields the operator
   page shows. No unbounded read exists.
4. `feedbackSummary({ sinceMs, untilMs })` joins the quality signal: counts of up/down votes in the
   window, via `ai_message_feedback`. It reads the table directly (a `forMessages` round trip would
   need message ids this surface does not have); the read is bounded by the same window.
5. Every bound is a named constant in this module: the default window, the maximum window, the
   recent-row limit, the percentile sample cap. A caller cannot widen one.
6. A failure throws with the `[ai-observability] <method>: <message>` prefix, matching
   `lib/ai/feedback/store.ts`'s `[ai-feedback]` convention, so a log line names the query that failed.

**Rule:** no test constructs a real Supabase client; the injected fake records the calls so a test
can assert the bounds were applied.

**Commit:** `feat(ai): read the request log`
**Delta:** +1 module, +1 test file, ~14–18 tests.

---

### Task 3 — The operator surface

**Files:** `app/admin/ai/page.tsx` (new), `app/api/admin/ai-observability/route.ts` (new) +
`app/admin/__tests__/ai-observability.test.ts` or a route test, plus whatever the existing admin
tests' shape requires

1. **The route** (`GET /api/admin/ai-observability`) accepts a `since`/`until` window (ISO or epoch
   ms, validated and clamped to the store's maximum) and answers `{ summary, recent, feedback }`.
   Auth is **admin role or `CRON_SECRET`** (D2): `isSameOrigin` → rate limit → either a constant-time
   `Authorization: Bearer` match or a `profiles.role === "admin"` check → 401/403. The secret path
   and the session path return the same shape.
2. **The page** (`/admin/ai`) is a server component: it resolves the session, checks the `admin`
   role exactly as `app/api/admin/route.ts` does, renders the summary (counts, latency, citation
   rate, feedback split) and the recent-rows table, and returns the honest empty state when the log
   is empty — which is the deployed project's real state today, since none of the `20260919*`
   migrations are applied. **A missing table must render as "the log is not available yet", not as a
   crash**: the page catches the store's failure and says so.
3. Nothing on this surface is reachable by a signed-in non-admin, and the page says what it is
   showing in one sentence (the window, and that the numbers come from `ai_request_log`).
4. Reuse `components/ui/card.tsx`, `badge.tsx`, `separator.tsx`. No chart library (D7).

**Rule:** the operator page must not import a client component that fetches; it renders server-side
from the store (D1).

**Commit:** `feat(admin): surface the AI request log`
**Delta:** +1 page, +1 route, +1–2 test files, ~12–16 tests.

---

### Task 4 — Surface `report.evicted`

**Files:** `lib/ai/pipeline/assemble.ts`, `lib/ai/pipeline/index.ts`,
`lib/ai/stream/protocol.ts`, `app/api/ai-chat/route.ts`, `components/chat/ActivityTrace.tsx`, plus
their tests

1. `PipelineResult` gains `evicted: string[]` — the ids `assembleMessages`'s report already names,
   carried out unchanged (D5). Empty array when nothing was evicted, never `null`: "nothing was
   evicted" is a fact, not an absence.
2. `assembleMessages`'s existing report is the only source. No stage recomputes it, and
   `degraded: "evidence_evicted"` keeps its current meaning (a non-empty eviction sets it, as today).
3. `ActivityPart` gains an **optional** `evicted?: string[]`. `PROTOCOL_VERSION` stays `1`: an
   optional field is not a shape change (`protocol.ts`'s own rule), and an older client ignores it
   because it reads only the fields it knows. `buildActivityPart` includes it only when non-empty.
4. `ActivityTrace`'s **expanded** view lists the evicted ids in one line ("3 sources did not fit:
   …"), and the collapsed line is unchanged. An empty list renders nothing.
5. The route sends what the pipeline produced — no re-derivation, no new measurement.

**Rule:** this is a carry, not a feature. If any layer needs a second computation to produce the
list, the design is wrong and the task stops.

**Commit:** `feat(ai): carry evicted evidence to the reader`
**Delta:** 5 modified files, ~8–12 tests.

---

### Task 5 — Cron wiring and retention

**Files:** `lib/cron-auth.ts` (new) + `lib/__tests__/cron-auth.test.ts`,
`app/api/admin/ai-retention/route.ts` (new) + `app/api/admin/ai-retention/route.test.ts`,
`app/api/admin/ingest-corpus/route.ts`, `app/api/sync/route.ts`, `vercel.json`

1. `lib/cron-auth.ts` exports the constant-time `headerMatchesSecret(authorization, secret)` that
   `app/api/sync/route.ts` currently keeps private, plus a `cronSecret()` reader. `sync/route.ts`
   imports it instead of holding its own copy, and its existing tests are the regression proof that
   the extraction changed nothing. The digest comparison is preserved byte for byte: fixed-width
   SHA-256 digests, `crypto.timingSafeEqual`, and never a query-string read (constraint 3).
2. `GET /api/admin/ai-retention` deletes `ai_request_log` rows older than the retention age, in
   bounded batches, and **defaults to `dry_run=true`** — a caller must ask for the delete
   explicitly (`?dry_run=false`), and the response says which mode ran and how many rows it would
   or did remove. Auth is `CRON_SECRET` only; an admin session cannot delete log rows.
   `ai_message_feedback` is not touched (D3).
3. The retention age is a named constant with an env override read at request time
   (`AI_LOG_RETENTION_DAYS`, default 90), documented in `.env.example` by Task 6. An unparseable or
   out-of-range value falls back to the default rather than to zero.
4. `vercel.json` gains the cron entries: the retention sweep, and a corpus refresh. Both are GET-able
   by a cron, both read `CRON_SECRET` from the header, and the schedules are chosen off-peak and
   documented in `SYSTEM_DOCS.md`. **Do not change or remove the two existing `/api/sync` entries.**
5. **`/api/admin/ingest-corpus` is POST-only, and a Vercel cron issues GET** — so the corpus refresh
   needs a GET entry point. Add a `GET` handler to that same route file that reads `CRON_SECRET` and
   calls the same implementation the POST handler uses; do **not** change the POST handler's
   behaviour or its admin path, and do not turn the GET into an unauthenticated alias. The existing
   ingest tests stay green unchanged, and a new test pins that GET requires the secret and that POST
   still works as it did. This is an addition to an existing route, not a rewrite of it.
6. The retention route's own name and shape are the model: a `dry_run` default, a bounded batch, and
   a response that says what ran.

**Rule:** no test executes SQL or hits a route over HTTP. The retention route's tests inject the
store; `cron-auth`'s tests are pure.

**Commit:** `feat(admin): wire the AI crons and log retention`
**Delta:** +1 lib +1 route +2 test files, `sync/route.ts` reduced, `vercel.json` +2 entries.

---

### Task 6 — Documentation and the cache decision

**Files:** `SYSTEM_DOCS.md`, `.env.example`

1. A **"AI observability"** section in `SYSTEM_DOCS.md`: what `ai_request_log` carries (all
   thirteen columns, with the three Phase 4 added), what the store's queries answer and their bounds,
   the operator surface and its two auth paths, the retention policy and its default age, the cron
   entries and their schedules, and the eval gate with the measured numbers and the gate value.
2. `.env.example` gains `AI_LOG_RETENTION_DAYS` (default 90, meaning, and that an invalid value
   falls back to the default), and anything else this phase introduced — each with a comment naming
   its default and its meaning. Existing entries stay.
3. The **cache decision** (D6) recorded plainly: not implemented, why (no measured need; the
   correctness risk of stale and cross-user answers), and the trigger that would reopen it (the log
   showing repeated identical questions inside a short window). State that the log's `cache_hit`
   column **already exists and is always `false`**, so a future cache needs no migration — and that
   nothing in this phase writes it.
4. The migration status restated: `20260919130000` and `20260919140000` are committed and **not
   applied**; the manual verification SQL for both; and that no test executes SQL.
5. State what is **not** covered yet: Plan 5 Tasks 8–11 (the widget, drawer, memory panel, a11y) and
   Plan 5 Task 12 (the chat UI documentation) are pending precondition P1, so the chat surface's own
   documentation is not in this section.
6. No test count change.

**Commit:** `docs(ai): document the observability surface`
**Delta:** documentation only.

---

## 7. Risks recorded while planning

| Risk | Why it is real | Mitigation |
| --- | --- | --- |
| An unbounded log query tables-scans a growing table | `ai_request_log` gains a row per request and has no retention before Task 5 | Every bound is a constant in the store (Task 2); the window and row limit are clamped, never passed through |
| Retention deletes more than intended | A delete against a live table with a wrong age or no bound | `dry_run` default, bounded batches, `CRON_SECRET`-only, a named constant with a validated override, and `ai_message_feedback` explicitly out of scope |
| The operator surface leaks another user's data | The log carries `user_id`, and a non-admin who guesses the URL would read it | Admin-role-or-secret on both surfaces, with the same check `app/api/admin/route.ts` uses; the store is service-role only |
| Extracting `headerMatchesSecret` weakens the cron check | It is the only guard on the sync crons | The comparison is moved byte for byte, not rewritten; `sync/route.ts`'s existing tests are the regression proof |
| The eval gate becomes a second, weaker copy of the assertion | A CI-only check invites removing the in-test gate | The suite keeps its own `expect(...)` (D4); the CI step adds visibility, not the gate |
| Plumbing `report.evicted` drifts from the pipeline's report | Two computations of one fact | The carry is the only path; a task that needs a second computation stops (Task 4's Rule) |
| The admin page crashes where the migrations are not applied | The deployed project has no `ai_request_log` table today | The page catches the store's failure and renders "not available yet" (Task 3) |

## 8. Completion criteria

1. `npm run test:eval` exists, runs exactly the two golden evals, prints both measured numbers, and
   is a named CI step; the full suite still runs both files with their `RECALL_GATE` assertions.
2. `lib/ai/observability/store.ts` answers a summary, a bounded recent list and a feedback summary,
   with every bound a constant, proven by a test that asserts the bounds reached the query.
3. `/api/admin/ai-observability` answers both auth paths with the same shape, clamps the window, and
   rejects a non-admin session and a wrong secret.
4. `/admin/ai` renders the summary and the recent rows for an admin, and the honest empty state where
   the log is absent — never a crash.
5. `report.evicted` reaches the reader: `PipelineResult.evicted`, an optional `ActivityPart.evicted`,
   and the trace's expanded line, with `PROTOCOL_VERSION` still `1`.
6. `/api/admin/ai-retention` defaults to `dry_run`, requires `CRON_SECRET`, deletes only
   `ai_request_log`, and reports what it would do.
7. `lib/cron-auth.ts` holds the only `headerMatchesSecret`, and `sync/route.ts` imports it.
8. `vercel.json` has the two new entries and still has its two `/api/sync` entries unchanged; the
   corpus-refresh entry can actually be called by a cron, which means `/api/admin/ingest-corpus`
   answers GET behind `CRON_SECRET` while its POST path is unchanged.
9. `SYSTEM_DOCS.md` documents the log's columns, the queries and their bounds, the operator surface,
   retention, the crons, the eval gate and the cache decision; `.env.example` names every variable
   this phase added.
10. No migration is added by this phase; `20260919130000` and `20260919140000` are still described
    as committed and not applied.
11. Gates green at every task's close: full suite (both projects), `tsc` exit 0, lint 0 errors,
    build succeeds with the four `/api/ai-chat*` routes.
12. The in-flight workstream is untouched: `ChatWidget.tsx`'s worktree still matches its index, and
    the nine staged files are still staged.

## 9. What remains after this phase

- **Plan 5 Tasks 8–11** — the widget rebuilt on `useChatStream`, the conversation drawer, the memory
  panel, and the accessibility/keyboard/mobile pass. All blocked on precondition P1: the user must
  commit `components/chat/ChatWidget.tsx` before any of them can edit it.
- **Plan 5 Task 12** — the chat UI documentation (transport, view model, citation contract as the UI
  sees it, feedback ownership, the drawer and memory panel, the accessibility properties). It
  documents Tasks 8–11, so it follows them.
- **`AI_PIPELINE=v1`** stays the rollback, unchanged by this phase: the parts the UI receives change
  with it, and the UI needs no switch of its own.
