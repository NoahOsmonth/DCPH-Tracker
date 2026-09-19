import "server-only"
import { classifyFailure, type FailureDecision } from "@/lib/ai/failure"
import { createProviderHealth, type ProviderHealth } from "@/lib/ai/provider-health"
import { createQuotaTracker, type QuotaTracker } from "@/lib/ai/quota"
import { createSseParser } from "@/lib/ai/sse"
import type { ProviderTarget } from "@/lib/ai/targets"

export interface ChatMessage {
  role: "system" | "user" | "assistant"
  content: string
}

export interface AttemptOutcome {
  targetId: string
  outcome: string
  status?: number | null
  ms: number
}

export interface StreamChatResult {
  ok: boolean
  targetId: string | null
  attempts: AttemptOutcome[]
  textChars: number
  /** The model hit its output ceiling. */
  truncated: boolean
  /** The connection died after text was already emitted. */
  midStreamFailure: boolean
  /** Every attempt that reached a provider was rate limited. */
  rateLimited: boolean
  aborted: boolean
}

export interface StreamChatArgs {
  messages: ChatMessage[]
  targets: ProviderTarget[]
  signal: AbortSignal
  onDelta: (text: string) => void
  onReasoning?: (text: string) => void
  temperature?: number
  maxOutputTokens?: number
  /** Ceiling for connect + first token. A free tier that has not started
   * streaming in this long will not serve this request well. */
  firstTokenTimeoutMs?: number
  /** Ceiling for the whole streamed body. */
  streamTimeoutMs?: number
}

export interface GatewayDeps {
  fetchImpl?: typeof fetch
  health?: ProviderHealth
  quota?: QuotaTracker
  now?: () => number
}

export interface Gateway {
  streamChat(args: StreamChatArgs): Promise<StreamChatResult>
}

const DEFAULT_FIRST_TOKEN_MS = 4_000
const DEFAULT_STREAM_MS = 30_000

function readRetryAfter(response: Response): number | null {
  const raw = response.headers.get("retry-after")
  if (!raw) return null
  const seconds = Number(raw)
  return Number.isFinite(seconds) ? seconds : null
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return (error as { name?: string } | undefined)?.name === "AbortError" || signal.aborted
}

/** Reason string used to mark a stream that never produced its first token. */
const FIRST_TOKEN_TIMEOUT = "first token timeout"

/**
 * Reads one chunk with a deadline.
 *
 * The timer is cleared on the happy path: an armed-but-unresolved timer per
 * chunk would accumulate across a long stream. The caller must cancel the
 * reader when this rejects, because the underlying read is still pending and
 * releasing a reader that has a pending read throws.
 */
async function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  ms: number
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`no token within ${ms}ms`)
          error.name = "TimeoutError"
          reject(error)
        }, ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Streaming failover across provider targets.
 *
 * Ordering respects circuit state and daily budgets before spending a request.
 * The behaviour that matters most is what happens after text has started
 * flowing: failover is abandoned, because switching provider mid-sentence
 * would stitch two different answers together. The partial answer is kept and
 * flagged, and the UI offers regenerate.
 */
export function createGateway(deps: GatewayDeps = {}): Gateway {
  const fetchImpl = deps.fetchImpl ?? fetch
  const health = deps.health ?? createProviderHealth()
  const quota = deps.quota ?? createQuotaTracker()
  const now = deps.now ?? Date.now

  return {
    async streamChat({
      messages,
      targets,
      signal,
      onDelta,
      onReasoning,
      temperature = 0.1,
      maxOutputTokens,
      firstTokenTimeoutMs = DEFAULT_FIRST_TOKEN_MS,
      streamTimeoutMs = DEFAULT_STREAM_MS,
    }) {
      const attempts: AttemptOutcome[] = []
      let rateLimited = false

      const states = await health.load(targets.map((t) => t.id))

      for (const target of targets) {
        if (signal.aborted) {
          return {
            ok: false,
            targetId: null,
            attempts,
            textChars: 0,
            truncated: false,
            midStreamFailure: false,
            rateLimited: false,
            aborted: true,
          }
        }

        const startedAt = now()
        let state = states.get(target.id)
        if (!state) {
          state = {
            targetId: target.id,
            consecutiveFailures: 0,
            openUntil: null,
            lastFailureKind: null,
            lastStatus: null,
            lastError: null,
            lastUsedAt: null,
            successCount: 0,
            failureCount: 0,
          }
        }

        if (!health.isAvailable(state, startedAt)) {
          attempts.push({ targetId: target.id, outcome: "circuit_open", ms: 0 })
          continue
        }

        if (!(await quota.consume(target.id, target.dailyRequestBudget))) {
          attempts.push({ targetId: target.id, outcome: "quota_exhausted", ms: 0 })
          continue
        }

        const headers: Record<string, string> = {
          Authorization: `Bearer ${target.apiKey}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          ...(target.headers ?? {}),
        }

        let response: Response
        try {
          response = await fetchImpl(target.url, {
            method: "POST",
            headers,
            body: JSON.stringify({
              model: target.model,
              stream: true,
              temperature,
              max_tokens: maxOutputTokens ?? target.maxOutputTokens,
              messages,
            }),
            signal,
          })
        } catch (error) {
          if (isAbort(error, signal)) {
            return {
              ok: false,
              targetId: null,
              attempts,
              textChars: 0,
              truncated: false,
              midStreamFailure: false,
              rateLimited: false,
              aborted: true,
            }
          }
          const decision = classifyFailure({ error })
          await health.recordFailure(state, decision)
          attempts.push({
            targetId: target.id,
            outcome: decision.kind,
            status: null,
            ms: now() - startedAt,
          })
          continue
        }

        if (!response.ok || !response.body) {
          const decision = classifyFailure({
            status: response.status,
            retryAfterSeconds: readRetryAfter(response),
          })
          if (decision.kind === "rate_limited") {
            rateLimited = true
          }
          await health.recordFailure(state, decision, response.status)
          attempts.push({
            targetId: target.id,
            outcome: decision.kind,
            status: response.status,
            ms: now() - startedAt,
          })
          // Drain the body so the connection can be reused rather than
          // left half-read.
          await response.text().catch(() => "")
          continue
        }

        const parser = createSseParser()
        const decoder = new TextDecoder()
        const reader = response.body.getReader()
        const deadline = startedAt + streamTimeoutMs
        let textChars = 0
        let truncated = false
        let midStreamFailure = false
        let streamError: string | null = null
        let firstTokenSeen = false

        try {
          for (;;) {
            if (now() > deadline) {
              truncated = true
              streamError = "stream timeout"
              break
            }

            const budgetMs = firstTokenSeen
              ? deadline - now()
              : Math.min(firstTokenTimeoutMs, deadline - now())
            const read = await readWithTimeout(reader, Math.max(1, budgetMs))

            if (read.done) break
            if (!read.value) continue

            for (const frame of parser.push(decoder.decode(read.value, { stream: true }))) {
              if (frame.error) {
                streamError = frame.error
                continue
              }
              if (frame.finishReason === "length") truncated = true
              if (frame.reasoning) onReasoning?.(frame.reasoning)
              if (frame.delta) {
                firstTokenSeen = true
                textChars += frame.delta.length
                onDelta(frame.delta)
              }
            }
          }

          for (const frame of parser.flush()) {
            if (frame.finishReason === "length") truncated = true
            if (frame.reasoning) onReasoning?.(frame.reasoning)
            if (frame.delta) {
              textChars += frame.delta.length
              onDelta(frame.delta)
            }
          }
        } catch (error) {
          if (isAbort(error, signal)) {
            return {
              ok: false,
              targetId: null,
              attempts,
              textChars,
              truncated,
              midStreamFailure: false,
              rateLimited: false,
              aborted: true,
            }
          }
          if ((error as { name?: string }).name === "TimeoutError") {
            truncated = true
            streamError = FIRST_TOKEN_TIMEOUT
            // The deadline fired while a read was still pending. Releasing a
            // reader in that state throws, so cancel the stream first — the
            // provider is going to be dropped anyway.
            await reader.cancel().catch(() => {})
          } else {
            midStreamFailure = true
            streamError = (error as Error).message
          }
        } finally {
          try {
            reader.releaseLock()
          } catch {
            // Already released, or cancelled above by the timeout path.
          }
        }

        // A provider that produced usable text has succeeded, even if it was
        // cut short: the partial answer is preserved and flagged instead of
        // being replaced by a different provider's attempt.
        if (textChars > 0) {
          await health.recordSuccess(state)
          attempts.push({
            targetId: target.id,
            outcome: midStreamFailure || truncated ? "partial" : "ok",
            status: 200,
            ms: now() - startedAt,
          })
          return {
            ok: true,
            targetId: target.id,
            attempts,
            textChars,
            truncated: truncated || midStreamFailure,
            midStreamFailure,
            rateLimited: false,
            aborted: false,
          }
        }

        // Distinguishing the two zero-text outcomes matters: a first-token
        // timeout is a latency fault the next target may not share, while an
        // empty `length` finish is the "spent the whole budget thinking"
        // failure that took the bot down before.
        const decision: FailureDecision =
          streamError === FIRST_TOKEN_TIMEOUT
            ? classifyFailure({ error: { name: "TimeoutError" } })
            : classifyFailure({
                status: 200,
                finishReason: truncated ? "length" : "stop",
                textChars: 0,
              })
        await health.recordFailure(
          { ...state, lastError: streamError },
          decision,
          200
        )
        attempts.push({
          targetId: target.id,
          outcome: decision.kind,
          status: 200,
          ms: now() - startedAt,
        })
      }

      return {
        ok: false,
        targetId: null,
        attempts,
        textChars: 0,
        truncated: false,
        midStreamFailure: false,
        rateLimited,
        aborted: false,
      }
    },
  }
}
