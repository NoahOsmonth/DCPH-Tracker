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

> **Not applied remotely.** The two `20260919*` migrations are committed but have **not** been
> run against the linked Supabase project. Applying them is a deliberate manual step (`supabase db
> push`, or pasting the files into the SQL editor); no test executes the SQL, because CI has no
> Postgres. Until they are applied, `/api/admin/ingest-corpus` fails with a Postgres error and
> the retrieval ladder has no documents to read.

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

