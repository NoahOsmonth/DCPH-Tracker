// app/api/ai-chat/route.ts
import { after } from "next/server"
import { createClient } from "@/utils/supabase/server"
import { searchAll } from "@/lib/chat/search"
import { buildSystemPrompt } from "@/lib/chat/prompt"
import {
  REFUSAL_NO_CONTEXT,
  classifyChatIntent,
  shouldRefuseForMissingContext,
} from "@/lib/chat/intent"
import { buildProviderTargets } from "@/lib/ai/targets"
import { createGateway } from "@/lib/ai/gateway"
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

  const lastUserTurn = [...priorTurns].reverse().find((t) => t.role === "user")
  const searchQuery = lastUserTurn ? `${lastUserTurn.content} ${userMessage}` : userMessage

  const retrieveStartedAt = Date.now()
  let context: Awaited<ReturnType<typeof searchAll>>
  let retrievalFailed = false
  try {
    context = await searchAll(searchQuery, userId)
  } catch {
    retrievalFailed = true
    context = { episodes: [], cases: [], dcwWiki: [] }
  }
  const retrieveMs = Date.now() - retrieveStartedAt

  const hasInDomainContext =
    context.episodes.length > 0 ||
    context.cases.length > 0 ||
    context.dcwWiki.some((r) => r.source === "dcw")
  if (
    shouldRefuseForMissingContext({
      searchQuery,
      priorUserMessages: priorTurns.filter((t) => t.role === "user").map((t) => t.content),
      hasContext: hasInDomainContext,
    })
  ) {
    return refusalResponse(REFUSAL_NO_CONTEXT)
  }

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://dcphtracker.vercel.app"

  const systemPrompt = buildSystemPrompt({
    context,
    displayName,
    isSignedIn: Boolean(userId),
    siteUrl,
    memories: memoryBlock,
    conversationSummary,
  })

  const messages = [
    { role: "system" as const, content: systemPrompt },
    ...priorTurns,
    { role: "user" as const, content: userMessage },
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
  const gateway = createGateway()
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

      // One budget for the whole request, not one per provider. The gateway's
      // timeouts are per target, so a run of stalled providers can outlast the
      // platform's own limit — and a response the platform cuts never gets the
      // "cut short" label. Aborting ourselves keeps that label ours to write.
      const budget = new AbortController()
      const budgetTimer = setTimeout(() => budget.abort(), TOTAL_BUDGET_MS)
      const abortOnDisconnect = () => budget.abort()
      if (request.signal.aborted) {
        budget.abort()
      } else {
        request.signal.addEventListener("abort", abortOnDisconnect)
      }

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
        clearTimeout(budgetTimer)
        request.signal.removeEventListener("abort", abortOnDisconnect)
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
        docCount: context.episodes.length + context.cases.length + context.dcwWiki.length,
        degradedReason: retrievalFailed ? "retrieval_failed" : null,
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
