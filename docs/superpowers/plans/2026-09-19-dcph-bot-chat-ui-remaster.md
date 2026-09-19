# Plan 5 — Chat UI/UX remaster (Phase 5)

**Spec:** `docs/superpowers/specs/2026-09-19-dcph-bot-agentic-remaster-design.md` §12, Phase 5 —
"AI SDK transport, parts rendering, citations, activity, regenerate/stop/edit, feedback,
conversation drawer, memory panel, accessibility. Add a jsdom environment for component tests."

**Depends on:** Plan 1 (gateway), Plan 2 (corpus and retrieval), Plan 3 (transcripts and memory),
Plan 4 (agentic pipeline). Plan 4's §9 lists exactly what this phase consumes.

**Status:** planned, not started. Written 2026-09-20, after Plan 4's completion report.

---

## 1. What ships

The chat surface stops being a plain-text stream rendered into a bubble and becomes a *rendered
answer*: numbered citations that resolve against the evidence the server actually supplied, an
activity trace that shows what the pipeline did, sources a reader can open, stop/regenerate/edit,
thumbs feedback, a conversation drawer, a memory panel with delete, and a keyboard-and-screen-reader
path through all of it. The transport moves to the AI SDK's UI message stream so parts — not one
string — cross the wire, with Plan 1's gateway still the only model path.

Nothing in Phases 1–4 changes behaviour: the pipeline, its budgets, the screening, the citation
validator and the `AI_PIPELINE` rollback all stay. Phase 5 is a *rendering* phase with one new
storage table (feedback), one new route (feedback), and a wire-format change that both sides of the
deploy adopt together.

## 2. Global constraints

1. **Free tiers only, still.** `ai` and `@ai-sdk/react` are MIT libraries; they cost nothing and
   they talk to no provider. No `@ai-sdk/*` provider package, no second gateway, no new provider
   call. Total model calls per turn are unchanged from Plan 4's accounting.
2. **Plan 1's gateway stays the model path.** `streamChat`, the quota accounting, the circuit
   breaker, `generateStructured` and its repair ladder are untouched. The AI SDK frames the stream
   and drives the client hook; it never talks to a model.
3. **Always a whole answer.** Every failure mode still ends in text a reader can act on: the three
   synthetic strings (rate-limited, empty result, partial) keep their meaning on the new transport,
   and a stream that dies mid-answer keeps what arrived.
4. **The `[E#]` mapping is a contract, not a parsing job.** The client renders chips from the
   `EvidenceRef[]` the server sends. It must never regex the answer text — Plan 4 built the numbering
   so the two cannot drift, and the test suite pins it.
5. **`AI_PIPELINE=v1` keeps working and keeps its proof.** The route's v1 branch emits the same UI
   stream with only a text part; the UI renders that degraded shape without evidence, activity or
   chips. `app/api/ai-chat/route.integration.test.ts` stays the standing v1 regression test.
6. **Migrations are additive only.** The one new migration adds a table. No `drop`, no destructive
   `alter`, no policy or grant statement (RLS on, no policies, `service_role` only — the Plan 3
   pattern).
7. **Ownership is checked server-side on every transcript and memory read or write.** A conversation
   id from the client is a *claim*: the route resolves it against the signed-in user before a row is
   read, written or deleted, exactly as Plan 3 established.
8. **Never log a full API key; log a target id only.** Unchanged from Phases 1–4 and restated here
   because the activity UI is new surface for provider state.
9. **`NEXT_PUBLIC_*` ships to the browser.** The activity trace renders `planSource`, `toolNames` and
   timings — all non-secret — and nothing else. No provider names, no key material, no raw errors.
10. **Tests never touch a network, a database, a model or a real timer.** The jsdom project mocks
    `fetch`; component tests drive the transport with a scripted stream.
11. **The in-flight workstream is not swept.** `components/chat/ChatWidget.tsx` currently carries the
    user's uncommitted edits (with nine other files). *Precondition P1:* that file must be committed
    (or the plan rebased onto it) before any task below edits it. Tasks 1–7 do not touch it; Tasks
    8–11 do. Until P1 is satisfied, execute Tasks 1–7.
12. **No new design system.** Reuse `components/ui/*` (Radix wrappers, `cva`), the Tailwind tokens
    and `framer-motion`. No new colour palette, no new font.
13. **Motion respects `prefers-reduced-motion`.** Every animation has a reduced-motion branch.
14. **Git discipline.** `git add -- <paths>` then `git commit --only -m "..." -- <paths>`. Never
    `git add -A`, never `git commit -a`, never `--amend`.
15. **Style.** No semicolons, double quotes, 2-space indent.

## 3. Baseline at the start of this plan

Verified at Plan 4's completion (`2a8f05a`):

- **Tests:** 1,176 / 73 files committed; 1,194 / 75 in the working tree (the difference is the
  untracked `lib/__tests__/characters-graph-engine.test.ts` of another workstream, 7 tests).
- **Gates:** `npx tsc --noEmit` exit 0; `npm run lint` 0 errors / 14 pre-existing warnings;
  `npm run build` succeeds with `ƒ /api/ai-chat`, `ƒ /api/ai-chat/conversations`,
  `ƒ /api/ai-chat/memory`.
- **Evals:** retrieval 0.9833 (59/60) and pipeline-level 1.0000 (60/60), both ≥ `RECALL_GATE` 0.85.
- **The wire format is plain text** (`text/plain` stream) — Phase 4 kept it byte-compatible to this
  moment (its constraint 9).
- **The chat components:** `components/chat/ChatWidget.tsx` (13.5 KB, in flight),
  `ChatMessage.tsx`, `ChatInput.tsx`, `ChatWidgetLoader.tsx`. The widget streams with
  `response.body.getReader()` and a `TextDecoder`.
- **The test environment** is `node` only, with `include: ["**/*.test.ts"]` — no `.tsx`, no jsdom
  (`vitest.config.mts`).
- **Server contracts available to the UI** (Plan 4 §9): `PipelineResult.evidence` (`EvidenceRef[]`),
  `PipelineResult.screening`, `PipelineResult.timings` / `planSource` / `toolNames`,
  `PipelineResult.degraded`; `lib/ai/citations.ts`'s grammar and report; `assembleMessages`'s
  `report.evicted` (Phase 6's).
- **Plan 3's endpoints:** `GET`/`DELETE /api/ai-chat/conversations`, `GET`/`DELETE
  /api/ai-chat/memory`.

## 4. Architecture of the new path

```text
POST /api/ai-chat                                   app/api/ai-chat/route.ts
  guards → auth → rate limit → intent refusal → persistence → pipeline → refusal gate
  → createUIMessageStream                                lib/ai/stream/protocol.ts
        data-evidence   { refs: EvidenceRef[] }          plan 4's numbering, verbatim
        data-activity   { planSource, tools, timings }   non-secret only
        data-degraded   { reasons: string[] }            plan 4's degrade vocabulary
        text-delta      the answer, as Plan 1 streams it
        data-citations  { report: CitationReport }       after the stream (D3)
  → toUIMessageStreamResponse()

client                                              components/chat/
  useChatStream (useChat + view-model mapping)        useChatStream.ts
    ├─ ChatMessage      text + CitationChips + SourcesPanel
    ├─ ActivityTrace    stage timeline, degrade badges
    ├─ FeedbackControls POST /api/ai-chat/feedback
    ├─ ConversationDrawer  GET/DELETE /api/ai-chat/conversations
    └─ MemoryPanel         GET/DELETE /api/ai-chat/memory
```

Three properties this shape exists to keep:

1. **One stream, two audiences.** The text deltas a reader sees and the data parts the UI needs
   travel in the same response, so there is no second request, no polling, and no client-side
   parsing of prose.
2. **The server decides, the client renders.** Every fact the UI shows is a part the server chose to
   send: evidence, activity, degrade reasons, the citation report. A part the server did not send is
   not shown, so a v1 turn renders as a v1 turn.
3. **The reduced-motion and keyboard paths are structure, not polish.** The trace and the chips are
   ordinary semantic HTML with `aria` attributes; motion is decoration over working markup.

## 5. Deviations and decisions taken here

**D1 — The AI SDK frames; Plan 1's gateway answers.** `ai`'s `createUIMessageStream` /
`toUIMessageStreamResponse` (server) and `@ai-sdk/react`'s `useChat` (client) are used for framing
and transport only. The model call stays `streamChat` from `lib/ai/gateway.ts`, so quota accounting,
the breaker and the repair ladder keep working exactly as Phases 1–4 built them. The alternative —
adopting a provider package and letting the SDK drive the model call — would create a second path to
a provider that bypasses the daily budget: rejected on the free-tier constraint.

**D2 — Parts, not a custom protocol.** The data parts are the minimum the UI needs
(`evidence`, `activity`, `degraded`, `citations`) with the SDK's own `text` part carrying the answer.
A bespoke SSE dialect was the alternative; it would be a second protocol to maintain, and the spec
names the SDK's transport outright.

**D3 — Feedback is its own table.** A vote is (message, user, value, when, optional note) — a
many-per-message fact with its own ownership rule, not a column on `ai_messages` that a later
`update` could overwrite. One additive migration creates `ai_message_feedback`; the route checks
ownership against the conversation, and the row is written with the service-role client.

**D4 — jsdom is a second vitest project, not a global change.** `lib/**` and `app/**` tests keep
`environment: "node"` (with the `server-only` stub), and `components/**` tests run under jsdom with
a setup file. Making the whole suite jsdom would slow every existing test and put React's DOM in the
way of modules that must not have it.

**D5 — The three synthetic strings render as ordinary text with a state badge.** They are already
honest sentences; the remaster shows *which* state produced them (rate-limited, no result, partial)
as a badge beside the message rather than a new message shape. Their text is unchanged — the tests
that pin them stay green.

**D6 — No `?format=text` escape hatch.** The client and the route deploy together, and the SDK's
stream is the only format either side speaks. Keeping a second format alive would be a second code
path to test forever. `AI_PIPELINE=v1` is the rollback that matters, and it changes the *pipeline*,
not the transport.

**D7 — Edit resends, it does not fork.** Editing a user turn truncates the visible transcript from
that point and resends; the server already owns the transcript (Plan 3), so the fork/rollback
semantics of a client-owned history do not apply. Streaming is aborted first (the stop path).

**D8 — The activity trace is opt-in per deployment by default-on.** It is rendered collapsed: a
one-line "3 steps · 1.2 s · searched the catalog" summary that expands. The spec asks for activity;
a reader who does not care should not have to scroll past it.

**D9 — Precondition P1 is a hard gate for the UI tasks.** `ChatWidget.tsx` carries the user's
uncommitted work. Tasks 1–7 leave it alone; Tasks 8–11 may not begin until the user's edits are
committed, because "remaster the widget" and "preserve someone's uncommitted edits to the widget"
cannot both be true of the same commit.

## 6. Task index

| # | Task | Files | Commit |
| --- | --- | --- | --- |
| 1 | Dependencies, jsdom project, smoke test | `package.json`, `vitest.config.mts`, `vitest.setup.dom.ts`, `components/chat/__tests__/smoke.test.tsx` | `test(ui): add a jsdom project for component tests` |
| 2 | The UI message stream and its parts | `lib/ai/stream/protocol.ts` + test, `app/api/ai-chat/route.ts`, route tests (additive) | `feat(ai): stream the answer as message parts` |
| 3 | Feedback: table, store, route | migration, `lib/ai/feedback/store.ts` + test, `app/api/ai-chat/feedback/route.ts` + test, migration test | `feat(chat): record answer feedback` |
| 4 | The client transport and view model | `components/chat/useChatStream.ts` + test | `feat(chat): read the stream as parts` |
| 5 | Citation chips and the sources panel | `CitationChips.tsx`, `SourcesPanel.tsx` + tests | `feat(chat): render citations against the evidence` |
| 6 | Activity trace and degrade badges | `ActivityTrace.tsx` + test | `feat(chat): show what the pipeline did` |
| 7 | Message parts rendering | `ChatMessage.tsx` + test | `feat(chat): render an answer as parts` |
| 8 | Send, stop, regenerate, edit | `ChatWidget.tsx`, `ChatInput.tsx` + tests (**P1**) | `feat(chat): stop, regenerate and edit a turn` |
| 9 | Conversation drawer | `ConversationDrawer.tsx` + test, wiring (**P1**) | `feat(chat): list and reopen conversations` |
| 10 | Memory panel | `MemoryPanel.tsx` + test, wiring (**P1**) | `feat(chat): show and delete a memory` |
| 11 | Accessibility, keyboard and mobile | the chat components + tests (**P1**) | `feat(chat): keyboard and screen-reader paths` |
| 12 | Documentation and phase verification | `SYSTEM_DOCS.md`, `.env.example` | `docs(chat): document the remastered surface` |

---

### Task 1 — Dependencies, jsdom project, smoke test

**Files:** `package.json`, `vitest.config.mts`, `vitest.setup.dom.ts` (new),
`components/chat/__tests__/smoke.test.tsx` (new)

1. Add the dev dependencies the component tests need — `jsdom`, `@testing-library/react`,
   `@testing-library/dom`, `@testing-library/user-event`, and whatever the JSX transform requires
   for vitest to compile `.tsx` — and the two runtime libraries the transport uses: `ai` and
   `@ai-sdk/react`. Pin nothing exotic; use the latest versions the lockfile resolves, and commit
   `package-lock.json` in the same commit.
2. **Only `components/**` becomes jsdom.** `vitest.config.mts` gains a second project (`test.projects`
   in vitest 3) or an equivalent split: the existing node project keeps `**/*.test.ts` with the
   `server-only` stub, and a new project owns `components/**/*.test.tsx` (and `.ts` tests under
   `components/`) with `environment: "jsdom"`, a setup file, and the same `@/` alias.
3. `vitest.setup.dom.ts` — `@testing-library/jest-dom` matchers if added, `afterEach(cleanup)`, and
   deterministic stubs for what jsdom lacks and the chat UI touches (`window.matchMedia` with a
   `prefers-reduced-motion` default of "reduce", `Element.prototype.scrollIntoView`, `ResizeObserver`).
   Each stub exists because a named component reads it — no speculative stubs.
4. The smoke test renders a trivial component and asserts one matcher, so the project is proven to
   run rather than assumed.

**Rule:** the node project's behaviour is unchanged — 1,176 tests, same files, same environment.
A component test may not import `lib/ai/gateway`, `lib/env` or anything that reads a secret.

**Commit:** `test(ui): add a jsdom project for component tests`
**Delta:** +1 test file, +1 test; `package.json` and `package-lock.json` change.

---

### Task 2 — The UI message stream and its parts

**Files:** `lib/ai/stream/protocol.ts` (new) + `lib/__tests__/stream-protocol.test.ts`,
`app/api/ai-chat/route.ts`, `app/api/ai-chat/route.pipeline.test.ts` and
`app/api/ai-chat/route.integration.test.ts` (additive)

1. `protocol.ts` is the one place that names the parts, so the server and the client cannot drift:
   `PARTS = { evidence: "data-evidence", activity: "data-activity", degraded: "data-degraded",
   citations: "data-citations" }`, the payload types (`EvidencePart { refs }`, `ActivityPart
   { planSource, tools, timings }`, `DegradedPart { reasons }`, `CitationsPart { report }`), and a
   pure builder per part. Version the envelope (`PROTOCOL_VERSION = 1`) and send it once in an
   `activity` part's `protocol` field — a client that sees a version it does not know renders text
   only rather than guessing.
2. The route wraps Plan 4's pipeline result into those parts and streams Plan 1's text deltas
   through the same response. Order: activity (with the pipeline's plan facts) → evidence →
   degraded, then text, then citations after the stream settles. Every part is built from the
   `PipelineResult` — no re-derivation, no new measurement.
3. **`degraded` is the union of what Plan 4 already computes**: the pipeline's reason, the
   `screened`/`uncited` reasons the route already derives, and `retrieval_failed`. The part carries
   strings, not sentences; the client owns the wording (Task 6).
4. **v1 emits `activity` + text only** (no evidence, no citations), and the route's existing tests
   keep proving v1. `route.pipeline.test.ts` gains assertions for each part on v2 and their absence
   on v1.
5. The three synthetic strings are unchanged in text, and a turn that ends in one sends a `degraded`
   part naming its state (D5).

**Rule:** the route may not import a client component; `protocol.ts` is isomorphic and dependency-free
(types + pure functions), so both sides may import it. The answer text is never re-encoded: the
`text` part carries exactly the delta Plan 1 produced.

**Commit:** `feat(ai): stream the answer as message parts`
**Delta:** +1 module +1 test file, additive route tests.

---

### Task 3 — Feedback: table, store, route

**Files:** `supabase/migrations/20260919140000_ai_message_feedback.sql` (new),
`lib/ai/feedback/store.ts` (new) + `lib/__tests__/feedback-store.test.ts`,
`app/api/ai-chat/feedback/route.ts` (new) + `app/api/ai-chat/feedback/route.test.ts`,
`lib/__tests__/ai-message-feedback-migration.test.ts`

1. The table: `ai_message_feedback` with `id`, `message_id` (FK to `ai_messages`), `user_id`, `value`
   (a small integer restricted to `1` / `-1` by a `check`), `note text` nullable, `created_at`. RLS
   enabled, **no policies**, `revoke all from anon, authenticated` — the `20260919090000` pattern.
   Additive only. One index on `(message_id)`; one unique index on `(message_id, user_id)` so a
   second vote replaces the first rather than stacking.
2. `store.ts` is a port + a Supabase implementation with injected client, in the shape of
   `lib/ai/memory`'s stores: `record({ messageId, userId, value, note })` upserting on
   `(message_id, user_id)`, and `forMessages(ids)` for Phase 6's reporting. Ownership is checked by
   resolving the message's conversation through the caller's own rows — a message id that is not
   theirs is a 404, never a write.
3. The route accepts `POST { messageId, value, note? }`, validates the body with Zod (the Plan 1
   habit), resolves auth, checks ownership, writes, and returns `{ recorded: true, value }`. A
   missing or unowned message is `404`; a bad value is `400`; an unauthenticated caller is `401`.
4. No client code in this task: the UI arrives in Task 7.

**Rule:** no test constructs a real Supabase store or executes the migration; the migration test
reads the SQL and asserts its structure (additive, nullable-where-appropriate, RLS enabled, no
policies), exactly as `ai-request-log-migration.test.ts` does.

**Commit:** `feat(chat): record answer feedback`
**Delta:** +1 migration, +1 store, +1 route, +3 test files.

---

### Task 4 — The client transport and view model

**Files:** `components/chat/useChatStream.ts` (new) + `components/chat/__tests__/useChatStream.test.tsx`

1. One hook, one shape. `useChatStream({ conversationId })` wraps `useChat` with the route's URL and
   returns a view model: `messages` (each with `text`, `refs`, `activity`, `degraded`, `citations`,
   `state`), `status` (`idle | streaming | stopped | error`), `stop()`, `regenerate()`, `send(text)`,
   `editAndResend(messageId, text)`, and `error`. Components consume the view model, never the raw
   parts.
2. The mapping is a pure function exported for its own test: parts in, view model out. Unknown part
   types and unknown `PROTOCOL_VERSION` values are ignored, not thrown on (forward compatibility,
   Task 2's rule).
3. Each message's `state` distinguishes: streaming, complete, stopped by the reader, ended in a
   synthetic string (D5), ended with a degrade.
4. Conversation id: the hook sends the id it was given and adopts the id the server returns (Plan 3's
   behaviour — the server owns conversation resolution), so a first message creates a conversation
   and the second one continues it.

**Rule:** the hook holds no provider knowledge and no secrets; a test drives it with a scripted
stream (a `ReadableStream` of frames built by `protocol.ts`) and asserts the view model. No network.

**Commit:** `feat(chat): read the stream as parts`
**Delta:** +1 module, +1 test file, ~10–14 tests.

---

### Task 5 — Citation chips and the sources panel

**Files:** `components/chat/CitationChips.tsx`, `components/chat/SourcesPanel.tsx` (both new) +
`components/chat/__tests__/citations.test.tsx`

1. `CitationChips` renders the numbered references an answer used, from `EvidenceRef[]` and the
   citation report: a chip per cited number, the tag as its tier label (`[RET]` / `[WIKI]` /
   `[CONV]`), the document title as its accessible name, and a `title`/tooltip with the label. A
   citation the report marked `unknown` renders as a broken reference and is never silently dropped
   — the validator's honesty is visible to the reader.
2. `SourcesPanel` lists every admitted reference with its number, tag and title, and can be opened
   from a chip (the same document, highlighted) — one list, two entry points, so there is one source
   of truth for "what the model was given".
3. **The chips never parse the answer text.** A test asserts a chip set built only from the server's
   refs (the message text deliberately contains a number that no ref matches) — the contract from
   Plan 4 §9.
4. Screening stays invisible: an excluded document has no ref, so it cannot appear. A `screened`
   degrade (Task 6) is the only trace the reader sees, and it says so in words.
5. Semantic markup: a chip is a `button` inside an `ol`/`ul` of references; the panel is a
   `dialog`/`aside` with a heading and a focus trap only while modal. Keyboard reachable, Escape
   closes.

**Commit:** `feat(chat): render citations against the evidence`
**Delta:** +2 components, +1 test file, ~12–16 tests.

---

### Task 6 — Activity trace and degrade badges

**Files:** `components/chat/ActivityTrace.tsx` (new) + `components/chat/__tests__/activity.test.tsx`

1. Collapsed by default (D8): one line, e.g. "2 steps · 1.4 s · searched the catalog, looked up a
   character", where the step names come from `toolNames` and the duration from `timings`. Expanded,
   it lists each stage's measurement the server sent — never a value the client computed from
   wall-clock.
2. The wording for each degrade reason lives here as one table:
   `pipeline_failed`, `corpus_unavailable`, `corpus_static`, `execute_budget`, `ladder_failed`,
   `tool_failed`, `retrieval_budget`, `evidence_evicted`, `screened`, `uncited`, `retrieval_failed`.
   A reason with no table entry renders a neutral "degraded" badge and is *reported by name* rather
   than hidden — a new server reason must be visible before it is explained.
3. `planSource` renders as the planning path (`router` / `model` / `fallback`), with the fallback case
   worded so it does not read as an error.
4. No provider name, no key, no raw error text (constraint 9).

**Commit:** `feat(chat): show what the pipeline did`
**Delta:** +1 component, +1 test file, ~10–12 tests.

---

### Task 7 — Message parts rendering

**Files:** `components/chat/ChatMessage.tsx` + `components/chat/__tests__/chat-message.test.tsx`

1. `ChatMessage` renders the view model: the answer text (with the existing markdown treatment, if
   any, preserved), `CitationChips` under it when refs exist, `ActivityTrace` when activity exists,
   `SourcesPanel` on demand, and the feedback controls (thumbs against Task 3's route) once the
   message is complete — never while streaming.
2. A stopped message says so; a message that ended in a synthetic string shows its state badge (D5)
   with the text unchanged; a `degraded` message shows the badge from Task 6.
3. Feedback is optimistic with a rollback on failure, and a second vote replaces the first (the
   unique index in Task 3 is the server's guarantee; the client must not need a reload to show it).
4. **The v1 shape renders**: a message with text and nothing else must look finished, not broken — an
   explicit test, because that is what `AI_PIPELINE=v1` produces.

**Commit:** `feat(chat): render an answer as parts`
**Delta:** 1 modified component (additive), +1 test file, ~12 tests.

---

### Task 8 — Send, stop, regenerate, edit (**P1**)

**Files:** `components/chat/ChatWidget.tsx`, `components/chat/ChatInput.tsx` + their tests

1. The widget is rebuilt around `useChatStream` (Task 4) — this is the task that satisfies the
   remaster for the send path, and the one that cannot start before P1 (D9).
2. Stop: aborts the stream, keeps the partial answer, marks the message stopped, and offers
   regenerate. The server-side abort already exists (Plan 4's shared request budget).
3. Regenerate: resends the last user turn, replacing the last assistant message. The transcript
   consequence is Plan 3's concern; the client sends the same request shape it always did, with the
   conversation id.
4. Edit: truncates from the edited turn in the UI, then sends; the server's transcript is rewritten
   by the normal write path, not by a client-supplied history (D7).
5. `ChatInput` keeps its Web Speech input and gains: Enter to send, Shift+Enter for a newline, an
   Escape-to-stop while streaming, and a disabled send while the input is empty.
6. The optimistic user message appears immediately; the assistant message appears as a streaming
   placeholder rather than after the first delta.

**Commit:** `feat(chat): stop, regenerate and edit a turn`
**Delta:** 2 modified components, 2 test files, ~14 tests. Requires P1.

---

### Task 9 — Conversation drawer (**P1**)

**Files:** `components/chat/ConversationDrawer.tsx` (new) + test, wiring in `ChatWidget.tsx`

1. A drawer listing the signed-in user's conversations from `GET /api/ai-chat/conversations` (no
   query string; the store's own 30-newest ordering, archived rows excluded), with the title the
   server stores, a relative time, and the active one marked. Selecting one loads its transcript
   through `GET /api/ai-chat/conversations?id=<uuid>` — the same endpoint, whose scoped read is the
   ownership check — and replaces the in-place transcript. That read is capped at 200 messages and
   ordered oldest-first, so the drawer must render what it gets rather than assume a full history.
2. Archive through `DELETE /api/ai-chat/conversations` with a confirmation step, optimistic removal,
   and the undo affordance the existing UI language uses (a toast, not a modal, unless the repo's
   convention says otherwise — the executing agent checks and matches).
3. An empty state, a loading state, and an error state that keeps the previous list on screen.
4. Radix `dialog` (already a dependency) for the drawer, with focus restoration on close; the
   Drawer is keyboard-reachable from the header and from the message list.

**Commit:** `feat(chat): list and reopen conversations`
**Delta:** +1 component +1 test file, wiring in `ChatWidget.tsx`. Requires P1.

---

### Task 10 — Memory panel (**P1**)

**Files:** `components/chat/MemoryPanel.tsx` (new) + test, wiring in `ChatWidget.tsx`

1. A panel that shows what the bot remembers about the signed-in user, from
   `GET /api/ai-chat/memory`: each fact with its text, its kind, its confidence and its age — the same
   facts the assembler injects, which is the point of showing them (transparency).
2. Delete one fact and clear all (`DELETE /api/ai-chat/memory`, both shapes the route already
   supports), with optimistic removal and a rollback on failure. A delete is a real delete: the panel
   says so in one sentence.
3. When memory is off (`AI_MEMORY=off`), the endpoint's answer is rendered as the honest empty state
   ("memory is disabled for this deployment"), not as an error.
4. Nothing in the panel claims to be complete: the panel lists what is stored, and a note says that
   the tracker's own data always outranks it (Plan 3's precedence rule, stated to the reader).

**Commit:** `feat(chat): show and delete a memory`
**Delta:** +1 component +1 test file, wiring in `ChatWidget.tsx`. Requires P1.

---

### Task 11 — Accessibility, keyboard and mobile (**P1**)

**Files:** the chat components + `components/chat/__tests__/a11y.test.tsx` and
`components/chat/__tests__/responsive.test.tsx`

1. **Streaming is announced, not shouted:** the message container is `aria-live="polite"` while
   streaming and switches to `aria-live="off"`/`role="log"` semantics when complete, so a screen
   reader reads the answer once, not per-token. A test asserts the attribute transition.
2. **The keyboard path is complete:** send, stop, regenerate, open a chip, open the sources panel,
   close it, open the drawer, open the memory panel, delete a fact — each reachable with Tab/Enter/
   Escape and each asserted by a keyboard-only test (`user-event`).
3. **Focus management:** opening a panel moves focus into it and closing restores it to the control
   that opened it; the streaming placeholder never steals focus.
4. **Reduced motion:** every `framer-motion` transition has a reduced-motion branch, and the test
   setup's `matchMedia` stub (Task 1) is used to assert the branch is taken.
5. **Mobile:** the widget is usable at 360 px — the drawer and panels become full-height sheets, the
   composer stays above the keyboard, and the trace collapses to its one-line form. Asserted by
   rendered-structure tests, not by pixel snapshots.
6. Contrast and touch targets: any value the agent changes is reported with the pair it came from
   (token names), not eyeballed.

**Commit:** `feat(chat): keyboard and screen-reader paths`
**Delta:** component edits + 2 test files, ~14–18 tests. Requires P1.

---

### Task 12 — Documentation and phase verification

**Files:** `SYSTEM_DOCS.md`, `.env.example`

1. A **"Chat UI"** section: the transport (Task 2's parts and `PROTOCOL_VERSION`), the view model,
   the citation contract as the UI sees it, the activity/degrade vocabulary, feedback storage and its
   ownership rule, the drawer and memory panel and what each calls, and the accessibility properties
   (live region, focus order, reduced motion).
2. `.env.example` gains anything new, each with a comment naming its default and meaning.
3. The migration's manual verification SQL (`information_schema.columns` and
   `pg_indexes` for `ai_message_feedback`), the statement that it is committed and **not applied**,
   and that no test executes it.
4. State the rollback plainly: `AI_PIPELINE=v1` changes the pipeline and the parts the UI receives;
   the UI itself has no v1 switch and must not need one.
5. No test count change.

**Commit:** `docs(chat): document the remastered surface`

---

## 7. Risks recorded while planning

| Risk | Mitigation |
| --- | --- |
| The AI SDK pulls in a provider path that bypasses the quota | D1: the SDK frames only; `streamChat` remains the model call, and a test asserts the route imports no provider package |
| A UI rewrite loses the user's in-flight widget edits | D9/P1: Tasks 1–7 do not touch `ChatWidget.tsx`, and Tasks 8–11 wait for the user's commit |
| Chip numbers drifting from the evidence | Plan 4's `EvidenceRef[]` is the single mapping; a test renders chips from refs against a text that contains a decoy number |
| jsdom slowing or breaking the node suite | D4: a second project, node untouched, and the 1,176-test baseline re-verified in Task 1 |
| Accessibility claimed but not tested | Task 11 asserts the live-region transition, the keyboard path and the reduced-motion branch by test, and reports the token pairs it changed |
| A new degrade reason reaching the UI unrecognised | Task 6 renders an unknown reason by name with a neutral badge |
| Streaming partial text being quoted as a complete answer | Task 4's `state` distinguishes stopped/partial, and Task 7 renders it |

## 8. Completion criteria

**Phase 5 is complete** when all of the following hold and are reported verbatim:

1. `npm test` passes with the jsdom project in place; report the final test and file counts against
   the **1,176 / 73** committed baseline, and state whether the node project's own count moved at all
   (it must not).
2. `npx tsc --noEmit` exits 0, `npm run lint` reports 0 errors, `npm run build` succeeds with the
   three `/api/ai-chat*` routes plus the new `/api/ai-chat/feedback` route listed.
3. The transport ships parts: a test proves the route emits `evidence`, `activity` and `citations` on
   v2 and only text on v1, and that the answer text crosses the wire unmodified.
4. Citation chips resolve against `EvidenceRef[]` and never parse the answer text — named test.
5. Stop, regenerate and edit each work, each with a named test; a stopped answer keeps its partial
   text.
6. Feedback round-trips: a vote writes a row, a second vote replaces it, and a message that is not
   the caller's is refused — named tests for all three.
7. The drawer and the memory panel work against Plan 3's endpoints, including archive/delete and the
   disabled-memory empty state — named tests.
8. Accessibility: the live-region transition, the keyboard-only path, focus restoration and the
   reduced-motion branch each have a named test; the contrast/touch-target values changed are
   reported with their token names.
9. Every degrade reason Plan 4 can emit has a rendered wording or a neutral badge, and the list is
   quoted in the report.
10. The in-flight workstream's ten files are untouched except `components/chat/ChatWidget.tsx` (and
    `ChatMessage.tsx`/`ChatInput.tsx`), which were edited only after the user committed them — with
    the confirming commit hash quoted.
11. Feedback's migration is committed and **not** applied; the report says so, lists the manual
    verification SQL, and states that no test executed it.
12. Every deviation a subagent had to make, and every plan bug found during execution, is listed
    here as it was done for Plan 4 (a `D1–Dn` block appended to §5).

## 9. What Phase 6 consumes

- **`ActivityPart`'s degrade vocabulary and `planSource`** — Phase 6's log queries group by them, so
  the strings the UI renders and the strings the log stores must stay one list (`protocol.ts` re-exports
  Plan 4's vocabulary rather than inventing a second one).
- **`ai_message_feedback`** — the quality signal Phase 6 reports alongside `ai_request_log`.
- **`report.evicted` from `assembleMessages`** — still unrendered; Phase 6 surfaces it.
- **The jsdom project** — Phase 6's CI wiring runs both projects.
