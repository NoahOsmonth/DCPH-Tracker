"use client"

/**
 * What the pipeline did, as one collapsed line that expands.
 *
 * The whole component is a renderer for one `ActivityPart` the server sent plus
 * the message's degrade reasons. It measures nothing: every number here is a
 * value the server put on the wire (`planMs`/`retrieveMs`/`assembleMs`), never a
 * client wall-clock reading, because the client's clock is not a measurement of
 * the server's work.
 *
 * **Non-secret only (constraint 9).** The trace renders the planning path, the
 * tools and the timings. It has no channel for a provider name, a key or a raw
 * error, and the test that pins this asserts the rendered text carries none.
 *
 * **The wording tables are data.** Tool ids and degrade reasons arrive as
 * machine strings; a reader gets a phrase. An unknown reason is not hidden — it
 * gets a neutral "degraded" badge that names it, so a new server reason is
 * visible before it is explained. The reason table is typed by `DegradedReason`,
 * so adding a reason to `DEGRADED_REASONS` without wording fails the build.
 */
import * as React from "react"
import { motion, useReducedMotion } from "framer-motion"
import { ChevronDown } from "lucide-react"
import { cn } from "@/lib/utils"
import { badgeVariants } from "@/components/ui/badge"
import { buttonVariants } from "@/components/ui/button"
import {
  DEGRADED_REASONS,
  type ActivityPart,
  type DegradedReason,
} from "@/lib/ai/stream/protocol"

/** Reader-facing verbs for the pipeline's tool ids. Never the raw snake_case. */
export const TOOL_VERBS: Record<string, string> = {
  search_catalog: "searched the catalog",
  search_cases: "searched the cases",
  lookup_character: "looked up a character",
  classify_episode: "classified an episode",
  arc_for_range: "found the arc for an episode range",
  next_unwatched: "found the next unwatched episode",
  wiki_lookup: "looked something up on the wiki",
  search_conversations: "searched your past conversations",
}

/** What a tool id outside the table reads as: a step, not an identifier. */
export const UNKNOWN_TOOL_VERB = "ran a step"

export function toolVerb(name: string): string {
  return TOOL_VERBS[name] ?? UNKNOWN_TOOL_VERB
}

/**
 * One wording per degrade reason. Typed by `DegradedReason` on purpose: a reason
 * added to the server's vocabulary without a line here is a `tsc` failure, so it
 * can never reach a reader as an unexplained badge.
 */
export const DEGRADE_WORDING: Record<DegradedReason, string> = {
  pipeline_failed: "the pipeline failed",
  corpus_unavailable: "the corpus was unavailable",
  corpus_static: "the built-in corpus was used",
  execute_budget: "the search ran out of time",
  ladder_failed: "a search round failed",
  tool_failed: "a lookup failed",
  retrieval_budget: "retrieval ran out of time",
  evidence_evicted: "some sources did not fit",
  screened: "some sources were excluded",
  uncited: "the answer cited no sources",
  retrieval_failed: "retrieval failed",
  rate_limited: "the bot was rate-limited",
  empty_result: "no answer was produced",
  partial_answer: "the answer was cut short",
}

/**
 * The badge text for one reason: its wording, or — for a reason this client does
 * not know — a neutral "degraded" badge that names it. The raw token is the only
 * honest thing to show before a wording exists.
 */
export function degradeWording(reason: string): string {
  return isKnownReason(reason) ? DEGRADE_WORDING[reason] : `degraded: ${reason}`
}

function isKnownReason(reason: string): reason is DegradedReason {
  return (DEGRADED_REASONS as readonly string[]).includes(reason)
}

type PlanSourceValue = NonNullable<ActivityPart["planSource"]>

/**
 * The planning path, worded so the fallback reads as a normal plan rather than a
 * failure: the router's plan is a correct answer, not an error state.
 */
export const PLAN_SOURCE_WORDING: Record<PlanSourceValue, string> = {
  router: "Planned by the router",
  model: "Planned by the model",
  fallback: "Planned with the standard plan",
}

function planSourceWording(source: ActivityPart["planSource"]): string {
  return source === null ? "No planner ran" : PLAN_SOURCE_WORDING[source]
}

/** The stages, in the order the server measures them. */
const STAGES: { key: keyof ActivityPart["timings"]; label: string }[] = [
  { key: "planMs", label: "Plan" },
  { key: "retrieveMs", label: "Retrieve" },
  { key: "assembleMs", label: "Assemble" },
]

/**
 * The stages' total, or `null` when the server sent no measurement at all.
 * Absent fields are skipped, never read as zero.
 */
export function totalActivityMs(timings: ActivityPart["timings"]): number | null {
  const values = [timings.planMs, timings.retrieveMs, timings.assembleMs].filter(
    (value): value is number => typeof value === "number"
  )
  if (values.length === 0) return null
  return values.reduce((sum, value) => sum + value, 0)
}

/** A duration as a reader reads it: milliseconds under a second, else seconds. */
export function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`
}

/** The collapsed one-liner: steps, the server's duration, then what ran. */
export function activitySummary(activity: ActivityPart): string {
  const count = activity.tools.length
  const parts: string[] = [
    count === 0 ? "no steps" : count === 1 ? "1 step" : `${count} steps`,
  ]
  const total = totalActivityMs(activity.timings)
  if (total !== null) parts.push(formatDuration(total))
  if (count > 0) parts.push(activity.tools.map(toolVerb).join(", "))
  return parts.join(" · ")
}

/** A stage's own measurement, or the honest absence of one. */
function formatTiming(ms: number | null): string {
  return ms === null ? "not measured" : `${ms} ms`
}

export interface ActivityTraceProps {
  /** The server's activity part, or `null` when the turn carried none. */
  activity: ActivityPart | null
  /** Every merged degrade reason for the message, in arrival order. */
  degraded?: string[]
  className?: string
}

export function ActivityTrace({ activity, degraded = [], className }: ActivityTraceProps) {
  const reduce = useReducedMotion()
  const [open, setOpen] = React.useState(false)
  const panelId = React.useId()

  // A turn with no activity part has nothing to trace — v1 and a stream this
  // client cannot read both land here. Nothing is rendered, not an empty box.
  if (activity === null) return null

  const summary = activitySummary(activity)

  // The container owns the key handler so Escape works wherever focus sits
  // inside the trace, including a reason badge a reader tabbed to.
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && open) setOpen(false)
  }

  return (
    <div
      onKeyDown={onKeyDown}
      className={cn("rounded-lg border border-line bg-surface-muted/40 text-xs", className)}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          buttonVariants({ variant: "ghost", size: "sm" }),
          "h-auto w-full justify-start gap-1.5 whitespace-normal px-2 py-1.5 text-left font-normal text-ink-dim hover:text-ink"
        )}
      >
        <ChevronDown
          aria-hidden
          className={cn(
            "size-3.5 shrink-0",
            !reduce && "transition-transform",
            open && "rotate-180"
          )}
        />
        <span>{summary}</span>
        <span className="sr-only">{open ? "Hide details" : "Show details"}</span>
      </button>

      {degraded.length > 0 && (
        <ul aria-label="Answer state" className="flex flex-wrap gap-1 px-2 pb-1.5">
          {degraded.map((reason, index) => (
            <li key={`${reason}-${index}`}>
              <span
                className={cn(
                  badgeVariants({ variant: "outline" }),
                  "px-1.5 py-0 text-[10px] leading-4"
                )}
              >
                {degradeWording(reason)}
              </span>
            </li>
          ))}
        </ul>
      )}

      {open && (
        <motion.div
          id={panelId}
          initial={reduce ? false : { opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.15, ease: "easeOut" }}
          className="border-t border-line px-2 py-1.5"
        >
          <dl className="grid grid-cols-3 gap-2">
            {STAGES.map((stage) => (
              <div key={stage.key}>
                <dt className="text-ink-faint">{stage.label}</dt>
                <dd className="font-mono text-ink-dim">{formatTiming(activity.timings[stage.key])}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-1.5 text-ink-dim">{planSourceWording(activity.planSource)}</p>
        </motion.div>
      )}
    </div>
  )
}
