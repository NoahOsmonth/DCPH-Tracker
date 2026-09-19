// lib/ai/__tests__/request-log.test.ts
import { describe, expect, it } from "vitest"
import { logRequest, type RequestLogClient } from "@/lib/ai/request-log"

function fakeClient() {
  const inserted: Record<string, unknown>[] = []
  const client: RequestLogClient = {
    from: () => ({
      insert: async (values: Record<string, unknown>) => {
        inserted.push(values)
        return { error: null }
      },
    }),
  }
  return { client, inserted }
}

describe("logRequest", () => {
  it("inserts a row with the latency breakdown", async () => {
    const { client, inserted } = fakeClient()
    await logRequest(
      {
        userId: "u1",
        targetId: "groq:a",
        outcome: "ok",
        planMs: 210,
        retrieveMs: 480,
        ttftMs: 900,
        totalMs: 3200,
        attempts: [{ targetId: "groq:a", outcome: "ok" }],
        docCount: 8,
        cacheHit: false,
        degradedReason: null,
      },
      { client }
    )
    expect(inserted).toHaveLength(1)
    expect(inserted[0]).toMatchObject({
      user_id: "u1",
      target_id: "groq:a",
      outcome: "ok",
      plan_ms: 210,
      retrieve_ms: 480,
      ttft_ms: 900,
      total_ms: 3200,
      doc_count: 8,
      cache_hit: false,
      degraded_reason: null,
    })
    expect(inserted[0].attempts).toEqual([{ targetId: "groq:a", outcome: "ok" }])
  })

  it("does not throw when no client is configured", async () => {
    await expect(
      logRequest({ outcome: "error", attempts: [] }, { client: null })
    ).resolves.toBeUndefined()
  })

  it("swallows store errors", async () => {
    const client: RequestLogClient = {
      from: () => ({
        insert: async () => ({ error: { message: "boom" } }),
      }),
    }
    await expect(logRequest({ outcome: "error", attempts: [] }, { client })).resolves.toBeUndefined()
  })

  it("records a degraded reason when retrieval was cut short", async () => {
    const { client, inserted } = fakeClient()
    await logRequest(
      { outcome: "ok", attempts: [], degradedReason: "retrieval_budget_exceeded" },
      { client }
    )
    expect(inserted[0].degraded_reason).toBe("retrieval_budget_exceeded")
  })
})
