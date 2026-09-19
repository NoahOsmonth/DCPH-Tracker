// app/api/ai-chat/route.integration.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const getUser = vi.fn()
const maybeSingle = vi.fn()

vi.mock("@/utils/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser },
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle }) }),
    }),
  }),
}))

const searchAll = vi.fn()
vi.mock("@/lib/chat/search", () => ({
  searchAll: (...args: unknown[]) => searchAll(...args),
}))

vi.mock("@/lib/chat/prompt", () => ({
  buildSystemPrompt: () => "SYSTEM PROMPT",
}))

const rateLimitPersistent = vi.fn()
vi.mock("@/lib/rate-limit-db", () => ({
  rateLimitPersistent: (...args: unknown[]) => rateLimitPersistent(...args),
}))

const logRequest = vi.fn()
vi.mock("@/lib/ai/request-log", () => ({
  logRequest: (...args: unknown[]) => logRequest(...args),
}))
vi.mock("@/lib/chat/persistence", () => ({ createRequestPersistence: async () => null }))

// Inert stores: no circuit is open, every daily budget has room. See the note
// above — these stand in for modules that cannot be imported without env.
vi.mock("@/lib/ai/provider-health", () => ({
  createProviderHealth: () => ({
    load: async () => new Map(),
    isAvailable: () => true,
    recordFailure: async () => {},
    recordSuccess: async () => {},
  }),
}))

vi.mock("@/lib/ai/quota", () => ({
  createQuotaTracker: () => ({ consume: async () => true }),
}))

const KEY = "test-key"

function sse(...deltas: string[]): string {
  return deltas
    .map((d) => `data: {"choices":[{"delta":{"content":${JSON.stringify(d)}}}]}\n\n`)
    .join("")
}

function providerResponse(body: string, status = 200) {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(body))
        controller.close()
      },
    }),
    { status }
  )
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/ai-chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      host: "localhost",
      origin: "http://localhost",
      ...headers,
    },
    body: JSON.stringify(body),
  })
}

async function readText(response: Response): Promise<string> {
  return await response.text()
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.AI_PIPELINE = "v1"
  process.env.GROQ_API_KEY = KEY
  delete process.env.GEMINI_API_KEY
  delete process.env.OPENROUTER_API_KEY
  delete process.env.OPENROUTER_API_KEY_2
  delete process.env.CEREBRAS_API_KEY
  getUser.mockResolvedValue({ data: { user: { id: "user-1" } } })
  maybeSingle.mockResolvedValue({ data: { display_name: "Noah", username: "noah" } })
  rateLimitPersistent.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 })
  searchAll.mockResolvedValue({ episodes: [], cases: [], dcwWiki: [] })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("POST /api/ai-chat", () => {
  it("streams an answer from the provider", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => providerResponse(sse("Hi ", "there"))))
    const { POST } = await import("@/app/api/ai-chat/route")

    const response = await POST(post({ message: "Who is Haibara?" }))
    expect(response.status).toBe(200)
    expect(await readText(response)).toBe("Hi there")
  })

  it("rejects an unauthenticated caller with 401", async () => {
    getUser.mockResolvedValue({ data: { user: null } })
    vi.stubGlobal("fetch", vi.fn())
    const { POST } = await import("@/app/api/ai-chat/route")

    const response = await POST(post({ message: "hi" }))
    expect(response.status).toBe(401)
  })

  it("rejects a cross-origin request with 403", async () => {
    vi.stubGlobal("fetch", vi.fn())
    const { POST } = await import("@/app/api/ai-chat/route")

    const response = await POST(
      post({ message: "hi" }, { origin: "https://evil.example", host: "localhost" })
    )
    expect(response.status).toBe(403)
  })

  it("returns 429 with Retry-After when the rate limit is exhausted", async () => {
    rateLimitPersistent.mockResolvedValue({ allowed: false, retryAfterSeconds: 42 })
    vi.stubGlobal("fetch", vi.fn())
    const { POST } = await import("@/app/api/ai-chat/route")

    const response = await POST(post({ message: "hi" }))
    expect(response.status).toBe(429)
    expect(response.headers.get("Retry-After")).toBe("42")
  })

  it("never calls a provider for an out-of-domain request", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    const { POST } = await import("@/app/api/ai-chat/route")

    const response = await POST(post({ message: "Write me a Python web scraper" }))
    expect(response.status).toBe(200)
    expect(await readText(response)).toMatch(/Detective Conan/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("refuses a question retrieval could not ground in the series", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    const { POST } = await import("@/app/api/ai-chat/route")

    const response = await POST(post({ message: "Who won the 1998 World Cup?" }))
    expect(response.status).toBe(200)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("labels a partial answer instead of presenting it as complete", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const encoder = new TextEncoder()
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode(sse("The victim was")))
            },
            // The error must come from pull(), not start(): erroring a stream
            // resets its queue, so enqueue-then-error in the same callback
            // discards the chunk and the route correctly sees an empty
            // response instead of a partial one.
            pull(controller) {
              controller.error(new Error("connection reset"))
            },
          }),
          { status: 200 }
        )
      })
    )
    const { POST } = await import("@/app/api/ai-chat/route")

    const text = await readText(await POST(post({ message: "Who is Haibara?" })))
    expect(text).toContain("The victim was")
    expect(text).toContain("cut short")
  })

  it("reports capacity exhaustion when every provider is rate limited", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("busy", { status: 429 })))
    const { POST } = await import("@/app/api/ai-chat/route")

    const text = await readText(await POST(post({ message: "Who is Haibara?" })))
    expect(text).toMatch(/at capacity/i)
  })

  it("falls over to the next model when the first returns empty content", async () => {
    let call = 0
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call += 1
        if (call === 1) {
          return providerResponse('data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n')
        }
        return providerResponse(sse("Second model answered"))
      })
    )
    const { POST } = await import("@/app/api/ai-chat/route")

    const text = await readText(await POST(post({ message: "Who is Haibara?" })))
    expect(text).toBe("Second model answered")
  })

  it("rejects an oversized message with 400", async () => {
    vi.stubGlobal("fetch", vi.fn())
    const { POST } = await import("@/app/api/ai-chat/route")

    const response = await POST(post({ message: "x".repeat(1001) }))
    expect(response.status).toBe(400)
  })

  it("rejects a non-JSON body with 400", async () => {
    vi.stubGlobal("fetch", vi.fn())
    const { POST } = await import("@/app/api/ai-chat/route")

    const response = await POST(
      new Request("http://localhost/api/ai-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", host: "localhost" },
        body: "not json",
      })
    )
    expect(response.status).toBe(400)
  })

  it("returns 500 when no provider is configured", async () => {
    delete process.env.GROQ_API_KEY
    vi.stubGlobal("fetch", vi.fn())
    const { POST } = await import("@/app/api/ai-chat/route")

    const response = await POST(post({ message: "hi" }))
    expect(response.status).toBe(500)
  })
})
