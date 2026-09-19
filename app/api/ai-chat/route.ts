// app/api/ai-chat/route.ts
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
 * caller cannot inject a `system` turn. Server-owned transcripts arrive in a
 * later phase; until then this stays the authoritative sanitiser.
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

  const { message, history } = (body ?? {}) as { message?: unknown; history?: unknown }
  if (typeof message !== "string" || !message.trim()) {
    return jsonError("A non-empty `message` is required.", 400)
  }
  if (message.length > MAX_MESSAGE_CHARS) {
    return jsonError(`Message too long (max ${MAX_MESSAGE_CHARS} characters).`, 400)
  }

  const userMessage = message.trim()
  const priorTurns = sanitizeHistory(history)

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
  })

  const messages = [
    { role: "system" as const, content: systemPrompt },
    ...priorTurns,
    { role: "user" as const, content: userMessage },
  ]

  const encoder = new TextEncoder()
  const gateway = createGateway()
  const requestStartedAt = Date.now()

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
      // gateway's finally block; nothing to do here.
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache, no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  })
}
