/**
 * Budgeted provenance assembly: the messages that reach the provider.
 *
 * This is the last stage before the model, and the only place that decides what
 * happens when the evidence does not fit. Five segments are measured and, when
 * over budget, evicted in a fixed order rather than truncated mid-sentence
 * (spec §8.2). Nothing here fetches, screens or judges relevance: the caller
 * hands over the already-screened, already-merged evidence and the assembler
 * spends it.
 *
 * Four properties the rest of Plan 4 reads:
 *
 * 1. **The block is the citation contract.** Each admitted document renders as
 *    `[E#]`, its tag, its label (the document title) and its wrapped body, one
 *    block per document, documents before wiki extracts. `report.evidence`
 *    lists exactly the blocks that were rendered, so an answer citing `[E2]`
 *    resolves to a real document (Task 9 validates against it, Phase 5 renders
 *    it). Numbering follows the input order and is re-densified after eviction:
 *    `[E1]` always exists while any evidence survives, and no gap can be cited.
 * 2. **Budgets are enforced by eviction.** Tokens are `chars / 4` — the memory
 *    module's `CHARS_PER_TOKEN`, imported rather than re-declared so the two
 *    cannot disagree. Evidence is evicted lowest fused rank first (`rrf`, then
 *    `score`, then `id`, all ascending — a total order, so the same input
 *    always evicts the same documents); a wiki extract is rankless and carries
 *    `rrf: 0`, so it is the first evidence to go. Turns are trimmed oldest-first
 *    and the newest turn is kept whole even when it alone overruns the ceiling:
 *    dropping it would send a request with no question in it. Memory and the
 *    system prompt are never evicted — the first is cheap and load-bearing, the
 *    second is the contract. The rolling summary is evicted last, only when
 *    everything else is already gone. A document larger than the whole evidence
 *    ceiling is evicted, not truncated: the ceiling is a guarantee.
 * 3. **The stable prefix.** The system message begins with `input.systemPrompt`
 *    byte-for-byte and appends the dynamic sections after it, so two requests
 *    with different memory and evidence share a cacheable prefix up to the
 *    first dynamic heading (spec §8.2).
 * 4. **Tags live in the system message; the turns stay theirs.** Retrieved
 *    text and memory are fused into the system message with their tier tags
 *    (`[MEM]`, `[RET]`, `[WIKI]`, `[CONV]`). Conversation turns are *not*
 *    fused: they stay separate `role: "user"` / `role: "assistant"` messages,
 *    because prefixing a user's own words with a tag would rewrite their
 *    message for the provider's chat template. `[USR]` names that tier in Task
 *    10's legend; it is never an in-band prefix.
 *
 * The body of every block runs through `wrapEvidence`, which is idempotent, so
 * a document Task 7 already wrapped is not wrapped twice. Screening is the
 * caller's job and Task 11 orders it first: a marker in the text here means the
 * wrapper put it there, or the caller skipped its stage.
 *
 * `report.evicted` is a string list, and its entries are three shapes, in this
 * order: the evicted document and wiki ids (in eviction order, lowest rank
 * first), then `<TURN_EVICTION_PREFIX><n>` when turns were trimmed, then
 * `SUMMARY_EVICTION` when the summary was dropped.
 *
 * Pure and synchronous, like the rest of the retrieval path, and it never
 * throws: an empty request is still a valid request, and an answer with no
 * evidence is what the route's refusal gate reads.
 */

import { wrapEvidence } from "@/lib/ai/prompt/screen"
import { CHARS_PER_TOKEN } from "@/lib/ai/memory/score"
import type { ScoredDoc } from "@/lib/ai/retrieval/candidates"
import type { WikiEvidence } from "@/lib/ai/retrieval/ladder"
import type { PersistedTurn } from "@/lib/chat/persistence"
import type { ChatMessage } from "@/lib/ai/gateway"

// Re-exported, not re-declared: one definition of a token for both modules.
export { CHARS_PER_TOKEN }

/**
 * The docs carry `[RET]`; the one corpus source with no `ai_documents` row
 * behind it — conversation documents, built from the user's own transcript —
 * carries `[CONV]`, because the model should know it is reading the user's
 * words rather than the curated corpus.
 */
export type EvidenceTag = "[RET]" | "[WIKI]" | "[CONV]"

export interface EvidenceRef {
  /** 1-based, dense and in merged order: the number an answer cites. */
  n: number
  /** `CorpusDocument.id`, or `wiki:<source>:<title>` for a wiki extract. */
  id: string
  tag: EvidenceTag
  /** The document title, exactly as the rendered block's header shows it. */
  label: string
}

export type Segment = "system" | "memory" | "evidence" | "summary" | "turns"

/** The per-segment ceilings, in tokens (spec §8.2's table). */
export const BUDGETS: Record<Segment, number> = {
  system: 900,
  memory: 200,
  evidence: 1800,
  summary: 300,
  turns: 800,
}

/** The heading the memory block is appended under. */
const MEMORY_HEADING = "## What you remember about this user"
/** The heading the rolling summary is appended under. */
const SUMMARY_HEADING = "## Earlier in this conversation"
/** The heading every evidence block is appended under. */
const EVIDENCE_HEADING = "## Evidence"

/** Marks a trimmed-turn count in `report.evicted`. */
export const TURN_EVICTION_PREFIX = "turns:"
/** Marks a dropped rolling summary in `report.evicted`. */
export const SUMMARY_EVICTION = "summary"

export interface AssemblyInput {
  /** `buildSystemPrompt`'s output. The stable prefix, kept byte-for-byte. */
  systemPrompt: string
  /** `renderMemoryBlock`'s output, "" when memory is off. */
  memories: string
  summary: string | null
  /** The window's turns, oldest first. The current user message is the caller's
   *  to append — the assembler renders the list it is given. */
  turns: PersistedTurn[]
  /** Screened, merged documents: Task 6's order is the numbering order. */
  docs: ScoredDoc[]
  wiki: WikiEvidence[]
}

export interface AssemblyReport {
  /** The surviving evidence, in render order, densely numbered from 1. */
  evidence: EvidenceRef[]
  /** Evicted doc/wiki ids, then the trimmed-turn count, then the summary. */
  evicted: string[]
  /** The measured token cost of each emitted segment. */
  tokens: Record<Segment, number>
  /** "evidence_evicted" | "no_evidence" | null. */
  degraded: string | null
}

/* ------------------------------------------------------------------ */
/* Runtime-safe readers                                                */
/* ------------------------------------------------------------------ */

/** The type says string; a database column or a tool result may not be one. */
function asText(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function asList<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : []
}

/** A rank key. A missing or non-finite rank is 0, the lowest rank there is. */
function asRank(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

/**
 * A label is one line by construction: a title that carries a newline could
 * otherwise forge a second header, or a line that looks like a wrap marker, in
 * the one place the model reads as assembler-owned.
 */
function asLabel(value: unknown): string {
  return asText(value).replace(/\s+/g, " ").trim()
}

/** The one token measure. Matches the memory module's line accounting. */
function tokenCost(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/* ------------------------------------------------------------------ */
/* Evidence blocks                                                     */
/* ------------------------------------------------------------------ */

/**
 * One document as the model will read it.
 *
 * `rrf` and `score` exist only for the eviction order; a wiki extract has
 * neither, which is why it carries the lowest rank and is evicted first.
 */
interface EvidenceBlock {
  id: string
  tag: EvidenceTag
  label: string
  body: string
  rrf: number
  score: number
}

interface RankedBlock {
  block: EvidenceBlock
  /** Its identity within the merged list. */
  index: number
  /** Its place in the merged order, and so its provisional number. */
  n: number
}

function buildBlocks(input: AssemblyInput): EvidenceBlock[] {
  const blocks: EvidenceBlock[] = []

  for (const entry of asList(input.docs)) {
    const document = entry?.doc
    if (!document) continue
    blocks.push({
      id: asText(document.id),
      tag: document.source === "conversations" ? "[CONV]" : "[RET]",
      label: asLabel(document.title),
      body: asText(document.body),
      rrf: asRank(entry.rrf),
      score: asRank(entry.score),
    })
  }

  for (const entry of asList(input.wiki)) {
    if (!entry) continue
    const label = asLabel(entry.title)
    blocks.push({
      // The cache key's shape, so a wiki block is identifiable in a report
      // without a column of its own.
      id: `wiki:${asText(entry.source)}:${label}`,
      tag: "[WIKI]",
      label,
      body: asText(entry.extract),
      rrf: 0,
      score: 0,
    })
  }

  return blocks
}

/**
 * The one rendering. The header is one line so a citation can be attributed
 * unambiguously; the body is wrapped, and `wrapEvidence` returns an
 * already-wrapped body untouched, so Task 7's marker pair is never doubled.
 */
function renderBlock(block: EvidenceBlock, n: number): string {
  const header = block.label.length > 0 ? `[E${n}] ${block.tag} ${block.label}` : `[E${n}] ${block.tag}`
  return `${header}\n${wrapEvidence(block.body)}`
}

/**
 * Lowest fused rank first: rrf, then score, then id, all ascending. Eviction
 * takes the front of this order; rendering keeps the input order. The two are
 * deliberately not the same list — the first evicted document is the
 * lowest-ranked, not the last rendered.
 */
function compareEviction(a: RankedBlock, b: RankedBlock): number {
  if (a.block.rrf !== b.block.rrf) return a.block.rrf - b.block.rrf
  if (a.block.score !== b.block.score) return a.block.score - b.block.score
  return a.block.id < b.block.id ? -1 : a.block.id > b.block.id ? 1 : 0
}

/* ------------------------------------------------------------------ */
/* The public surface                                                  */
/* ------------------------------------------------------------------ */

export function assembleMessages(input: AssemblyInput): {
  messages: ChatMessage[]
  report: AssemblyReport
} {
  const systemPrompt = asText(input?.systemPrompt)
  const memories = asText(input?.memories)
  const summary = asText(input?.summary)

  /* --- evidence: measure, evict, number --------------------------- */

  const blocks = buildBlocks(input)
  const ranked: RankedBlock[] = blocks.map((block, index) => ({ block, index, n: index + 1 }))

  // Cost is measured against the provisional numbering so the decision does not
  // depend on its own outcome. Re-numbering only shrinks a block's header, so
  // the emitted segment can never exceed what the loop measured.
  let usedEvidence = ranked.reduce((sum, item) => sum + tokenCost(renderBlock(item.block, item.n)), 0)
  const evictedIds: string[] = []
  const dropped = new Set<number>()

  for (const item of [...ranked].sort(compareEviction)) {
    if (usedEvidence <= BUDGETS.evidence) break
    dropped.add(item.index)
    evictedIds.push(item.block.id)
    usedEvidence -= tokenCost(renderBlock(item.block, item.n))
  }

  const survivors = ranked.filter((item) => !dropped.has(item.index))
  const evidence: EvidenceRef[] = survivors.map((item, index) => ({
    n: index + 1,
    id: item.block.id,
    tag: item.block.tag,
    label: item.block.label,
  }))
  const rendered = survivors.map((item, index) => renderBlock(item.block, index + 1))
  const evidenceText = rendered.join("\n\n")
  const evidenceTokens = rendered.reduce((sum, text) => sum + tokenCost(text), 0)

  /* --- turns: trim oldest-first ----------------------------------- */

  const turns: PersistedTurn[] = asList(input?.turns).map((value) => ({
    role: value?.role === "assistant" ? "assistant" : "user",
    content: asText(value?.content),
  }))

  let firstTurn = 0
  let turnTokens = turns.reduce((sum, turn) => sum + tokenCost(turn.content), 0)
  while (turnTokens > BUDGETS.turns && turns.length - firstTurn > 1) {
    turnTokens -= tokenCost(turns[firstTurn].content)
    firstTurn += 1
  }
  const keptTurns = turns.slice(firstTurn)
  const trimmedTurns = firstTurn

  /* --- the summary: the last thing to go -------------------------- */

  const hasSummary = summary.trim().length > 0
  const summaryTokens = hasSummary ? tokenCost(summary) : 0
  // "Nothing else remains" is read post-eviction: a summary over its ceiling
  // survives while any evidence or turn is still in the message, because those
  // are the segments that carry this request's ground truth.
  const summaryDropped =
    hasSummary && summaryTokens > BUDGETS.summary && survivors.length === 0 && keptTurns.length === 0

  /* --- the system message ----------------------------------------- */

  const sections = [systemPrompt]
  if (memories.trim().length > 0) sections.push(`${MEMORY_HEADING}\n${memories}`)
  if (hasSummary && !summaryDropped) sections.push(`${SUMMARY_HEADING}\n${summary}`)
  if (survivors.length > 0) sections.push(`${EVIDENCE_HEADING}\n${evidenceText}`)

  const messages: ChatMessage[] = [
    { role: "system", content: sections.filter((section) => section.length > 0).join("\n\n") },
  ]
  for (const turn of keptTurns) {
    messages.push({ role: turn.role, content: turn.content })
  }

  /* --- the report -------------------------------------------------- */

  const evicted = [...evictedIds]
  if (trimmedTurns > 0) evicted.push(`${TURN_EVICTION_PREFIX}${trimmedTurns}`)
  if (summaryDropped) evicted.push(SUMMARY_EVICTION)

  const degraded =
    evictedIds.length > 0 ? "evidence_evicted" : blocks.length === 0 ? "no_evidence" : null

  return {
    messages,
    report: {
      evidence,
      evicted,
      tokens: {
        system: tokenCost(systemPrompt),
        memory: memories.trim().length > 0 ? tokenCost(memories) : 0,
        evidence: evidenceTokens,
        summary: hasSummary && !summaryDropped ? summaryTokens : 0,
        turns: turnTokens,
      },
      degraded,
    },
  }
}
