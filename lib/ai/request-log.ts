// lib/ai/request-log.ts
import "server-only"
import { createAdminClient } from "@/utils/supabase/admin"

/** Structural view of the admin client, covering only the insert this module makes. */
export interface RequestLogClient {
  from(table: string): {
    insert(values: Record<string, unknown>): Promise<{ error: { message: string } | null }>
  }
}

export interface AttemptRecord {
  targetId: string
  outcome: string
  status?: number | null
}

export interface RequestLogEntry {
  outcome: string
  attempts: AttemptRecord[]
  userId?: string | null
  conversationId?: string | null
  targetId?: string | null
  planMs?: number | null
  retrieveMs?: number | null
  ttftMs?: number | null
  totalMs?: number | null
  docCount?: number | null
  cacheHit?: boolean
  degradedReason?: string | null
  promptTokens?: number | null
  completionTokens?: number | null
}

export interface RequestLogDeps {
  client?: RequestLogClient | null
}

/**
 * Fire-and-forget observability.
 *
 * Never throws and never awaited on the response path: a logging failure must
 * not turn a successful answer into an error, and it must not add latency to
 * the stream.
 */
export async function logRequest(
  entry: RequestLogEntry,
  deps: RequestLogDeps = {}
): Promise<void> {
  const client =
    deps.client === undefined ? (createAdminClient() as RequestLogClient | null) : deps.client
  if (!client) return

  try {
    const { error } = await client.from("ai_request_log").insert({
      user_id: entry.userId ?? null,
      conversation_id: entry.conversationId ?? null,
      target_id: entry.targetId ?? null,
      outcome: entry.outcome,
      plan_ms: entry.planMs ?? null,
      retrieve_ms: entry.retrieveMs ?? null,
      ttft_ms: entry.ttftMs ?? null,
      total_ms: entry.totalMs ?? null,
      attempts: entry.attempts,
      doc_count: entry.docCount ?? null,
      cache_hit: entry.cacheHit ?? false,
      degraded_reason: entry.degradedReason ?? null,
      prompt_tokens: entry.promptTokens ?? null,
      completion_tokens: entry.completionTokens ?? null,
    })
    if (error) console.error("[ai-log] insert failed", error.message)
  } catch (err) {
    console.error("[ai-log] insert threw", err)
  }
}
