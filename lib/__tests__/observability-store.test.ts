/**
 * The request-log read side, its Supabase adapter, and the policy layer over
 * them.
 *
 * Nothing here constructs a Supabase client or touches a network (constraint
 * 8): the adapter is tested against a hand-written recording fake typed against
 * the locally declared client interface, and the policy against a recording
 * fake port, so the calls -- above all the clamped window and the capped limit
 * -- are assertions rather than assumptions. The clock is injected, so no test
 * reads a real timer either.
 */

import { describe, expect, it } from "vitest"
import {
  DEFAULT_WINDOW_MS,
  MAX_WINDOW_MS,
  NULL_BUCKET,
  PERCENTILE_SAMPLE_CAP,
  RECENT_ROW_LIMIT,
  createObservabilityStore,
  createSupabaseObservabilityPort,
  percentile,
  type FeedbackCountQuery,
  type ObservabilityClient,
  type ObservabilityPort,
  type ObservabilityQuery,
  type ObservabilityResult,
  type RequestLogRow,
} from "@/lib/ai/observability/store"

const NOW_ISO = "2026-09-19T12:00:00.000Z"
const NOW = Date.parse(NOW_ISO)
const HOUR = 60 * 60 * 1000
const USER_ID = "11111111-1111-4111-8111-111111111111"
const ROW_ID = "99999999-9999-4999-8999-999999999999"

const LOG_TABLE = "ai_request_log"
const FEEDBACK_TABLE = "ai_message_feedback"

/** The stored row `listRequests` reads back, with both nullable fields null. */
const LOG_ROW: Record<string, unknown> = {
  id: ROW_ID,
  created_at: NOW_ISO,
  outcome: "ok",
  target_id: "groq:a",
  plan_source: null,
  degraded_reason: null,
  plan_ms: 12,
  retrieve_ms: 34,
  ttft_ms: 56,
  total_ms: 78,
  doc_count: 4,
  citations_valid: null,
  tools: ["retrieve", "wiki"],
  prompt_tokens: 100,
  completion_tokens: 20,
  user_id: USER_ID,
  conversation_id: null,
}

const LOG_ROW_MAPPED: RequestLogRow = {
  id: ROW_ID,
  createdAt: NOW,
  outcome: "ok",
  targetId: "groq:a",
  planSource: null,
  degradedReason: null,
  planMs: 12,
  retrieveMs: 34,
  ttftMs: 56,
  totalMs: 78,
  docCount: 4,
  citationsValid: null,
  tools: ["retrieve", "wiki"],
  promptTokens: 100,
  completionTokens: 20,
  userId: USER_ID,
  conversationId: null,
}

interface RecordedClientCall {
  table: string
  method: string
  args: unknown[]
}

interface ClientScript {
  /** The rows a list read returns. */
  rows?: Record<string, unknown>[] | null
  /** The number a `count: "exact"` read reports. */
  count?: number | null
  /** A PostgREST failure: every call resolves with `{ error }`. */
  error?: { message: string }
  /** A dropped connection: every call rejects instead of resolving. */
  reject?: Error
}

/**
 * A scripted, recording stand-in for the Supabase client, typed against the
 * adapter's locally declared interface so it needs no `@supabase/supabase-js`
 * import and never reaches the network.
 */
function createRecordingClient(script: ClientScript = {}): {
  client: ObservabilityClient
  calls: RecordedClientCall[]
} {
  const calls: RecordedClientCall[] = []

  function record(table: string, method: string, args: unknown[]): void {
    calls.push({ table, method, args })
  }

  function settle<T>(value: T): Promise<T> {
    return script.reject ? Promise.reject(script.reject) : Promise.resolve(value)
  }

  function query(table: string): ObservabilityQuery {
    const chain: ObservabilityQuery = {
      then(onFulfilled, onRejected) {
        const reply: ObservabilityResult = script.error
          ? { data: null, error: script.error }
          : { data: script.rows ?? null, error: null, count: script.count ?? null }
        return settle(reply).then(onFulfilled, onRejected)
      },
      gte(column, value) {
        record(table, "gte", [column, value])
        return chain
      },
      lt(column, value) {
        record(table, "lt", [column, value])
        return chain
      },
      eq(column, value) {
        record(table, "eq", [column, value])
        return chain
      },
      not(column, operator, value) {
        record(table, "not", [column, operator, value])
        return chain
      },
      order(column, options) {
        record(table, "order", [column, options])
        return chain
      },
      limit(count) {
        record(table, "limit", [count])
        return chain
      },
    }
    return chain
  }

  const client: ObservabilityClient = {
    from(table) {
      return {
        select(columns, options) {
          // The options bag is absent on a row read, so recording it
          // conditionally keeps the assertions honest about which read ran.
          record(table, "select", options === undefined ? [columns] : [columns, options])
          return query(table)
        },
      }
    },
  }

  return { client, calls }
}

describe("createSupabaseObservabilityPort countRequests", () => {
  it("head-counts the window and returns the exact number", async () => {
    const { client, calls } = createRecordingClient({ count: 7 })

    await expect(
      createSupabaseObservabilityPort(client).countRequests({ sinceMs: NOW - HOUR, untilMs: NOW })
    ).resolves.toBe(7)

    // A head count: the rows are never transferred, which is what makes an
    // exact count affordable over any window.
    expect(calls).toEqual([
      { table: LOG_TABLE, method: "select", args: ["id", { count: "exact", head: true }] },
      { table: LOG_TABLE, method: "gte", args: ["created_at", new Date(NOW - HOUR).toISOString()] },
      { table: LOG_TABLE, method: "lt", args: ["created_at", new Date(NOW).toISOString()] },
    ])
  })

  it("reads a missing count as zero rather than NaN", async () => {
    const { client } = createRecordingClient({ count: null })

    await expect(
      createSupabaseObservabilityPort(client).countRequests({ sinceMs: NOW - HOUR, untilMs: NOW })
    ).resolves.toBe(0)
  })

  it("rejects with the database's message and the method that failed", async () => {
    const { client } = createRecordingClient({ error: { message: "relation does not exist" } })

    await expect(
      createSupabaseObservabilityPort(client).countRequests({ sinceMs: NOW - HOUR, untilMs: NOW })
    ).rejects.toThrow("[ai-observability] countRequests: relation does not exist")
  })
})

describe("createSupabaseObservabilityPort listRequests", () => {
  it("reads the newest rows in the window and maps every field", async () => {
    const { client, calls } = createRecordingClient({ rows: [LOG_ROW] })

    await expect(
      createSupabaseObservabilityPort(client).listRequests({
        sinceMs: NOW - HOUR,
        untilMs: NOW,
        limit: 50,
      })
    ).resolves.toEqual([LOG_ROW_MAPPED])

    expect(calls).toEqual([
      { table: LOG_TABLE, method: "select", args: [expect.stringContaining("degraded_reason")] },
      { table: LOG_TABLE, method: "gte", args: ["created_at", new Date(NOW - HOUR).toISOString()] },
      { table: LOG_TABLE, method: "lt", args: ["created_at", new Date(NOW).toISOString()] },
      { table: LOG_TABLE, method: "order", args: ["created_at", { ascending: false }] },
      { table: LOG_TABLE, method: "limit", args: [50] },
    ])
  })

  it("issues no date predicate when no window is given", async () => {
    const { client, calls } = createRecordingClient({ rows: [] })

    // `recent` reads the newest rows regardless of age, so the query is bounded
    // by the limit alone and the index still supplies the order.
    await expect(createSupabaseObservabilityPort(client).listRequests({ limit: 5 })).resolves.toEqual([])

    expect(calls).toEqual([
      { table: LOG_TABLE, method: "select", args: [expect.stringContaining("created_at")] },
      { table: LOG_TABLE, method: "order", args: ["created_at", { ascending: false }] },
      { table: LOG_TABLE, method: "limit", args: [5] },
    ])
  })

  it("keeps a null tool list distinct from an empty one", async () => {
    const { client } = createRecordingClient({ rows: [{ ...LOG_ROW, tools: null }] })

    const rows = await createSupabaseObservabilityPort(client).listRequests({ limit: 1 })

    // A v1 row's null tools and a pipeline row that dispatched nothing are
    // different facts, and the mapping must not collapse them.
    expect(rows[0]?.tools).toBeNull()
  })

  it("rejects with the database's message and the method that failed", async () => {
    const { client } = createRecordingClient({ error: { message: "permission denied" } })

    await expect(createSupabaseObservabilityPort(client).listRequests({ limit: 5 })).rejects.toThrow(
      "[ai-observability] listRequests: permission denied"
    )
  })
})

describe("createSupabaseObservabilityPort countFeedback", () => {
  it("counts one vote value in the window", async () => {
    const { client, calls } = createRecordingClient({ count: 3 })

    await expect(
      createSupabaseObservabilityPort(client).countFeedback({
        sinceMs: NOW - HOUR,
        untilMs: NOW,
        value: -1,
      })
    ).resolves.toBe(3)

    expect(calls).toEqual([
      { table: FEEDBACK_TABLE, method: "select", args: ["id", { count: "exact", head: true }] },
      { table: FEEDBACK_TABLE, method: "gte", args: ["created_at", new Date(NOW - HOUR).toISOString()] },
      { table: FEEDBACK_TABLE, method: "lt", args: ["created_at", new Date(NOW).toISOString()] },
      { table: FEEDBACK_TABLE, method: "eq", args: ["value", -1] },
    ])
  })

  it("narrows to noted votes with is-not-null, not an equality", async () => {
    const { client, calls } = createRecordingClient({ count: 2 })

    await createSupabaseObservabilityPort(client).countFeedback({
      sinceMs: NOW - HOUR,
      untilMs: NOW,
      hasNote: true,
    })

    // `note <> null` matches no row in SQL, so the filter has to be `is not
    // null` or every vote would count as un-noted.
    expect(calls).toContainEqual({ table: FEEDBACK_TABLE, method: "not", args: ["note", "is", null] })
  })

  it("rejects with the database's message and the method that failed", async () => {
    const { client } = createRecordingClient({ error: { message: "permission denied" } })

    await expect(
      createSupabaseObservabilityPort(client).countFeedback({ sinceMs: NOW - HOUR, untilMs: NOW })
    ).rejects.toThrow("[ai-observability] countFeedback: permission denied")
  })
})

interface RecordedPortCall {
  method: string
  args: unknown[]
}

interface PortScript {
  count?: number
  rows?: RequestLogRow[]
  /** A per-query answer, so the three feedback counts can differ. */
  feedback?: number | ((query: FeedbackCountQuery) => number)
  /** The one method that rejects, as a dropped connection would. */
  reject?: string
}

function createFakePort(script: PortScript = {}): {
  port: ObservabilityPort
  calls: RecordedPortCall[]
} {
  const calls: RecordedPortCall[] = []

  const port: ObservabilityPort = {
    async countRequests(window) {
      calls.push({ method: "countRequests", args: [window] })
      if (script.reject === "countRequests") throw new Error("countRequests unavailable")
      return script.count ?? 0
    },
    async listRequests(query) {
      calls.push({ method: "listRequests", args: [query] })
      if (script.reject === "listRequests") throw new Error("listRequests unavailable")
      return script.rows ?? []
    },
    async countFeedback(query) {
      calls.push({ method: "countFeedback", args: [query] })
      if (script.reject === "countFeedback") throw new Error("countFeedback unavailable")
      if (typeof script.feedback === "function") return script.feedback(query)
      return script.feedback ?? 0
    },
  }

  return { port, calls }
}

function row(overrides: Partial<RequestLogRow>): RequestLogRow {
  return {
    id: ROW_ID,
    createdAt: NOW - HOUR,
    outcome: "ok",
    targetId: "groq:a",
    planSource: "router",
    degradedReason: null,
    planMs: 10,
    retrieveMs: 20,
    ttftMs: 30,
    totalMs: 40,
    docCount: 3,
    citationsValid: true,
    tools: [],
    promptTokens: 100,
    completionTokens: 50,
    userId: null,
    conversationId: null,
    ...overrides,
  }
}

/**
 * Five rows that exercise every bucket: a null degraded_reason and a null
 * plan_source (the v1 shape), both citation verdicts and the unmeasured null, a
 * missing retrieval latency, and latency samples that are both odd and even in
 * length.
 */
const SUMMARY_ROWS: RequestLogRow[] = [
  row({
    id: "r1",
    outcome: "ok",
    degradedReason: null,
    planSource: "router",
    citationsValid: true,
    retrieveMs: 10,
    ttftMs: 100,
    totalMs: 200,
  }),
  row({
    id: "r2",
    outcome: "ok",
    degradedReason: "uncited",
    planSource: "router",
    citationsValid: false,
    retrieveMs: 20,
    ttftMs: 200,
    totalMs: 400,
  }),
  row({
    id: "r3",
    outcome: "partial",
    degradedReason: null,
    planSource: "model",
    citationsValid: null,
    retrieveMs: 30,
    ttftMs: 300,
    totalMs: 600,
  }),
  row({
    id: "r4",
    outcome: "error",
    degradedReason: "retrieval_failed",
    planSource: null,
    citationsValid: true,
    retrieveMs: null,
    ttftMs: 400,
    totalMs: 800,
  }),
  row({
    id: "r5",
    outcome: "rate_limited",
    degradedReason: "retrieval_failed",
    planSource: null,
    citationsValid: null,
    retrieveMs: null,
    ttftMs: null,
    totalMs: null,
  }),
]

describe("createObservabilityStore summary", () => {
  it("aggregates every bucket from the window's rows, nulls included", async () => {
    const { port, calls } = createFakePort({ count: 5, rows: SUMMARY_ROWS })
    const store = createObservabilityStore({ port, now: () => NOW })

    const summary = await store.summary({ sinceMs: NOW - HOUR, untilMs: NOW })

    expect(summary.requestCount).toBe(5)
    expect(summary.sampledRows).toBe(5)
    expect(summary.sampled).toBe(false)
    expect(summary.byOutcome).toEqual({ ok: 2, partial: 1, error: 1, rate_limited: 1 })
    // "no degradation" and "a v1 request" are counts of their own, not gaps.
    expect(summary.byDegradedReason).toEqual({ [NULL_BUCKET]: 2, uncited: 1, retrieval_failed: 2 })
    expect(summary.byPlanSource).toEqual({ router: 2, model: 1, [NULL_BUCKET]: 2 })
    expect(summary.citations).toEqual({ valid: 2, invalid: 1, unmeasured: 2 })

    // Odd sample: [10, 20, 30] -> p50 is the middle value, p95 interpolates.
    expect(summary.latency.retrieveMs).toEqual({ count: 3, p50: 20, p95: 29 })
    // Even sample: [100, 200, 300, 400] -> both quantiles interpolate.
    expect(summary.latency.ttftMs).toEqual({ count: 4, p50: 250, p95: 385 })
    expect(summary.latency.totalMs).toEqual({ count: 4, p50: 500, p95: 770 })

    expect(calls[0]?.args).toEqual([{ sinceMs: NOW - HOUR, untilMs: NOW }])
    expect(calls[1]?.args).toEqual([
      { sinceMs: NOW - HOUR, untilMs: NOW, limit: PERCENTILE_SAMPLE_CAP },
    ])
  })

  it("clamps a window wider than the maximum to the maximum", async () => {
    const { port, calls } = createFakePort({ rows: [] })
    const store = createObservabilityStore({ port, now: () => NOW })

    const summary = await store.summary({ sinceMs: NOW - 400 * 24 * HOUR, untilMs: NOW })

    // The caller asked for more than a year and got thirty days: the bound is
    // not a parameter, and the summary names the window it really read.
    expect(calls[0]?.args).toEqual([{ sinceMs: NOW - MAX_WINDOW_MS, untilMs: NOW }])
    expect(calls[1]?.args).toEqual([
      { sinceMs: NOW - MAX_WINDOW_MS, untilMs: NOW, limit: PERCENTILE_SAMPLE_CAP },
    ])
    expect(summary.sinceMs).toBe(NOW - MAX_WINDOW_MS)
    expect(summary.untilMs).toBe(NOW)
  })

  it("defaults an omitted window to the default window ending at the injected clock", async () => {
    const { port, calls } = createFakePort({ rows: [] })
    const store = createObservabilityStore({ port, now: () => NOW })

    await store.summary()

    expect(calls[0]?.args).toEqual([{ sinceMs: NOW - DEFAULT_WINDOW_MS, untilMs: NOW }])
    expect(calls[1]?.args).toEqual([
      { sinceMs: NOW - DEFAULT_WINDOW_MS, untilMs: NOW, limit: PERCENTILE_SAMPLE_CAP },
    ])
  })

  it("caps the sampled row read and says the breakdown was sampled", async () => {
    const rows = Array.from({ length: PERCENTILE_SAMPLE_CAP }, (_, index) => row({ id: `r${index}` }))
    const { port, calls } = createFakePort({ count: 5000, rows })
    const store = createObservabilityStore({ port, now: () => NOW })

    const summary = await store.summary({ sinceMs: NOW - HOUR, untilMs: NOW })

    // The count is exact while the breakdown is not, and the summary says so
    // rather than presenting a capped sample as the whole window.
    expect(summary.requestCount).toBe(5000)
    expect(summary.sampledRows).toBe(PERCENTILE_SAMPLE_CAP)
    expect(summary.sampled).toBe(true)
    expect(calls[1]?.args).toEqual([
      { sinceMs: NOW - HOUR, untilMs: NOW, limit: PERCENTILE_SAMPLE_CAP },
    ])
  })

  it("answers an empty window with zeros and issues no query", async () => {
    const { port, calls } = createFakePort({ rows: SUMMARY_ROWS })
    const store = createObservabilityStore({ port, now: () => NOW })

    const summary = await store.summary({ sinceMs: NOW, untilMs: NOW - HOUR })

    expect(calls).toEqual([])
    expect(summary).toEqual({
      sinceMs: NOW,
      untilMs: NOW - HOUR,
      requestCount: 0,
      sampledRows: 0,
      sampled: false,
      byOutcome: {},
      byDegradedReason: {},
      byPlanSource: {},
      citations: { valid: 0, invalid: 0, unmeasured: 0 },
      latency: {
        retrieveMs: { count: 0, p50: null, p95: null },
        ttftMs: { count: 0, p50: null, p95: null },
        totalMs: { count: 0, p50: null, p95: null },
      },
    })
  })

  it("answers an empty table with zeros, not null and not a crash", async () => {
    const { port } = createFakePort({ count: 0, rows: [] })
    const store = createObservabilityStore({ port, now: () => NOW })

    const summary = await store.summary({ sinceMs: NOW - HOUR, untilMs: NOW })

    expect(summary.requestCount).toBe(0)
    expect(summary.byOutcome).toEqual({})
    expect(summary.byDegradedReason).toEqual({})
    expect(summary.byPlanSource).toEqual({})
    expect(summary.citations).toEqual({ valid: 0, invalid: 0, unmeasured: 0 })
    expect(summary.latency.totalMs).toEqual({ count: 0, p50: null, p95: null })
    expect(summary.sampled).toBe(false)
  })

  it("propagates the port's failure unchanged", async () => {
    const { port } = createFakePort({ reject: "countRequests" })
    const store = createObservabilityStore({ port, now: () => NOW })

    await expect(store.summary({ sinceMs: NOW - HOUR, untilMs: NOW })).rejects.toThrow(
      "countRequests unavailable"
    )
  })
})

describe("createObservabilityStore recent", () => {
  it("caps a limit larger than the constant and asks for the cap", async () => {
    const { port, calls } = createFakePort({ rows: SUMMARY_ROWS })
    const store = createObservabilityStore({ port, now: () => NOW })

    await store.recent({ limit: 5000 })

    expect(calls).toEqual([{ method: "listRequests", args: [{ limit: RECENT_ROW_LIMIT }] }])
  })

  it("defaults an omitted limit to the constant", async () => {
    const { port, calls } = createFakePort({ rows: [] })
    const store = createObservabilityStore({ port, now: () => NOW })

    await store.recent()

    expect(calls).toEqual([{ method: "listRequests", args: [{ limit: RECENT_ROW_LIMIT }] }])
  })

  it("passes a smaller limit through untouched", async () => {
    const { port, calls } = createFakePort({ rows: [] })
    const store = createObservabilityStore({ port, now: () => NOW })

    await store.recent({ limit: 25 })

    expect(calls).toEqual([{ method: "listRequests", args: [{ limit: 25 }] }])
  })

  it("short-circuits a non-positive limit without issuing a query", async () => {
    const { port, calls } = createFakePort({ rows: SUMMARY_ROWS })
    const store = createObservabilityStore({ port, now: () => NOW })

    await expect(store.recent({ limit: 0 })).resolves.toEqual([])

    // An empty list must not cost a round trip (the `forMessages([])`
    // precedent).
    expect(calls).toEqual([])
  })
})

describe("createObservabilityStore feedbackSummary", () => {
  it("counts up, down and noted votes in the clamped window", async () => {
    const { port, calls } = createFakePort({
      feedback: (query) => (query.value === 1 ? 4 : query.value === -1 ? 2 : 3),
    })
    const store = createObservabilityStore({ port, now: () => NOW })

    const summary = await store.feedbackSummary({ sinceMs: NOW - HOUR, untilMs: NOW })

    expect(summary).toEqual({ sinceMs: NOW - HOUR, untilMs: NOW, up: 4, down: 2, noted: 3 })
    expect(calls.map((call) => call.method)).toEqual([
      "countFeedback",
      "countFeedback",
      "countFeedback",
    ])
    expect(calls.map((call) => call.args[0])).toEqual([
      { sinceMs: NOW - HOUR, untilMs: NOW, value: 1 },
      { sinceMs: NOW - HOUR, untilMs: NOW, value: -1 },
      { sinceMs: NOW - HOUR, untilMs: NOW, hasNote: true },
    ])
  })

  it("clamps the feedback window to the same maximum", async () => {
    const { port, calls } = createFakePort({ feedback: 0 })
    const store = createObservabilityStore({ port, now: () => NOW })

    await store.feedbackSummary({ sinceMs: NOW - 400 * 24 * HOUR, untilMs: NOW })

    expect(calls[0]?.args[0]).toEqual({ sinceMs: NOW - MAX_WINDOW_MS, untilMs: NOW, value: 1 })
  })

  it("answers an empty window with zeros and issues no query", async () => {
    const { port, calls } = createFakePort({ feedback: 9 })
    const store = createObservabilityStore({ port, now: () => NOW })

    await expect(store.feedbackSummary({ sinceMs: NOW, untilMs: NOW - HOUR })).resolves.toEqual({
      sinceMs: NOW,
      untilMs: NOW - HOUR,
      up: 0,
      down: 0,
      noted: 0,
    })

    expect(calls).toEqual([])
  })
})

describe("percentile", () => {
  it("takes the middle value of an odd sample", () => {
    expect(percentile([1, 2, 3], 0.5)).toBe(2)
    expect(percentile([1, 2, 3], 0.95)).toBeCloseTo(2.9, 10)
  })

  it("interpolates the two middle values of an even sample", () => {
    // Pinned so the definition cannot drift to a nearest-rank variant: p50 of
    // four values is 25, not 20 and not 30.
    expect(percentile([10, 20, 30, 40], 0.5)).toBe(25)
    expect(percentile([10, 20, 30, 40], 0.95)).toBeCloseTo(38.5, 10)
  })

  it("sorts a copy rather than the caller's array", () => {
    const values = [3, 1, 2]

    expect(percentile(values, 0.5)).toBe(2)
    expect(values).toEqual([3, 1, 2])
  })

  it("answers null for an empty sample", () => {
    expect(percentile([], 0.5)).toBeNull()
  })
})
