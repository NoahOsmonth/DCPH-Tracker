import * as React from "react"
import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ChatTransport, UIMessage, UIMessageChunk } from "ai"
import { PARTS, PROTOCOL_VERSION } from "@/lib/ai/stream/protocol"
import type { CitationReport } from "@/lib/ai/citations"
import type { EvidenceRef } from "@/lib/ai/pipeline/assemble"
import { ChatWidget } from "@/components/chat/ChatWidget"

/**
 * The widget as the reader drives it: open the panel, send a turn, stop it,
 * regenerate it, edit it.
 *
 * Every transport here is scripted and the two collaborators that would reach
 * outside the test — Supabase's browser client and the auth modal — are mocked,
 * because the dom project has no `.env.local` and a component test must never
 * touch a socket. `ChatWidget`'s `transport` prop is the seam the send/stop/
 * regenerate/edit tests drive; only the error test uses the real default
 * transport, and it stubs `fetch` for the one request it makes.
 */

// jsdom implements no layout and no scrolling: `Element.prototype.scrollTo` does
// not exist at all, and the widget's scroll-to-bottom effect calls it on every
// transcript change. A no-op is the honest stub — the effect's contract here is
// only that it does not throw.
Element.prototype.scrollTo = () => {}

// `vi.hoisted` because the two `vi.mock` factories below are hoisted above the
// imports and would otherwise close over bindings still in their temporal dead
// zone when the mocked module is first imported.
const mocks = vi.hoisted(() => ({
  /** What `createClient().auth.getUser()` resolves with, per test. */
  user: null as { id: string } | null,
  openAuthModal: vi.fn(),
}))

vi.mock("@/utils/supabase/client", () => ({
  createClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: mocks.user } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
  }),
}))

vi.mock("@/lib/auth-modal", () => ({
  openAuthModal: mocks.openAuthModal,
}))

type Part = UIMessage["parts"][number]
type User = ReturnType<typeof userEvent.setup>

const REF: EvidenceRef = { n: 1, id: "ep-1", tag: "[RET]", label: "Episode 1" }
const REPORT: CitationReport = { cited: [REF], unknown: [], valid: true, uncited: false }

function dataPart(type: `data-${string}`, data: unknown): Part {
  return { type, data }
}

/** A whole turn, parts and all, as the route emits it. */
function completeTurnChunks(delta: string): UIMessageChunk[] {
  return [
    dataPart(PARTS.activity, {
      protocol: PROTOCOL_VERSION,
      planSource: "router",
      tools: ["search_catalog"],
      timings: { planMs: 12, retrieveMs: 34, assembleMs: 56 },
    }) as UIMessageChunk,
    dataPart(PARTS.evidence, { refs: [REF] }) as UIMessageChunk,
    { type: "text-start", id: "answer" },
    { type: "text-delta", id: "answer", delta },
    { type: "text-end", id: "answer" },
    dataPart(PARTS.citations, { report: REPORT }) as UIMessageChunk,
  ]
}

interface TransportCall {
  trigger: "submit-message" | "regenerate-message"
  messages: UIMessage[]
  messageId: string | undefined
}

/** A transport that answers each call with a scripted, already-closed stream. */
function scriptedTransport(script: (call: TransportCall, index: number) => UIMessageChunk[]) {
  const calls: TransportCall[] = []
  const transport: ChatTransport<UIMessage> = {
    async sendMessages(options) {
      const call: TransportCall = {
        trigger: options.trigger,
        messages: options.messages,
        messageId: options.messageId,
      }
      calls.push(call)
      const chunks = script(call, calls.length - 1)
      return new ReadableStream<UIMessageChunk>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk)
          controller.close()
        },
      })
    },
    async reconnectToStream() {
      return null
    },
  }
  return { transport, calls }
}

/** A transport whose stream stays open, so a test can stop it mid-answer. */
function controllableTransport() {
  const calls: TransportCall[] = []
  let controller: ReadableStreamDefaultController<UIMessageChunk> | null = null
  const transport: ChatTransport<UIMessage> = {
    async sendMessages(options) {
      calls.push({
        trigger: options.trigger,
        messages: options.messages,
        messageId: options.messageId,
      })
      return new ReadableStream<UIMessageChunk>({
        start(streamController) {
          controller = streamController
        },
      })
    },
    async reconnectToStream() {
      return null
    },
  }
  return {
    transport,
    calls,
    push(chunk: UIMessageChunk) {
      controller?.enqueue(chunk)
    },
  }
}

/** Render, open the panel, and hand back the user the interactions need. */
async function renderWidget(transport?: ChatTransport<UIMessage>): Promise<User> {
  const user = userEvent.setup()
  render(<ChatWidget transport={transport} />)
  await user.click(screen.getByRole("button", { name: "Open DCPH Bot" }))
  await screen.findByRole("dialog", { name: "DCPH Bot — episode finder" })
  return user
}

/** Type a turn into the composer and send it. */
async function sendText(user: User, text: string): Promise<void> {
  const box = screen.getByRole("textbox", { name: /ask about detective conan episodes/i })
  await user.type(box, text)
  await user.click(screen.getByRole("button", { name: "Send message" }))
}

beforeEach(() => {
  mocks.user = { id: "user-1" }
  mocks.openAuthModal.mockClear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe("the launcher and the panel", () => {
  it("toggles the panel from the launcher", async () => {
    const user = userEvent.setup()
    render(<ChatWidget />)

    const launcher = screen.getByRole("button", { name: "Open DCPH Bot" })
    expect(launcher).toHaveAttribute("aria-expanded", "false")
    // The 3.25rem square is an inline style, not a class.
    expect(launcher.style.height).toBe("3.25rem")
    expect(launcher.style.width).toBe("3.25rem")
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()

    await user.click(launcher)

    expect(screen.getByRole("button", { name: "Close DCPH Bot" })).toHaveAttribute(
      "aria-expanded",
      "true"
    )
    expect(screen.getByRole("dialog", { name: "DCPH Bot — episode finder" })).toBeInTheDocument()
  })

  it("keeps the panel's dialog contract and its enter transition", async () => {
    const user = userEvent.setup()
    render(<ChatWidget />)
    await user.click(screen.getByRole("button", { name: "Open DCPH Bot" }))

    const dialog = await screen.findByRole("dialog", { name: "DCPH Bot — episode finder" })
    expect(dialog).toHaveAttribute("aria-modal", "false")

    const tokens = new Set(dialog.className.split(/\s+/).filter(Boolean))
    expect(tokens.has("fixed")).toBe(true)
    expect(tokens.has("bottom-5")).toBe(true)
    expect(tokens.has("right-5")).toBe(true)
    expect(tokens.has("w-[min(26rem,calc(100vw-1.5rem))]")).toBe(true)
    expect(tokens.has("h-[min(34rem,calc(100vh-6rem))]")).toBe(true)

    // `mounted` flips on the next frame, which is the enter transition.
    await waitFor(() => expect(dialog.className).toContain("translate-y-0"))
    expect(dialog.className).toContain("opacity-100")
  })
})

describe("the signed-out gate", () => {
  it("renders the gate and opens the sign-in modal from its control", async () => {
    mocks.user = null
    const user = userEvent.setup()
    render(<ChatWidget />)
    await user.click(screen.getByRole("button", { name: "Open DCPH Bot" }))

    expect(await screen.findByText("Member Access Only")).toBeInTheDocument()
    expect(
      screen.queryByRole("textbox", { name: /ask about detective conan episodes/i })
    ).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Sign In to Chat" }))

    expect(mocks.openAuthModal).toHaveBeenCalledWith("signin")
  })
})

describe("the greeting and the suggestion chips", () => {
  it("renders the greeting as a static intro, not as a message", async () => {
    await renderWidget(scriptedTransport(() => completeTurnChunks("x")).transport)

    // Present, and not rendered through ChatMessage: a message with text would
    // carry the copy control, and the transcript has no turns at all yet.
    expect(screen.getByText(/your assistant for Detective Conan episodes/)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Copy response" })).not.toBeInTheDocument()
  })

  it("shows the suggestion chips only while the conversation is fresh", async () => {
    const user = await renderWidget(scriptedTransport(() => completeTurnChunks("Hello world")).transport)

    expect(screen.getByText("Suggested questions:")).toBeInTheDocument()

    await sendText(user, "hi")
    await screen.findByText("Hello world")

    expect(screen.queryByText("Suggested questions:")).not.toBeInTheDocument()
  })
})

describe("sending a turn", () => {
  it("shows the reader's turn and an assistant placeholder before any delta", async () => {
    const { transport, push } = controllableTransport()
    const user = await renderWidget(transport)

    await sendText(user, "Who is Bourbon?")

    expect(screen.getByText("Who is Bourbon?")).toBeInTheDocument()
    expect(await screen.findByLabelText("DCPH Bot is typing")).toBeInTheDocument()

    await act(async () => {
      push({ type: "text-start", id: "answer" })
      push({ type: "text-delta", id: "answer", delta: "Bourbon is Rei Furuya." })
    })

    expect(screen.getByText("Bourbon is Rei Furuya.")).toBeInTheDocument()
    // The placeholder gives way to the real message on its first part.
    expect(screen.queryByLabelText("DCPH Bot is typing")).not.toBeInTheDocument()
  })

  it("renders the settled answer through the parts path", async () => {
    const user = await renderWidget(
      scriptedTransport(() => completeTurnChunks("Bourbon is Rei Furuya.")).transport
    )

    await sendText(user, "Who is Bourbon?")
    await screen.findByText("Bourbon is Rei Furuya.")

    // The chips are built from the view model, so a chip on screen proves the
    // message was rendered with `view` rather than the legacy `{ message }`.
    expect(screen.getByRole("button", { name: "Episode 1" })).toBeInTheDocument()
    // The trace's toggle carries its summary and the action word together.
    expect(screen.getByRole("button", { name: /Show details/ })).toBeInTheDocument()
  })

  it("never sends the greeting to the server", async () => {
    const { transport, calls } = scriptedTransport(() => completeTurnChunks("Hello world"))
    const user = await renderWidget(transport)

    await sendText(user, "hi")
    await screen.findByText("Hello world")

    expect(calls).toHaveLength(1)
    expect(calls[0].messages).toHaveLength(1)
    expect(calls[0].messages[0].role).toBe("user")
    expect(JSON.stringify(calls[0].messages)).not.toContain("DCPH Bot")
  })

  it("renders the hook's error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "not signed in" }), {
            status: 401,
            headers: { "content-type": "application/json" },
          })
      )
    )
    const user = await renderWidget()

    await sendText(user, "hi")

    expect(await screen.findByText("not signed in")).toBeInTheDocument()
  })
})

describe("stopping and regenerating", () => {
  it("keeps the partial answer when the reader stops, and offers regenerate", async () => {
    const { transport, push } = controllableTransport()
    const user = await renderWidget(transport)

    await sendText(user, "Who is Bourbon?")
    await act(async () => {
      push({ type: "text-start", id: "answer" })
      push({ type: "text-delta", id: "answer", delta: "Bourbon is" })
    })
    await screen.findByText("Bourbon is")

    await user.click(screen.getByRole("button", { name: "Stop generating" }))

    expect(screen.getByText("Bourbon is")).toBeInTheDocument()
    expect(await screen.findByText("Stopped — this answer may be incomplete.")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Regenerate answer" })).toBeInTheDocument()
  })

  it("regenerates the last turn in place rather than appending", async () => {
    const { transport, calls } = scriptedTransport((_call, index) => [
      { type: "text-start", id: "answer" },
      { type: "text-delta", id: "answer", delta: index === 0 ? "first answer" : "second answer" },
      { type: "text-end", id: "answer" },
    ])
    const user = await renderWidget(transport)

    await sendText(user, "Who is Bourbon?")
    await screen.findByText("first answer")

    await user.click(screen.getByRole("button", { name: "Regenerate answer" }))

    expect(await screen.findByText("second answer")).toBeInTheDocument()
    expect(screen.queryByText("first answer")).not.toBeInTheDocument()
    expect(calls).toHaveLength(2)
    expect(calls[1].trigger).toBe("regenerate-message")
  })

  it("offers no regenerate while the answer is still streaming", async () => {
    const { transport, push } = controllableTransport()
    const user = await renderWidget(transport)

    await sendText(user, "hi")
    await screen.findByLabelText("DCPH Bot is typing")
    expect(screen.queryByRole("button", { name: "Regenerate answer" })).not.toBeInTheDocument()

    await act(async () => {
      push({ type: "text-start", id: "answer" })
      push({ type: "text-delta", id: "answer", delta: "still going" })
    })

    expect(screen.getByText("still going")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Regenerate answer" })).not.toBeInTheDocument()
  })
})

describe("Escape", () => {
  it("stops a streaming answer without closing the panel", async () => {
    const { transport, push } = controllableTransport()
    const user = await renderWidget(transport)

    await sendText(user, "Who is Bourbon?")
    await act(async () => {
      push({ type: "text-start", id: "answer" })
      push({ type: "text-delta", id: "answer", delta: "Bourbon is" })
    })
    await screen.findByText("Bourbon is")

    await user.keyboard("{Escape}")

    // Stopping is not closing: the panel and the partial answer it holds stay.
    expect(screen.getByRole("dialog", { name: "DCPH Bot — episode finder" })).toBeInTheDocument()
    expect(screen.getByText("Bourbon is")).toBeInTheDocument()
    expect(await screen.findByText("Stopped — this answer may be incomplete.")).toBeInTheDocument()
  })

  it("stops a turn sent from a chip, where the composer never took focus", async () => {
    const { transport } = controllableTransport()
    const user = await renderWidget(transport)

    await user.click(screen.getByRole("button", { name: /What should I watch next/ }))
    await screen.findByLabelText("DCPH Bot is typing")
    expect(screen.getByRole("button", { name: "Stop generating" })).toBeInTheDocument()

    await user.keyboard("{Escape}")

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Stop generating" })).not.toBeInTheDocument()
    )
    expect(screen.getByRole("dialog", { name: "DCPH Bot — episode finder" })).toBeInTheDocument()
  })

  it("closes the panel once nothing is streaming", async () => {
    const user = await renderWidget(
      scriptedTransport(() => completeTurnChunks("Hello world")).transport
    )

    await user.keyboard("{Escape}")

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  it("closes the panel from the signed-out gate, where there is no session at all", async () => {
    mocks.user = null
    const user = userEvent.setup()
    render(<ChatWidget />)
    await user.click(screen.getByRole("button", { name: "Open DCPH Bot" }))
    await screen.findByText("Member Access Only")

    await user.keyboard("{Escape}")

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })
})

describe("editing a turn", () => {
  it("truncates the later turns and resends the edited text", async () => {
    const { transport, calls } = scriptedTransport((_call, index) => [
      { type: "text-start", id: "answer" },
      { type: "text-delta", id: "answer", delta: index === 0 ? "original answer" : "new answer" },
      { type: "text-end", id: "answer" },
    ])
    const user = await renderWidget(transport)

    await sendText(user, "original question")
    await screen.findByText("original answer")

    await user.click(screen.getByRole("button", { name: "Edit message" }))
    const box = screen.getByRole("textbox", { name: "Edit your message" })
    await user.clear(box)
    await user.type(box, "edited question")
    await user.click(screen.getByRole("button", { name: "Save" }))

    expect(await screen.findByText("new answer")).toBeInTheDocument()
    expect(screen.getByText("edited question")).toBeInTheDocument()
    expect(screen.queryByText("original answer")).not.toBeInTheDocument()
    // The transport saw the truncated transcript: the edited turn is all that is
    // left, so the server rewrites its own transcript from the normal write path.
    expect(calls).toHaveLength(2)
    expect(calls[1].messages).toHaveLength(1)
  })
})

describe("starting a new conversation", () => {
  it("clears the transcript and brings the chips back", async () => {
    const user = await renderWidget(scriptedTransport(() => completeTurnChunks("Hello world")).transport)

    await sendText(user, "hi")
    await screen.findByText("Hello world")

    await user.click(screen.getByRole("button", { name: "Start a new conversation" }))

    expect(screen.queryByText("Hello world")).not.toBeInTheDocument()
    expect(screen.queryByText("hi")).not.toBeInTheDocument()
    expect(screen.getByText("Suggested questions:")).toBeInTheDocument()
  })
})
