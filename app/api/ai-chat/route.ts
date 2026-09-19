// app/api/ai-chat/route.ts
import { after } from "next/server"
import { createClient } from "@/utils/supabase/server"
import { getUserWatchHistory, searchAll } from "@/lib/chat/search"
import { buildSystemPrompt } from "@/lib/chat/prompt"
import {
  REFUSAL_NO_CONTEXT,
  classifyChatIntent,
  shouldRefuseForMissingContext,
} from "@/lib/chat/intent"
import { buildProviderTargets } from "@/lib/ai/targets"
import { createGateway, type ChatMessage } from "@/lib/ai/gateway"
import { validateCitations } from "@/lib/ai/citations"
import { isMemoryRecallQuestion } from "@/lib/ai/memory/recall"
import { pipelineVersion, runPipeline, type PipelineResult } from "@/lib/ai/pipeline"
import type { AdminRowsClient, ResolverClient } from "@/lib/ai/pipeline/source-resolver"
import { toStructuredCall } from "@/lib/ai/structured-call"
import { logRequest } from "@/lib/ai/request-log"
import { rateLimitPersistent } from "@/lib/rate-limit-db"
import {
  createRequestPersistence,
  type PersistedTurn,
  type RequestPersistence,
} from "@/lib/chat/persistence"
import { withTimeout } from "@/lib/request-timeout"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
// A ceiling for the platform, not the working limit: the route enforces its own
// shorter budget below, so a long answer is labelled as cut short by us rather
// than being killed by the platform with no explanation.
export const maxDuration = 60

const MAX_MESSAGE_CHARS = 1000
const MAX_HISTORY_MESSAGES = 8
const MAX_BODY_BYTES = 16_000

/** Whole-request deadline, deliberately below `maxDuration`. */
const TOTAL_BUDGET_MS = 45_000

/**
 * The ceiling on each transcript read the pre-stream path makes (rule 7). The
 * store owns every database detail behind the persistence seam, so a slow
 * database has one cost here: the client's own history is used instead.
 */
const PERSISTENCE_TIMEOUT_MS = 400

const RATE_LIMIT = { limit: 20, windowMs: 5 * 60 * 1000 }

const EMPTY_RESULT_MESSAGE =
  "I could not find a reliable answer for that. Try naming the episode number, movie number, or character you mean."
const RATE_LIMITED_MESSAGE =
  "All free AI providers are temporarily at capacity. Please try again in a moment."
const PARTIAL_RESULT_SUFFIX = "\n\n_(The response was cut short. Ask again to retry.)_"

type ChatRole = "user" | "assistant"
interface ChatTurn {
  role: ChatRole
  content: string
}

/**
 * History is accepted from the client but treated as untrusted: it is only
 * ever replayed as conversational context, and roles are restricted so a
 * caller cannot inject a `system` turn. It is also the fallback now that a
 * server-owned transcript exists: whenever the transcript is unavailable — no
 * service-role key, a degraded read, or a caller-supplied id the user does not
 * own — this is what the model gets, exactly as before.
 */
function sanitizeHistory(input: unknown): ChatTurn[] {
  if (!Array.isArray(input)) return []
  const turns: ChatTurn[] = []

  for (const item of input) {
    if (!item || typeof item !== "object") continue
    const { role, content } = item as { role?: unknown; content?: unknown }
    if (role !== "user" && role !== "assistant") continue
    if (typeof content !== "string") continue
    const trimmed = content.trim()
    if (!trimmed) continue
    turns.push({ role, content: trimmed.slice(0, MAX_MESSAGE_CHARS) })
  }

  return turns.slice(-MAX_HISTORY_MESSAGES)
}

function jsonError(message: string, status: number, extraHeaders?: HeadersInit) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json", ...(extraHeaders ?? {}) },
  })
}

/**
 * The route's plain-text 200: a refusal, and now a memory answer. Both are
 * complete answers the route already has in hand, so neither streams and both
 * carry the same no-cache headers.
 */
function refusalResponse(reply: string): Response {
  return new Response(reply, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache, no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  })
}

/** Same-origin guard: this is the only route that spends money on inference. */
function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin")
  // Non-browser clients (curl, native apps) send no Origin; they still face
  // auth and rate limiting, so absence is not treated as hostile.
  if (!origin) return true
  // A constructed Request carries no Host header — undici adds it at send
  // time — so the URL is the fallback. Behind a proxy the URL host is also the
  // more trustworthy of the two.
  const expectedHost = request.headers.get("host") ?? new URL(request.url).host
  try {
    return new URL(origin).host === expectedHost
  } catch {
    return false
  }
}

/**
 * Registers the post-response work with Next's `after`, and falls back to a
 * plain fire-and-forget call when `after` throws because there is no request
 * scope (unit tests, or any non-Next caller). Either way the work runs exactly
 * once — it must not be dropped because the registration mechanism was
 * unavailable — and a rejection cannot surface, because `after()` has no error
 * boundary of its own.
 */
function scheduleAfter(work: Promise<void>): void {
  const guarded = work.catch(() => {})
  try {
    after(() => guarded)
  } catch {
    void guarded
  }
}

/** The pipeline's narration, prefixed like every other line this route writes. */
function pipelineLog(line: string): void {
  console.error(`[ai-chat] ${line}`)
}

/**
 * The one degraded reason `ai_request_log` records, in precedence order.
 *
 * A failed retrieval says more than anything the request did afterwards, then
 * the pipeline's own reason (the corpus fallback, a stage budget, eviction), the
 * screening's exclusions (D4), and finally an evidence-backed answer that cited
 * nothing valid (D3). v1 keeps today's `retrieval_failed`-or-null behaviour.
 */
function degradedReasonFor(input: {
  retrievalFailed: boolean
  pipeline: PipelineResult | null
  uncited: boolean
}): string | null {
  if (input.retrievalFailed) return "retrieval_failed"
  if (input.pipeline === null) return null
  if (input.pipeline.degraded !== null) return input.pipeline.degraded
  if (input.pipeline.screening.excluded.length > 0) return "screened"
  return input.uncited ? "uncited" : null
}

export async function POST(request: Request) {
  const targets = buildProviderTargets()
  if (targets.length === 0) {
    return jsonError("Chat is not configured on this server.", 500)
  }

  if (!isSameOrigin(request)) {
    return jsonError("Cross-origin requests are not allowed.", 403)
  }

  const declaredLength = Number(request.headers.get("content-length") ?? "0")
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return jsonError("Request body too large.", 413)
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return jsonError("Invalid JSON body.", 400)
  }

  const { message, history, conversationId } = (body ?? {}) as {
    message?: unknown
    history?: unknown
    conversationId?: unknown
  }
  if (typeof message !== "string" || !message.trim()) {
    return jsonError("A non-empty `message` is required.", 400)
  }
  if (message.length > MAX_MESSAGE_CHARS) {
    return jsonError(`Message too long (max ${MAX_MESSAGE_CHARS} characters).`, 400)
  }

  const userMessage = message.trim()
  const clientHistory = sanitizeHistory(history)
  // An empty string is a client that sent the field with nothing in it; it
  // means "no id", exactly as the store reads it.
  const requestedConversationId =
    typeof conversationId === "string" && conversationId ? conversationId : undefined

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return jsonError("Please sign in to chat with DCPH Bot.", 401)
  }

  const limited = await rateLimitPersistent(`ai-chat:user:${user.id}`, RATE_LIMIT)
  if (!limited.allowed) {
    return jsonError(
      `You are sending messages too quickly. Try again in ${limited.retryAfterSeconds}s.`,
      429,
      { "Retry-After": String(limited.retryAfterSeconds) }
    )
  }

  const intent = classifyChatIntent(userMessage)
  if (intent.action === "refuse") {
    return refusalResponse(intent.reply)
  }

  // Read once, before any retrieval work: the rollback is a decision about
  // this request, and `runPipeline` reads the same variable to make the same
  // one. `v1` is the only value that selects the old path (constraint 11).
  const version = pipelineVersion(process.env)

  const userId = user.id
  let displayName: string | null = null
  try {
    const { data: profile } = await supabase
      .from("profiles")
      .select("display_name, username")
      .eq("user_id", user.id)
      .maybeSingle()
    displayName = profile?.display_name ?? profile?.username ?? null
  } catch {
    // Non-fatal profile lookup error
  }

  // The transcript, when there is one. Every call is bounded and every failure
  // degrades to the client's own history: a conversation problem must never
  // cost an answer (constraint 14).
  let persistence: RequestPersistence | null = null
  try {
    persistence = await withTimeout(
      createRequestPersistence({ userId, conversationId: requestedConversationId }),
      PERSISTENCE_TIMEOUT_MS
    )
  } catch (error) {
    console.error("[ai-chat] transcript unavailable, using the client's history", error)
  }
  const activePersistence = persistence

  // Rule 6: a question about what the bot remembers OF THE USER is answered
  // from the memory table rather than by the model, because a listing is data,
  // not generation. The matcher is narrow by construction -- it rejects any
  // question naming a tracker noun -- so "what do you remember about episode 5"
  // still reaches retrieval, and the read is bounded like every other pre-stream
  // read: a slow database means the normal pipeline, never a stalled response.
  if (activePersistence !== null && isMemoryRecallQuestion(userMessage)) {
    try {
      const answer = await withTimeout(activePersistence.recallAnswer(), PERSISTENCE_TIMEOUT_MS)
      // "" is the seam's "memory is off". An empty body would read as a broken
      // answer, so the turn goes to the model instead.
      if (answer !== "") return refusalResponse(answer)
    } catch (error) {
      console.error("[ai-chat] memory recall unavailable, using the normal pipeline", error)
    }
  }

  let windowTurns: PersistedTurn[] | null = null
  let conversationSummary: string | undefined
  let memoryBlock = ""

  if (activePersistence !== null) {
    try {
      const loaded = await withTimeout(activePersistence.window(), PERSISTENCE_TIMEOUT_MS)
      // An empty window is a brand-new thread, not a transcript: the client's
      // own history is still the better prompt until the server has one.
      if (loaded !== null && loaded.turns.length > 0) {
        windowTurns = loaded.turns
        conversationSummary = loaded.summary ?? undefined
      }
    } catch (error) {
      console.error("[ai-chat] transcript window unavailable, using the client's history", error)
    }

    try {
      memoryBlock = await withTimeout(activePersistence.memories(userMessage), PERSISTENCE_TIMEOUT_MS)
    } catch (error) {
      // Memory is personalisation, never ground truth (constraint 15), so a
      // failed read injects nothing rather than costing the answer.
      console.error("[ai-chat] memory read unavailable", error)
    }
  }

  const priorTurns = windowTurns ?? clientHistory
  const priorUserMessages = priorTurns.filter((t) => t.role === "user").map((t) => t.content)

  const lastUserTurn = [...priorTurns].reverse().find((t) => t.role === "user")
  const searchQuery = lastUserTurn ? `${lastUserTurn.content} ${userMessage}` : userMessage

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://dcphtracker.vercel.app"

  // One budget for the whole request, not one per stage: the planner and the
  // answer stream share a single clock, so a request that plans for a second
  // cannot also stream for the full budget, and a client that disconnects
  // while the planner is thinking aborts it (constraint 10).
  const budget = new AbortController()
  const budgetTimer = setTimeout(() => budget.abort(), TOTAL_BUDGET_MS)
  const abortOnDisconnect = () => budget.abort()
  if (request.signal.aborted) {
    budget.abort()
  } else {
    request.signal.addEventListener("abort", abortOnDisconnect)
  }
  const releaseBudget = () => {
    clearTimeout(budgetTimer)
    request.signal.removeEventListener("abort", abortOnDisconnect)
  }

  const gateway = createGateway()

  const retrieveStartedAt = Date.now()
  let context: Awaited<ReturnType<typeof searchAll>> = { episodes: [], cases: [], dcwWiki: [] }
  let hasInDomainContext = false
  let retrievalFailed = false
  let pipelineResult: PipelineResult | null = null
  let pipelineThrew = false
  let systemPrompt = ""

  if (version === "v2") {
    // v2's retrieval context is empty: the evidence blocks carry the facts and
    // every context section is content-gated. The one exception is the watch
    // history, which v1 got for free inside `searchAll` and the pipeline does
    // not fetch — it stays a real read, bounded like every other pre-stream one.
    let watchHistory: Awaited<ReturnType<typeof getUserWatchHistory>>
    try {
      watchHistory = await withTimeout(getUserWatchHistory(userId), PERSISTENCE_TIMEOUT_MS)
    } catch (error) {
      console.error("[ai-chat] watch history unavailable", error)
    }

    // The memory block and the rolling summary are NOT passed here: the
    // assembler owns both sections, and passing them twice would put two
    // copies of each in the prompt. They reach the model through `runPipeline`.
    systemPrompt = buildSystemPrompt({
      context: { episodes: [], cases: [], dcwWiki: [], watchHistory },
      displayName,
      isSignedIn: Boolean(userId),
      siteUrl,
    })

    // `ai_documents` and `ai_wiki_cache` are service-role only (the corpus
    // migration revokes them from anon and authenticated and enables RLS with
    // no policies), so the indexed corpus is reachable only through the admin
    // client — a user-scoped one would probe "reachable" and then read nothing.
    // Dynamic on purpose: the v1 route, and the tests that pin it, must not
    // load the env-dependent admin module at all.
    const { createAdminClient } = await import("@/utils/supabase/admin")
    // The resolver declares its clients structurally, so the generated Supabase
    // type is narrowed once here rather than leaking PostgREST inward — the
    // same seam `createRequestPersistence` uses.
    const admin = createAdminClient() as unknown as (ResolverClient & AdminRowsClient) | null

    const plannerCall = toStructuredCall(gateway, {
      targets,
      signal: budget.signal,
    })

    try {
      pipelineResult = await runPipeline({
        message: searchQuery,
        priorTurns,
        priorUserMessages,
        systemPrompt,
        memories: memoryBlock,
        summary: conversationSummary ?? null,
        userId,
        client: admin,
        admin,
        plannerCall,
        plannerStrict: targets.some((target) => target.supportsJsonSchema),
        now: Date.now,
        log: pipelineLog,
      })
    } catch (error) {
      // `runPipeline` contains its own stages; this is the belt to that
      // braces. The request continues without evidence and the refusal gate
      // decides whether an unevidenced answer is honest — never a 500.
      pipelineThrew = true
      retrievalFailed = true
      console.error("[ai-chat] pipeline unavailable, answering without evidence", error)
    }
  }

  if (pipelineResult === null && !pipelineThrew) {
    // v1: today's retrieval, refusal gate input and prompt, byte-for-byte in
    // behaviour (constraint 11). Also the defensive branch when the pipeline
    // itself reports the rollback.
    try {
      context = await searchAll(searchQuery, userId)
    } catch {
      retrievalFailed = true
    }

    hasInDomainContext =
      context.episodes.length > 0 ||
      context.cases.length > 0 ||
      context.dcwWiki.some((r) => r.source === "dcw")

    systemPrompt = buildSystemPrompt({
      context,
      displayName,
      isSignedIn: Boolean(userId),
      siteUrl,
      memories: memoryBlock,
      conversationSummary,
    })
  }

  // The pipeline measures its own retrieval; v1's is the wall clock around
  // `searchAll`, which is also the honest number when the pipeline threw.
  const retrieveMs =
    pipelineResult !== null ? pipelineResult.timings.retrieveMs : Date.now() - retrieveStartedAt

  // D8: the gate keeps its signature, and only its `hasContext` source changes
  // between the paths — the assembly's evidence on v2, v1's own in-domain hit.
  const hasContext = pipelineResult !== null ? pipelineResult.evidence.length > 0 : hasInDomainContext
  if (
    shouldRefuseForMissingContext({
      searchQuery,
      priorUserMessages,
      hasContext,
    })
  ) {
    releaseBudget()
    return refusalResponse(REFUSAL_NO_CONTEXT)
  }

  // The assembler leaves the current user turn to the route (it is the only
  // place that has the user's own words), so it is appended here on both paths.
  const messages: ChatMessage[] =
    pipelineResult !== null
      ? [...pipelineResult.messages, { role: "user", content: userMessage }]
      : [
          { role: "system", content: systemPrompt },
          ...priorTurns,
          { role: "user", content: userMessage },
        ]

  // Before the stream starts, so a client that disconnects immediately still
  // has its question stored.
  if (activePersistence !== null) {
    try {
      await withTimeout(activePersistence.record("user", userMessage), PERSISTENCE_TIMEOUT_MS)
    } catch (error) {
      console.error("[ai-chat] user turn not stored", error)
    }
  }

  const encoder = new TextEncoder()
  const requestStartedAt = Date.now()

  // The answer the gateway actually emitted, accumulated as it arrives. This is
  // what the transcript stores: the synthetic messages below are ours, not the
  // model's, and a rate-limited or empty turn has no answer to store at all.
  let answerText = ""
  let settleTurn: (answer: string | null) => void = () => {}
  // Resolved by the stream, consumed by the post-response work: `after` runs
  // once the response is handed over, so the two cannot be joined any earlier.
  const turnSettled = new Promise<string | null>((resolve) => {
    settleTurn = resolve
  })

  let answerSettled = false
  // Exactly once, from close() or from cancel(): the post-response work runs a
  // single time, and a client that walks away mid-answer still has the text
  // that arrived stored.
  const settleAnswer = () => {
    if (answerSettled) return
    answerSettled = true
    settleTurn(answerText.trim() === "" ? null : answerText)
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false
      let firstTokenMs: number | null = null

      const close = () => {
        if (closed) return
        closed = true
        try {
          controller.close()
        } catch {
          // Already closed by a client disconnect.
        }
        settleAnswer()
      }

      const enqueue = (text: string) => {
        try {
          controller.enqueue(encoder.encode(text))
        } catch {
          closed = true
        }
      }

      // The budget was hoisted before retrieval: the planner and the stream
      // share one clock, and the disconnect listener that aborts both was
      // registered there too. This is where that clock stops.
      let result
      try {
        result = await gateway.streamChat({
          messages,
          targets,
          signal: budget.signal,
          onDelta: (text) => {
            if (firstTokenMs === null) firstTokenMs = Date.now() - requestStartedAt
            answerText += text
            enqueue(text)
          },
        })
      } finally {
        releaseBudget()
      }

      if (result.aborted) {
        // Our own budget expiring is not the same as the user closing the tab:
        // in the first case they are still listening and the answer must be
        // labelled, in the second there is nobody left to tell.
        if (result.textChars > 0 && !request.signal.aborted) {
          enqueue(PARTIAL_RESULT_SUFFIX)
        }
        close()
      } else if (!result.ok) {
        enqueue(result.rateLimited ? RATE_LIMITED_MESSAGE : EMPTY_RESULT_MESSAGE)
        close()
      } else {
        if (result.midStreamFailure || result.truncated) enqueue(PARTIAL_RESULT_SUFFIX)
        close()
      }

      // The citation contract is checked on the answer the model actually
      // emitted. `answerText` never contains the synthetic messages below, so
      // a rate-limited or empty turn cannot be read as an uncited answer (D3).
      const citations = validateCitations({
        text: answerText,
        evidence: pipelineResult?.evidence ?? [],
        requireCitation: (pipelineResult?.evidence.length ?? 0) > 0,
      })

      // Fire-and-forget: observability must not delay or fail the response.
      void logRequest({
        userId,
        targetId: result.targetId,
        outcome: result.aborted
          ? "aborted"
          : result.ok
            ? result.truncated
              ? "partial"
              : "ok"
            : result.rateLimited
              ? "rate_limited"
              : "empty",
        retrieveMs,
        ttftMs: firstTokenMs,
        totalMs: Date.now() - requestStartedAt,
        attempts: result.attempts,
        // v2's documents are the numbered evidence refs; v1 has no refs, so
        // its count stays the rows retrieval returned.
        docCount:
          pipelineResult !== null
            ? pipelineResult.evidence.length
            : context.episodes.length + context.cases.length + context.dcwWiki.length,
        degradedReason: degradedReasonFor({
          retrievalFailed,
          pipeline: pipelineResult,
          uncited: citations.uncited,
        }),
        ...(pipelineResult !== null
          ? {
              planSource: pipelineResult.planSource,
              tools: pipelineResult.toolNames,
              planMs: pipelineResult.timings.planMs,
              citationsValid: citations.valid,
            }
          : {}),
      })
    },
    cancel() {
      // The client disconnected. Upstream reads are released inside the
      // gateway's finally block; the turn still settles so the text that did
      // arrive is stored rather than lost with the connection.
      settleAnswer()
    },
  })

  if (activePersistence !== null) {
    const handle = activePersistence
    scheduleAfter(
      turnSettled.then(async (answer) => {
        if (answer === null) return
        try {
          await handle.afterTurn({ answer })
        } catch (error) {
          // The seam contains its own failures; this is the last line of
          // defence for work that runs after there is anyone to tell.
          console.error("[ai-chat] post-response transcript write failed", error)
        }
      })
    )
  }

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache, no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      // The client echoes this back on its next turn. Absent when there is no
      // server-owned transcript, which is exactly today's response.
      ...(activePersistence !== null
        ? { "X-Conversation-Id": activePersistence.conversationId }
        : {}),
    },
  })
}
