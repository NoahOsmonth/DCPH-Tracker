/**
 * Candidate re-ranking through the tracker scorer.
 *
 * FTS (and the entity and fuzzy branches) generate candidates; `rankEntries`
 * decides their order, exactly as `lib/chat/search.ts` already does for linked
 * case text. Fusing first and scoring second is deliberate: RRF is cheap and
 * blind, and the scorer is the only thing that knows a title hit is worth more
 * than a passing mention.
 *
 * Zero I/O, like the rest of lib/chat/query.ts and lib/ai/retrieval/rrf.ts:
 * this decides which documents the model is allowed to see, so it has to be
 * unit-testable without a database.
 */

import { rankEntries, scoreEntry } from "@/lib/chat/query"
import { toRankable, type CorpusDocument } from "@/lib/ai/corpus/types"
import type { FusedCandidate } from "@/lib/ai/retrieval/rrf"

export interface ScoredDoc {
  doc: CorpusDocument
  score: number
  rrf: number
  /** The branches that retrieved it: "entity", "fts", "fuzzy", ... */
  origins: string[]
}

/**
 * How many records of one case may lead the list.
 *
 * A `case:` document is one crime template of one episode or movie, and a case
 * can hold fifteen of them (measured: "The Raven Chaser"). They score alike —
 * they share a page title, a crime type and most of their text — so without a
 * cap six of them take the top of a twelve-document window and the episode they
 * belong to never appears, which was the evidence the question wanted. Two
 * stay, which is enough to show a case is multi-part; the rest are demoted, not
 * dropped, so a question whose answer sits in the seventh record still finds it
 * as long as the window reaches that far.
 */
const SIBLING_CAP = 2

/**
 * The case a document is a record of, or null when it is not a record.
 *
 * `metadata.page_title` is the case's own title, and the corpus builders set it
 * on the `case:` rows and nowhere else (2016 of 2016 case documents, 0 of the
 * other 1633), so it is both the sibling key and the test for "is a record".
 */
function siblingKey(doc: CorpusDocument): string | null {
  const pageTitle = doc.metadata.page_title
  return typeof pageTitle === "string" && pageTitle.length > 0 ? pageTitle : null
}

/**
 * Moves the records of a case after the first `cap` of them, preserving both
 * groups' internal order. Pure: neither the input array nor an entry is
 * mutated, and every document is kept.
 */
function diversifyRecords(docs: ScoredDoc[], cap: number): ScoredDoc[] {
  const seen = new Map<string, number>()
  const lead: ScoredDoc[] = []
  const deferred: ScoredDoc[] = []

  for (const entry of docs) {
    const key = siblingKey(entry.doc)
    if (key === null) {
      lead.push(entry)
      continue
    }

    const count = seen.get(key) ?? 0
    seen.set(key, count + 1)
    if (count < cap) lead.push(entry)
    else deferred.push(entry)
  }

  return [...lead, ...deferred]
}

/**
 * Ranks fused candidates by the scorer's verdict, keeping the candidates it
 * cannot score.
 *
 * The one non-obvious rule: a document the scorer gives 0 is NOT a miss. A
 * fuzzy hit is a typo-tolerance hit — the query says "haibarra" and the title
 * says "haibara" — so `scoreEntry` returns 0 for the only document R3 found.
 * Filtering zeros the way `rankEntries` does internally would throw away the
 * fuzzy branch's entire output, so they survive, ordered by rrf, after every
 * document that scored.
 *
 * The scored group is then diversified by `diversifyRecords`, which demotes the
 * third and later records of one case behind the rest of the group: a case can
 * hold fifteen crime templates that all score alike, and without the cap they
 * are the whole window. `limit` (default 12) truncates the concatenation of
 * both groups, never the scored group alone, or the survivors could push the
 * result past the cap.
 */
export function rankCandidates(
  candidates: FusedCandidate[],
  docs: CorpusDocument[],
  keywords: string[],
  options: {
    limit?: number
    numbers?: number[]
    preferRecent?: boolean
    preferEarliest?: boolean
  } = {}
): ScoredDoc[] {
  const { limit = 12, numbers = [], preferRecent = false, preferEarliest = false } = options

  const docById = new Map(docs.map((doc) => [doc.id, doc]))

  // Hydration can legitimately miss (a deleted row, a source that filtered it),
  // so a candidate without a document is dropped rather than ranked as a shell.
  // Sort explicitly: rrf desc then id asc is the same tie-break RRF promises,
  // and it must hold even if a caller hands the fused list over unsorted.
  const ordered = candidates
    .map((candidate) => ({ candidate, doc: docById.get(candidate.id) }))
    .filter(
      (row): row is { candidate: FusedCandidate; doc: CorpusDocument } => row.doc !== undefined
    )
    .sort((a, b) => {
      if (b.candidate.rrf !== a.candidate.rrf) return b.candidate.rrf - a.candidate.rrf
      return a.candidate.id < b.candidate.id ? -1 : a.candidate.id > b.candidate.id ? 1 : 0
    })

  const scoredById = new Map<string, ScoredDoc>()
  const survivors: ScoredDoc[] = []
  for (const { candidate, doc } of ordered) {
    const entry: ScoredDoc = {
      doc,
      score: scoreEntry(toRankable(doc), keywords, numbers),
      rrf: candidate.rrf,
      origins: Object.keys(candidate.ranks),
    }
    scoredById.set(doc.id, entry)
    // `ordered` is already rrf desc, id asc, so a straight push keeps the
    // survivor group in the deterministic order the rule asks for.
    if (entry.score === 0) survivors.push(entry)
  }

  // rankEntries is the authority on the scored group's order (score desc, then
  // the chronological preference, then air date); the map only re-attaches the
  // rrf and origins the scorer cannot know about.
  //
  // Its own cap is raised to the pool size rather than left at `limit`: the
  // diversification below has to see the whole scored group to pull a document
  // out from behind a case's records, and a document it cannot see is one the
  // model never sees. The cap that matters is the slice at the end, which is
  // applied to the concatenation — so the result is still exactly `limit` long.
  const scored: ScoredDoc[] = []
  const ranked = rankEntries(
    ordered.map((row) => row.doc),
    keywords,
    { limit: ordered.length, numbers, preferRecent, preferEarliest, fieldsOf: toRankable }
  )
  for (const doc of ranked) {
    const entry = scoredById.get(doc.id)
    if (entry) scored.push(entry)
  }

  // The survivors stay last: the demotion is inside the scored group, so it can
  // never promote a document the scorer gave 0 over one it could score.
  return [...diversifyRecords(scored, SIBLING_CAP), ...survivors].slice(0, limit)
}
