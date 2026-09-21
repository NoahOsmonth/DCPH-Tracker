/**
 * The document source port: one interface, two adapters.
 *
 * Production reads `ai_documents` through three RPCs. Every test and the eval
 * gate read an in-process index instead, because CI has no Postgres (plan
 * deviation D5, recorded deliberately). Keeping both behind this interface is
 * what makes the escalation ladder testable at all.
 *
 * Zero I/O here: the Supabase adapter is typed structurally against
 * `DocsRpcClient`, so it never imports the database client and a test can inject
 * a fake one.
 */

import { normalizeText, tokenize } from "@/lib/chat/query"
import type { CorpusDocument, CorpusSource, DocMetadata } from "@/lib/ai/corpus/types"

export interface SearchHit {
  id: string
  score: number
}

export interface DocumentSource {
  /** R1. `names` are lowercase; a hit is an exact title, an alias, or a title substring. */
  entity(input: { numbers: number[]; names: string[]; limit: number }): Promise<SearchHit[]>
  /** R2. Token AND, like websearch_to_tsquery. A query with no usable tokens matches nothing. */
  fullText(query: string, limit: number): Promise<SearchHit[]>
  /** R3. Approximate trigram similarity on titles, threshold ~0.3. */
  fuzzy(query: string, keywords: string[], limit: number): Promise<SearchHit[]>
  /** Hydration by id. Unknown ids are omitted. */
  fetch(ids: string[]): Promise<CorpusDocument[]>
}

export interface DocsRpcClient {
  rpc(
    fn: string,
    args: Record<string, unknown>
  ): Promise<{ data: SearchHit[] | null; error: { message: string } | null }>
  from(table: string): {
    select(columns: string): {
      in(
        column: string,
        values: string[]
      ): Promise<{ data: Record<string, unknown>[] | null; error: { message: string } | null }>
    }
  }
}

/**
 * Postgres's `pg_trgm.similarity_threshold` default. The static branch keeps a
 * hit at or above this number so the offline approximation agrees with
 * production about what counts as a hit.
 */
export const FUZZY_SIMILARITY_THRESHOLD = 0.3

/** The entity rule weights, same numbers as the SQL's `greatest(...)` ranks. */
const ENTITY_NUMBER_SCORE = 3
const ENTITY_TITLE_SCORE = 2
const ENTITY_ALIAS_SCORE = 1.5
const ENTITY_SUBSTRING_SCORE = 1

/**
 * The ladder and the search tools give `tokenize` up to 8 keywords; full-text
 * matching uses the same cap so the branches see the same query terms.
 */
const MAX_QUERY_TOKENS = 8

/**
 * Document-side tokens. `tokenize` is for queries: it drops stopwords and caps
 * the keyword count, which would silently cut a body's vocabulary. Query tokens
 * are already stopword-filtered, so keeping stopwords in the index costs nothing.
 */
function documentTokens(value: string): string[] {
  return normalizeText(value).split(" ").filter((token) => token !== "")
}

/** Score desc, id asc: the SQL's `order by rank desc, d.id`, and the tie-break
 * that keeps the offline output reproducible run to run. */
function sortHits(hits: SearchHit[]): SearchHit[] {
  return hits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

function matchesNumber(value: number | null | undefined, numbers: number[]): boolean {
  return typeof value === "number" && numbers.includes(value)
}

/**
 * Best rule wins, as in the SQL: a number hit outranks an exact title, a title
 * outranks an alias overlap, an alias outranks a title substring.
 */
function entityScore(doc: CorpusDocument, numbers: number[], names: string[]): number {
  let score = 0

  if (matchesNumber(doc.episodeNumber, numbers) || matchesNumber(doc.movieNumber, numbers)) {
    score = ENTITY_NUMBER_SCORE
  }

  const title = normalizeText(doc.title)
  const aliases = doc.aliases ?? []

  for (const name of names) {
    // The SQL guards this the same way (`n <> ''`): `"".includes`-style matching
    // would turn every document into an entity hit.
    if (name === "") continue
    if (title === name) score = Math.max(score, ENTITY_TITLE_SCORE)
    if (title.includes(name)) score = Math.max(score, ENTITY_SUBSTRING_SCORE)
    // `aliases && p_names` is a set overlap, not a substring test.
    if (aliases.includes(name)) score = Math.max(score, ENTITY_ALIAS_SCORE)
  }

  return score
}

/**
 * The in-process adapter. The eval gate runs 60 queries over a corpus of ~1,600
 * documents, so the token sets are built once here rather than per query.
 */
export function createStaticSource(docs: CorpusDocument[]): DocumentSource {
  const byId = new Map<string, CorpusDocument>()
  const index = new Map<string, { title: Set<string>; body: Set<string> }>()

  for (const doc of docs) {
    byId.set(doc.id, doc)
    index.set(doc.id, {
      title: new Set(documentTokens(doc.title)),
      body: new Set(documentTokens(doc.body)),
    })
  }

  return {
    async entity({ numbers, names, limit }) {
      const hits: SearchHit[] = []

      for (const doc of docs) {
        const score = entityScore(doc, numbers, names)
        if (score > 0) hits.push({ id: doc.id, score })
      }

      return sortHits(hits).slice(0, limit)
    },

    async fullText(query, limit) {
      const tokens = tokenize(query, MAX_QUERY_TOKENS)

      // websearch_to_tsquery("the of and") is an empty tsquery, which matches
      // nothing. Returning the corpus here would be the one failure that looks
      // like success, so the empty case is explicit.
      if (tokens.length === 0) return []

      const hits: SearchHit[] = []

      for (const doc of docs) {
        const entry = index.get(doc.id)
        if (!entry) continue

        let score = 0
        let matchedAll = true

        for (const token of tokens) {
          if (entry.title.has(token)) score += 2
          else if (entry.body.has(token)) score += 1
          else {
            matchedAll = false
            break
          }
        }

        if (matchedAll) hits.push({ id: doc.id, score })
      }

      return sortHits(hits).slice(0, limit)
    },

    async fuzzy(query, keywords, limit) {
      // The SQL ignores keywords shorter than 3 characters; a 1- or 2-character
      // keyword can never reach the threshold anyway, but the rule is the same.
      const probes = keywords.filter((keyword) => keyword.length >= 3)
      const hits: SearchHit[] = []

      for (const doc of docs) {
        let score = trigramSimilarity(doc.title, query)
        for (const keyword of probes) {
          score = Math.max(score, trigramSimilarity(doc.title, keyword))
        }
        if (score >= FUZZY_SIMILARITY_THRESHOLD) hits.push({ id: doc.id, score })
      }

      return sortHits(hits).slice(0, limit)
    },

    async fetch(ids) {
      const found: CorpusDocument[] = []

      for (const id of ids) {
        const doc = byId.get(id)
        if (doc) found.push(doc)
      }

      return found
    },
  }
}

/** One log line, then the empty result: a broken branch must degrade an answer,
 * never fail the request. */
function logFailureAndReturnEmpty(branch: string, error: unknown): never[] {
  console.error(
    `[ai-retrieval] ${branch} failed`,
    error instanceof Error ? error.message : String(error)
  )
  return []
}

/** One log line for a branch that partially failed; the successful batches are
 *  still worth returning. */
function logPartialFailure(branch: string, error: unknown): void {
  console.error(
    `[ai-retrieval] ${branch} batch failed`,
    error instanceof Error ? error.message : String(error)
  )
}

/**
 * The most percent-encoded characters of ids one hydration request may carry.
 *
 * Hydration is the one branch whose arguments are unbounded: the ladder hands it
 * every fused candidate, and R1's pool alone is 100 ids. PostgREST travels that
 * list in the query string (`id=in.(...)`), and the API gateway answers a request
 * line over 8 KB with 414 "URI too long" — measured against the local stack at
 * 8203 characters, still passing at 6723. A fused set reaches ~180 ids averaging
 * 35 encoded characters ("case:Til Death Do Us Part#1"), so one request is not
 * always possible, and the failure is total: 414 is an error, not an empty
 * result, so the ladder lost every document and the bot refused to answer a
 * question it had the evidence for.
 *
 * Batches are sized by encoded length rather than by count, because id length
 * varies by source. 4000 leaves the 8 KB limit a factor of two of headroom for
 * the path, the select list and the rest of the query.
 */
const HYDRATE_BATCH_CHARS = 4000

/** A ceiling on round trips for a pathological corpus of very short ids. */
const HYDRATE_BATCH_MAX = 50

/**
 * Splits ids into requests that each fit `HYDRATE_BATCH_CHARS`.
 *
 * A single id over the budget still gets a batch of its own rather than being
 * dropped: a request that fails is recoverable, a silently missing document is
 * not.
 */
function batchIds(ids: string[]): string[][] {
  const batches: string[][] = []
  let current: string[] = []
  let size = 0

  for (const id of ids) {
    // +1 for the separating comma, which is not percent-encoded.
    const cost = encodeURIComponent(id).length + 1
    if (current.length > 0 && (size + cost > HYDRATE_BATCH_CHARS || current.length >= HYDRATE_BATCH_MAX)) {
      batches.push(current)
      current = []
      size = 0
    }
    current.push(id)
    size += cost
  }

  if (current.length > 0) batches.push(current)

  return batches
}

export function createSupabaseSource(client: DocsRpcClient): DocumentSource {
  return {
    async entity({ numbers, names, limit }) {
      try {
        const { data, error } = await client.rpc("ai_docs_entity", {
          p_numbers: numbers,
          p_names: names,
          p_limit: limit,
        })
        if (error) return logFailureAndReturnEmpty("entity", error.message)
        return data ?? []
      } catch (err) {
        return logFailureAndReturnEmpty("entity", err)
      }
    },

    async fullText(query, limit) {
      try {
        const { data, error } = await client.rpc("ai_docs_fts", {
          p_query: query,
          p_limit: limit,
        })
        if (error) return logFailureAndReturnEmpty("fullText", error.message)
        return data ?? []
      } catch (err) {
        return logFailureAndReturnEmpty("fullText", err)
      }
    },

    async fuzzy(query, keywords, limit) {
      try {
        const { data, error } = await client.rpc("ai_docs_fuzzy", {
          p_query: query,
          p_keywords: keywords,
          p_limit: limit,
        })
        if (error) return logFailureAndReturnEmpty("fuzzy", error.message)
        return data ?? []
      } catch (err) {
        return logFailureAndReturnEmpty("fuzzy", err)
      }
    },

    async fetch(ids) {
      // An empty `in` list is a wasted round trip, and PostgREST is not the
      // place to find out what it does with one.
      if (ids.length === 0) return []

      try {
        // The batches are independent reads, so they go out together: the ladder
        // is on a 1500 ms budget and a serialized round trip per batch would
        // spend it on latency.
        const results = await Promise.all(
          batchIds(ids).map((batch) => client.from("ai_documents").select("*").in("id", batch))
        )

        const found: CorpusDocument[] = []
        for (const { data, error } of results) {
          // A batch that failed is logged and skipped rather than zeroing the
          // whole hydration: 100 of 180 documents is an answer, none is a
          // refusal. `rankCandidates` already tolerates a candidate with no
          // document, which is the same shape as one whose batch did not arrive.
          if (error) {
            logPartialFailure("fetch", error.message)
            continue
          }
          for (const row of data ?? []) found.push(rowToDocument(row))
        }
        return found
      } catch (err) {
        return logFailureAndReturnEmpty("fetch", err)
      }
    },
  }
}

/**
 * The trigram set Postgres computes: two spaces prefixed, one suffixed, every
 * 3-character gram. Lowercased for the same reason `show_trgm` lowercases —
 * `similarity()` ignores case. Postgres generates these per word of a
 * multi-word value; padding the whole value is the approximation D5 accepts,
 * since the offline branch only has to agree on what counts as a hit.
 */
export function trigrams(value: string): Set<string> {
  const padded = `  ${value.toLowerCase()} `
  const grams = new Set<string>()

  for (let start = 0; start + 3 <= padded.length; start += 1) {
    const gram = padded.slice(start, start + 3)
    // The only all-space gram is the padding of an empty value, and
    // `show_trgm('')` is `{}`: "no trigrams" has to stay representable.
    if (gram.trim() === "") continue
    grams.add(gram)
  }

  return grams
}

/** Jaccard overlap of the two trigram sets; 0 when either side has no trigrams. */
export function trigramSimilarity(a: string, b: string): number {
  const left = trigrams(a)
  const right = trigrams(b)
  if (left.size === 0 || right.size === 0) return 0

  let shared = 0
  for (const gram of left) {
    if (right.has(gram)) shared += 1
  }

  return shared / (left.size + right.size - shared)
}

/**
 * Hydration maps the table's snake_case columns onto `CorpusDocument`.
 * `content_hash` and `fts` are generated by the database and dropped; `metadata`
 * and `aliases` are nullable and default to an empty value.
 */
export function rowToDocument(row: Record<string, unknown>): CorpusDocument {
  return {
    id: row.id as string,
    source: row.source as CorpusSource,
    title: row.title as string,
    body: row.body as string,
    url: (row.url as string | null) ?? null,
    metadata: parseMetadata(row.metadata),
    episodeNumber: (row.episode_number as number | null | undefined) ?? null,
    movieNumber: (row.movie_number as number | null | undefined) ?? null,
    aliases: Array.isArray(row.aliases) ? (row.aliases as string[]) : [],
  }
}

/** PostgREST normally returns `jsonb` as an object, but a row can arrive with it
 * as a JSON string; one corrupt row must not fail a whole hydration. */
function parseMetadata(value: unknown): DocMetadata {
  if (value === null || value === undefined) return {}

  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value)
      return parsed !== null && typeof parsed === "object" ? (parsed as DocMetadata) : {}
    } catch {
      return {}
    }
  }

  return typeof value === "object" ? (value as DocMetadata) : {}
}
