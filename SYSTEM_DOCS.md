# DCPH-Tracker — System Documentation

> Complete technical reference for the Detective Conan PH community platform.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 15.1 (App Router) |
| Language | TypeScript 5.7 |
| UI | React 19, Tailwind CSS 3.4 |
| Animation | Framer Motion 11 |
| Database | Supabase (PostgreSQL + PostgREST + RLS) |
| Auth | Supabase Auth (Brevo SMTP & OTP Verification) |
| Hosting | Vercel (auto-deploy from `main`) |
| AI Chatbot | Multi-Provider Failover (Google Gemini, Groq Cloud, OpenRouter) |
| Testing | Vitest |

---

## Frontend

### Core
- **Next.js 15** — App Router, Server Components, Server Actions, API Routes
- **React 19** — Client components marked with `"use client"`
- **TypeScript** — Strict mode, path aliases via `@/*`

### Styling
- **Tailwind CSS 3.4** — Utility-first CSS framework
- **tailwind-merge** — Deduplicates conflicting Tailwind classes (`cn()` utility)
- **tailwindcss-animate** — Animation utilities
- **class-variance-authority (CVA)** — Component variant management
- **clsx** — Conditional class joining

### UI Components
- **Radix UI** — Headless, accessible primitives:
  - `@radix-ui/react-dialog` — Modal dialogs
  - `@radix-ui/react-dropdown-menu` — Dropdown menus
  - `@radix-ui/react-select` — Select inputs
  - `@radix-ui/react-tabs` — Tab panels
  - `@radix-ui/react-tooltip` — Tooltips
  - `@radix-ui/react-avatar` — Avatar with fallback
  - `@radix-ui/react-separator` — Visual dividers
  - `@radix-ui/react-label` — Form labels
  - `@radix-ui/react-slot` — Polymorphic components

### Icons & Animation
- **Lucide React** — Icon library (500+ icons)
- **Framer Motion** — Page transitions, layout animations, scroll effects

### State Management
- **TanStack React Query** — Server state caching, optimistic updates, mutations

### Image Export
- **html-to-image** — Renders DOM nodes to PNG (used for the "Wrapped" shareable stat cards with `dcphtracker.vercel.app/{username}` footer)

---

## Backend / API

### API Routes (`app/api/`)

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/sync` | POST | Content sync from Jikan/Kitsu/AniList (cron + admin) |
| `/api/chat` | POST/DELETE | Community chat message send/unsend (permanent retention) |
| `/api/ai-chat` | POST | AI chatbot with RAG + multi-provider failover chain (Auth required) |
| `/api/auth/otp` | POST | Custom OTP email delivery via Brevo SMTP |
| `/api/dcw/episode` | GET | DCW wiki episode details |
| `/api/proxy-image` | GET | CORS-safe avatar proxy for canvas export |
| `/api/analytics` | GET | User analytics data |
| `/api/tracker` | GET | Tracker content entries |

### Server-Side Code
- **Supabase Server Client** — `createClient()` from `@/utils/supabase/server` (async, cookie-based)
- **Supabase Client** — `createClient()` from `@/utils/supabase/client` (sync, browser-based)
- **Supabase Admin Client** — `createAdminClient()` from `@/utils/supabase/admin` (bypasses RLS with service role)
- **Rate Limiting** — In-memory per-IP + persistent DB-backed (`lib/rate-limit.ts`, `lib/rate-limit-db.ts`)
- **Profanity Filter** — `lib/profanity.ts` — redacts forbidden words from chat messages
- **Origin Check** — `lib/origin-check.ts` — same-origin verification for API routes

### Middleware
- **Auth middleware** — Refreshes Supabase session tokens
- **CSP nonce** — Content Security Policy with per-request nonces

---

## Database (Supabase)

### Project
- **URL**: `https://hgwtlbbbkxppbasbhvlo.supabase.co`
- **Tables**: 15+ tables with Row-Level Security (RLS)
- **Migrations**: SQL files in `supabase/` directory

### Core Tables

| Table | Purpose |
|-------|---------|
| `content_entries` | All episodes, movies, specials, OVAs (1200+ entries) |
| `watch_status` | User watch data per entry (watched/rewatched/unwatched, count, rating, favorite) |
| `profiles` | User profiles (username/handle, display_name, avatar_url, bio, role) |
| `arcs` | Story arcs with episode ranges |
| `dcw_cases` | Crime data from DCW wiki (victim, suspects, location, method) |
| `chat_messages` | Community chat messages (permanently retained) |
| `chat_rooms` | Chat room definitions |
| `badges` | Achievement badges |
| `user_badges` | Earned badges per user |
| `watch_events` | Immutable watch log (feeds leaderboards) |
| `episode_comments` | Episode discussion threads |
| `notifications` | User notifications |
| `sync_staging` | Admin approval queue for synced content |
| `screening_events` | Movie screening event listings |
| `ai_provider_state` | Cross-instance circuit-breaker state per gateway target |
| `ai_request_log` | One row per AI chat request (target, outcome, timings) |
| `ai_documents` | Retrieval corpus: one searchable row per catalog/curated document |
| `ai_wiki_cache` | Time-boxed cache of DCW / Wikipedia extracts |
| `ai_conversations` | One row per AI conversation (rolling summary, message count, last activity) |
| `ai_messages` | AI transcript turns, with a generated `fts` column for episodic search |
| `ai_user_memories` | Long-term facts about a user, one active row per slot |

> **Service-role only.** Every `ai_*` table — `ai_provider_state` and `ai_request_log` (Plan 1),
> `ai_documents` and `ai_wiki_cache` (Plan 2), and the three above — has RLS enabled with **no
> policies** and no grants to `anon` or `authenticated`, so only the service-role key can read
> or write one.

### SQL Views
- `all_episodes_with_crimes` — Joins `content_entries` with `dcw_cases`
- `public_profiles` — PII-safe profile subset (`user_id`, `username`, `display_name`, `avatar_url`, `bio`)

### Key SQL Migrations (`supabase/`)
- `migration-public-profiles-bio.sql` — includes `bio` in `public_profiles` view
- `migration-remove-chat-purge.sql` — removes automatic 12-hour chat purge
- `migration-chat-realtime.sql` — adds `chat_messages` to Supabase Realtime publication
- `migration-sync-staging.sql` — admin approval staging queue
- `migration-episode-comments.sql` — episode comment threads and policies
- `migration-leaderboard-rls.sql` — row-level security for leaderboard reads
- `migration-enforce-bans.sql` — enforces account bans at the database layer
- `migrations/20260919090000_ai_gateway_infra.sql` — `ai_provider_state` + `ai_request_log`
- `migrations/20260919100000_ai_corpus.sql` — `pg_trgm`, `ai_documents`, `ai_wiki_cache`, and the three retrieval RPCs
- `migrations/20260919110000_ai_memory.sql` — `ai_conversations`, `ai_messages`, `ai_user_memories`
- `migrations/20260919120000_ai_memory_supersede.sql` — the `ai_memory_supersede` function that replaces an active memory slot atomically

> **Not applied remotely.** The four `20260919*` migrations are committed but have **not** been
> run against the linked Supabase project. Applying them is a deliberate manual step (`supabase db
> push`, or pasting the files into the SQL editor); no test executes the SQL, because CI has no
> Postgres. Until they are applied, `/api/admin/ingest-corpus` fails with a Postgres error and
> the retrieval ladder has no documents to read; `/api/ai-chat` has no transcript or memory to
> read and falls back to the client's `history`, and the memory and conversation endpoints
> return the Postgres error.

---

## External APIs

### 1. Detective Conan World (DCW) Wiki
- **URL**: `https://www.detectiveconanworld.com/wiki/api.php`
- **Type**: MediaWiki 1.45 API (public, no key required)
- **Client**: `lib/dcw.ts` — `dcwQuery()` with throttling (200ms min interval), retries, backoff
- **Usage**:
  - Episode details (cast, gadgets, plot) — `lib/dcw-episode.ts`
  - Crime case data (victim, method, suspects) — `lib/dcw-cases.ts`
  - Title matching (tracker ↔ wiki) — `lib/dcw-match.ts`
  - Image fetching — `lib/dcw-image-for-title.ts`
  - Chatbot search — `lib/chat/search.ts`

Per-target budgets, models and timeouts live in `lib/ai/targets.ts` (budgets),
`lib/ai/circuit.ts` (cooldowns) and `lib/ai/gateway.ts` (timeouts); this section is a summary.

### 2. Google AI Studio (Gemini API)
- **URL**: `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`
- **Type**: OpenAI-compatible Google Gemini API
- **Models**: `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite`, `gemini-3.6-flash`, `gemini-3-flash` (1400 req/day each)
- **Role**: Primary intelligence tier in AI chatbot fallback chain

### 3. Groq Cloud API
- **URL**: `https://api.groq.com/openai/v1/chat/completions`
- **Type**: OpenAI-compatible ultra-fast LPU inference
- **Models**: `openai/gpt-oss-120b`, `qwen/qwen3.8-27b`, `qwen/qwen3.6-27b`, `openai/gpt-oss-20b`, `groq/compound` (14,000 req/day each)
- **Role**: Secondary high-volume tier

### 4. OpenRouter API
- **URL**: `https://openrouter.ai/api/v1/chat/completions`
- **Type**: Multi-model aggregator
- **Models**: `minimax/minimax-m3:free`, `minimax/minimax-m2.7:free`, `google/gemma-4-31b-it:free`, `z-ai/glm-5.2:free`, `nvidia/nemotron-3.5-lightning:free`, `inclusionai/ling-3.0-flash-fin:free` (50 req/day per key)
- **Role**: Tertiary backup tier with primary + secondary key failover

### 5. Cerebras API
- **URL**: `https://api.cerebras.ai/v1/chat/completions`
- **Type**: OpenAI-compatible inference (constrained-decoding JSON schema support)
- **Models**: `gpt-oss-120b`, `gemma-4-31b` (900 req/day each)
- **Role**: Final fallback tier

### 6. Jikan API (MyAnimeList)
- **URL**: `https://api.jikan.moe/v4`
- **Type**: Free MAL API wrapper
- **Usage**: Fetches episode lists, anime details for content sync

### 7. Kitsu API
- **URL**: `https://kitsu.io/api/edge`
- **Type**: Free anime database API
- **Usage**: Franchise entry data (movies, specials, OVAs) for content sync

### 8. AniList API
- **URL**: `https://graphql.anilist.co`
- **Type**: GraphQL API
- **Usage**: Airing schedule data for content sync

---

## AI Chatbot (DCPH Bot)

### Architecture
```
User question (Signed-in member)
  → ChatWidget (floating launcher → slide-up panel)
    → POST /api/ai-chat (Auth verified)
      → DCW Wiki search (MediaWiki API, multiple query variations)
      → Wikipedia search (fallback when DCW has few results)
      → Tracker DB search (content_entries + dcw_cases)
      → User watch history & profile (if signed in)
      → Build system prompt (Tagalog/English natural tone + structured episode cards)
      → Model gateway (lib/ai/gateway.ts) — targets tried in that order:
          Google Gemini (AI Studio) → Groq Cloud → OpenRouter (:free) → Cerebras
          Circuit state and daily budget are checked per target before a request
          is spent. Failures are classified (misconfigured / rate_limited /
          server_error / timeout / network / empty_output) and a misconfigured
          target is cooled down for 24h rather than retried on every request.
          Failover stops once text has started streaming, so a partial answer is
          kept and labelled instead of being stitched to another model's reply.
      → Stream plain text response back
    → ChatWidget renders streaming markdown
```

### Key Chatbot Features
1. **Member-Only Access Gating**: Unauthenticated visitors see a friendly lock card with a one-click "Sign In to Chat" button triggering Supabase Auth modal. Server returns 401 Unauthorized for anonymous calls.
2. **Interactive Suggestion Chips**: Quick-action prompt chips (`What should I watch next?`, `Manga Canon Guide`, `Agasa's Gadgets`, `Movies vs Episodes`) powered by Lucide icons.
3. **Session Persistence**: Active conversations are stored in `sessionStorage` (`dcph_chat_history_v1`) so chats survive page transitions across `/tracker`, `/cases`, `/profile`, etc.
4. **Voice Input (Speech-to-Text)**: Native browser Web Speech API microphone button with audio recording animation.
5. **One-Click Message Copying**: Copy button with checkmark feedback under bot messages.
6. **Rich Interactive Tracker Links**: Episode/case links are styled as interactive badges linking to `https://dcphtracker.vercel.app/tracker/...`.
7. **Reasoning Kept Out of the Answer**: a provider's reasoning channel (`reasoning_content` / `reasoning`, sent by Groq and OpenRouter) is parsed separately from the answer text by `lib/ai/sse.ts` and is never stitched into the streamed reply. Reasoning delivered inline in `content` is no longer filtered on the streaming path — `lib/chat/answer.ts` retains those helpers for that case, but `/api/ai-chat` no longer wires the streaming `ThinkingFilter` in.
8. **Request Log**: every chat request writes one `ai_request_log` row with the target used, the outcome, the per-target attempt list, and retrieval / time-to-first-token / total timings, so provider health and latency are measurable.

### AI Retrieval Corpus

The corpus is `ai_documents` — one row per retrievable document, ids namespaced by source
(`entry:<slug>`, `character:<id>`, `relationship:<id>`, `arc:<slug>`, `thread:<slug>`,
`guide:canon`, `movie:<n>`, `gadget:<n>`, `case:<page_title>#<index>`) — with a generated `fts`
column (title weight A, body weight B), a trigram index on `title`, a GIN index on `aliases`,
and `episode_number` / `movie_number` as first-class columns. `ai_wiki_cache` holds time-boxed
DCW / Wikipedia extracts (7-day TTL, 1.2 s time box per fetch) so a wiki lookup cannot stall a
chat request. Both tables are service-role only: RLS on, no policies.

Three RPCs, one per retrieval branch:

| RPC | Branch | What it matches |
|-----|--------|-----------------|
| `ai_docs_entity` | R1, entity-precise | episode/movie number (rank 3.0), exact title (2.0), alias overlap (1.5), title substring (1.0) |
| `ai_docs_fts` | R2, full text | `websearch_to_tsquery('english', query)` over `title \|\| body` — token AND, and a malformed query yields an empty tsquery that matches nothing instead of raising |
| `ai_docs_fuzzy` | R3, typo tolerance | `similarity()` on `title` against the query and each keyword ≥ 3 characters, `pg_trgm` threshold 0.3 |

`lib/ai/retrieval/ladder.ts` runs them cheapest-first: R1 and R2 together, R3 only while fewer
than **6** distinct candidates are fused, R4 (wiki) only when the question needs lore and the
budget allows. The ladder has a **1.5 s** wall-clock budget; a round skipped for time is
recorded in `steps` and sets `degraded: "retrieval_budget"` on the result, so a thin answer is
labelled rather than silently degraded. Candidate lists are fused with reciprocal rank fusion
(`lib/ai/retrieval/rrf.ts`) and re-ranked by the tracker scorer
(`lib/ai/retrieval/candidates.ts`); a branch that rejects degrades to an empty result, never to
a failed request.

**Ingestion**: `POST /api/admin/ingest-corpus` rebuilds the corpus from `content_entries`,
`dcw_cases` and the curated guides, hashing each document and upserting only what changed.
Auth is the `x-admin-secret` header matching `ADMIN_TASK_SECRET || CRON_SECRET`; `?dryRun=1`
computes the report without writing, and the route caps at `maxDuration = 300`. With the dev
server running:

```bash
curl -X POST "http://localhost:3000/api/admin/ingest-corpus?dryRun=1" \
  -H "x-admin-secret: $ADMIN_TASK_SECRET"
```

**Golden eval**: `lib/__tests__/retrieval-eval.test.ts` runs 60 hand-authored questions
(`lib/__tests__/fixtures/golden-qa.json`) through the real ladder over an in-process index of
the seed catalog and the curated guides, and gates at **recall@5 ≥ 0.85**. That number is an
offline approximation (plan deviation D5): `createStaticSource` implements the same three
branches as the RPCs but not Postgres's exact ranking or stemming, and `dcw_cases` has no
offline source, so case retrieval is not covered. It measures the pipeline — ladder, fusion,
scorer — not the SQL.

**Manual verification**, after applying `20260919100000_ai_corpus.sql`:

```sql
-- The migration's first statement needs this schema to exist; Supabase creates it,
-- but check before running the file if the project was ever rebuilt by hand.
select 1 from pg_namespace where nspname = 'extensions';

select count(*) from public.ai_documents;
select id, rank from public.ai_docs_entity(array[500], array['haibara'], 5);
select id, rank from public.ai_docs_fts('ski lodge murder', 5);
select id, rank from public.ai_docs_fuzzy('haibarra', array['haibarra'], 5);
```

### AI Memory and Transcripts

The bot's memory has three tiers, written at different times by different parts of the pipeline.
Nothing that writes memory runs on the response's critical path: the L1 window and the memory
read are bounded pre-stream reads (400 ms each; a timed-out window falls back to the client's
`history`, and a failed memory read injects nothing), and everything that writes — the assistant
turn, extraction, consolidation, the rolling summary — runs in `after()`, once the answer has
been sent.

| Tier | What it is | Where it lives |
|------|-----------|----------------|
| L1 working | the last **8** messages verbatim plus the rolling summary of the turns before them | `ai_conversations.summary` + the newest `ai_messages` rows |
| L2 episodic | every message, FTS-indexed and searchable per user | `ai_messages` (generated `fts`, GIN index) |
| L3 semantic | durable facts about the user, one row per active slot | `ai_user_memories` |

The episodic search itself (`searchMessages`) is a tested port method from Phase 3; the routed
tool that consumes it ships in Phase 4 (deviation D5).

**The three tables.** `ai_conversations` is one row per thread: `title` (the first user turn,
capped at 80 characters), the rolling `summary`, `summarized_through` (the index the summary
covers up to), `message_count`, `last_message_at` and `archived_at`. `ai_messages` is the
transcript: `role` (`user` / `assistant` / `system`), `content`, `metadata`, optional model and
token columns, `feedback` (`up` / `down`) and a generated `fts` column —
`to_tsvector('english', content)`, GIN-indexed — which is what episodic search matches against.
`ai_user_memories` is the semantic tier: `kind`, `key`, `value`, `confidence`, `status`
(`active` / `superseded` / `expired`), `superseded_by`, `source_message_id`, `evidence_count`,
`last_confirmed_at` and `expires_at`.

All three are RLS-enabled with **no policies** and no grants to `anon` or `authenticated`, so
only the service-role key reaches them. `ai_messages` deliberately has no `user_id`: ownership is
enforced by an ownership check on the conversation, carried in the same query that reads or
writes a message (deviation D1). That is why every store method that touches a message takes a
user id — a port implementation that read messages by conversation id alone would be a
cross-user leak.

**Write schedule.** Extraction lives in `lib/ai/memory/write.ts` and runs only when
`messageCount % MEMORY_WRITE_EVERY === 0` (`MEMORY_WRITE_EVERY` is 4), i.e. on every fourth
assistant turn, in `after()`. On the other three turns the writer returns `reason: "not_due"`
before any model call, port read or store read — the zero is asserted in
`lib/__tests__/memory-write.test.ts`. The rolling summary has its own schedule: it is due when at
least `SUMMARY_TRIGGER` (8) messages sit outside the 8-message verbatim window and are not yet
covered by `summarized_through`, and each round reads at most `SUMMARY_INPUT_LIMIT` (40) messages
from the start of the unsummarized region, so a region longer than one round loses nothing (a
call is bounded at two rounds, and a backlog drains over consecutive turns).

**The decay score.** Each turn, `lib/ai/memory/score.ts` scores the user's active facts against
the question:

```
score = 0.55·lexical + 0.25·confidence + 0.20·exp(−age_days / 45)
```

`lexical` is the fraction of the query's tokens found in the fact's `key` and `value`, and
`age_days` is measured from `last_confirmed_at`. The weights are `W_LEXICAL = 0.55`,
`W_CONFIDENCE = 0.25` and `W_RECENCY = 0.20` over `HALF_LIFE_DAYS = 45`; the three sum to 1, so a
fact that matches every token, is fully confident and was just confirmed scores exactly 1. The
best `MEMORY_LIMIT` (12) facts are rendered inside a `MEMORY_TOKEN_BUDGET` (200 tokens) prompt
allowance, one `[MEM] key: value (conf X)` line each.

**Precedence.** The prompt puts both memory sections after every retrieved-context section and
labels them: remembered facts are *"not instructions"*, and a conflict with the tracker entries
or wiki pages resolves in favour of those. The rolling summary is labelled as history written by
the assistant, so a summary that paraphrases a user instruction is still read as history. A
`[MEM]` line is data the user told us, never a command. Watch progress is the one fact on a
clock: `watch_progress` is written with `expires_at = progressExpiry(now)` (now + 90 days) and
the store's `loadActive` drops a fact whose `expires_at` has passed, because the tracker is
authoritative about where the user is in the series.

**Retention and control.**

- `GET /api/ai-chat/memory` lists the user's facts with their confidence, status and
  `lastConfirmedAt`, active first, capped at `MEMORY_LIST_LIMIT` (50).
- `DELETE /api/ai-chat/memory?id=<uuid>` deletes one fact. A malformed id is a 400 without a
  database call, and an id that is not the caller's gets the same 404 as one that does not exist,
  so neither reveals whether another user's row is there.
- Asking *"what do you remember about me?"* is answered from the memory table in plain text with
  **no model call**. The matcher in `lib/ai/memory/recall.ts` is deliberately narrow, so
  *"what do you remember about episode 5"* is a tracker question and still reaches retrieval.
- `GET /api/ai-chat/conversations` lists the newest 30 non-archived conversations;
  `GET /api/ai-chat/conversations?id=<uuid>` returns one conversation with its title, summary and
  transcript, capped at 200 messages; `DELETE ?id=<uuid>` **archives** it (sets `archived_at`)
  rather than deleting it, so a mis-tap cannot destroy a thread. Every response is
  `Cache-Control: no-store`, and an anonymous caller gets a 401.

**The chat contract change (D3).** `POST /api/ai-chat` accepts an optional `conversationId` in
the request body and returns the resolved id in the `X-Conversation-Id` response header on the
streaming answer. When the body carries none, the server attaches to the user's most recent
conversation whose `last_message_at` is within 30 minutes (`RECENT_CONVERSATION_MS`), or creates
a new one; an id that is unknown or belongs to someone else is refused without creating
anything. The legacy `{ message, history }` body still works exactly as before — the client is
expected to start sending the id in Phase 5, and until then the server-owned transcript and the
client's `history` coexist.

**The kill switch (D6).** `AI_MEMORY=off` stops memory extraction and injection: the memory read
and the recall answer return empty before touching the database, the async writer never runs, and
the prompt gets no `[MEM]` section. Transcripts still record, and the memory endpoints still
work — `GET` still lists and `DELETE` still deletes, because a user must be able to see and
remove what was stored before the switch was flipped. Any value other than `off`, including
unset, means on. It is independent of the spec's `AI_PIPELINE=v1` rollback (spec §12), which
restores the pre-Phase-3 pipeline behind the same route.

**Migration status.** `20260919110000_ai_memory.sql` (the three tables) and
`20260919120000_ai_memory_supersede.sql` (the `ai_memory_supersede` function) are committed but
**not applied** to the remote project — applying them is a deliberate human step, and neither a
test nor a plan step runs `supabase db push`. No test executed this SQL: the tests read the
migration files and assert their structure (table and column names, the partial index predicate,
the absent destructive statements), not their effect.

Manual verification, after applying both migrations:

```sql
select to_regclass('public.ai_conversations'),
       to_regclass('public.ai_messages'),
       to_regclass('public.ai_user_memories');

select proname from pg_proc where proname = 'ai_memory_supersede';

-- The partial predicate: `... WHERE (status = 'active')`.
select indexdef from pg_indexes
 where tablename = 'ai_user_memories'
   and indexname = 'ai_user_memories_active_slot_idx';

-- Two rows, one slot. Replace <user-uuid> with a real auth.users id.
insert into public.ai_user_memories (user_id, kind, key, value, confidence)
values ('<user-uuid>', 'preference', 'favorite_character', 'Haibara', 0.9)
returning id;

select public.ai_memory_supersede(
  '<user-uuid>', '<id-from-above>', 'preference', 'favorite_character', 'Ran', 0.9, null, null
);

select value, status, superseded_by
  from public.ai_user_memories
 where user_id = '<user-uuid>' and kind = 'preference' and key = 'favorite_character'
 order by created_at;
```

The last query shows the round trip: one `active` row (`Ran`) and one `superseded` row
(`Haibara`) whose `superseded_by` points at it.

**Cost.** Memory adds at most one free-tier model call per four assistant turns, and it is issued
in `after()`, after the response has been sent: the writer returns before any provider, port or
store call unless the turn is due. A summary is a second, independent call, spent only when
enough unsummarized turns have left the verbatim window to reach `SUMMARY_TRIGGER`, and a due
turn whose L1 window is empty makes no call at all. A due extraction spends its one call even
when the model reports no candidates — the call is the cost, and the empty answer is what makes
consolidation a no-op with no database write.

---

## Profile & Rankings System

### Profile Dossier (`/profile/[username]`)
- **Detective Career Rank Badge**: Level 1 (Civilian Observer) to Level 7 (Master Detective) calculated from `casesSolved`.
- **Public Bio**: Displays user's custom bio with whitespace formatting.
- **Editable Codename (`@username`)**: Users can customize their unique `@username` handle in Settings with real-time validation and collision checks.
- **Career Stats Grid**:
  - Cases Solved (with catalog total)
  - Total Rewatches
  - Hours Watched (days/hours/minutes)
  - Detective Rank Level (clickable link to `/community/rankings`)

---

## Environment Variables

```bash
# Supabase
NEXT_PUBLIC_SUPABASE_URL=https://hgwtlbbbkxppbasbhvlo.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
SUPABASE_SERVICE_ROLE_KEY=eyJ...
NEXT_PUBLIC_SITE_URL=https://dcphtracker.vercel.app

# Cron sync
CRON_SECRET=...
ADMIN_TASK_SECRET=

# AI Chatbot providers — see .env.example for the full annotated list.
# All optional free tiers; at least one is required or /api/ai-chat returns 500.
# Server-only: never prefix these with NEXT_PUBLIC_ (they would ship to the browser).
GEMINI_API_KEY=
GROQ_API_KEY=
OPENROUTER_API_KEY=
OPENROUTER_API_KEY_2=
CEREBRAS_API_KEY=
```

---

## Deployment

- **Platform**: Vercel
- **Auto-deploy**: `main` branch
- **Cron jobs** (Vercel Cron):
  - `/api/sync?mode=airing` — daily
  - `/api/sync?mode=seed` — weekly
- **Production URL**: `https://dcphtracker.vercel.app`

