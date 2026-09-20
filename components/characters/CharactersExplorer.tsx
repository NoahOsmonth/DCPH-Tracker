"use client"

/*
  CharactersExplorer — orchestrator for /characters.

  The relationship filter chip and legend popover are handed to the graph as
  `topLeftSlot`, so they live in the SAME flex column as the search field and
  can no longer overlap it.

  All characters and relationships are always visible and un-gated.
*/

import { useEffect, useMemo, useState } from "react"
import dynamic from "next/dynamic"
import { AnimatePresence, motion } from "framer-motion"
import {
  CharacterDetailPanel,
  RelationshipLegend,
  type SheetSnap,
} from "@/components/characters/CharacterDetailPanel"
import { useTheme } from "@/components/theme-provider"
import { setCharacterChromeHidden } from "@/lib/character-chrome"
import { useMediaQuery } from "@/lib/use-media-query"
import { getRelationshipColor } from "@/components/characters/graph-theme"
import { ChevronDown, Filter } from "lucide-react"
import { cn } from "@/lib/utils"
import type {
  Character,
  Relationship,
  RelationshipType,
} from "@/lib/characters-guide"

type RelationshipMeta = Record<
  RelationshipType,
  { label: string; color: string; description: string }
>

export interface CharactersExplorerProps {
  characters: Character[]
  relationships: Relationship[]
  relationshipMeta: RelationshipMeta
  isSignedIn?: boolean
  watchedEpisodes?: number[]
  watchedMovies?: number[]
  highestEpisode?: number
}

const EASE = [0.16, 1, 0.3, 1] as const

const CharactersWeb = dynamic(
  () => import("@/components/characters/CharactersWeb"),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full w-full items-center justify-center bg-page" aria-busy="true">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-ink-faint border-t-accent" />
      </div>
    ),
  }
)

export default function CharactersExplorer({
  characters,
  relationships,
  relationshipMeta,
}: CharactersExplorerProps) {
  const [selection, setSelection] = useState<Character | null>(null)
  const [filter, setFilter] = useState<RelationshipType | null>(null)
  const [legendOpen, setLegendOpen] = useState(false)
  const [panelSnap, setPanelSnap] = useState<SheetSnap>("peek")

  // Sync matchMedia — correct on the first client render, so selecting a
  // character on a phone never flashes the desktop card.
  const isMobile = useMediaQuery("(max-width: 767px)")

  const { theme } = useTheme()
  const isDark = theme === "dark"

  /* Task 3 — hide chrome while a dossier is open on phones. Publishes to the
     shared store consumed by the globally mounted ChatWidget; the cleanup also
     covers navigating away from /characters with the sheet still open. */
  const hideControls = isMobile && selection != null
  useEffect(() => {
    setCharacterChromeHidden(hideControls)
    return () => setCharacterChromeHidden(false)
  }, [hideControls])

  // Height (vh) the mobile sheet reserves at the bottom of the viewport —
  // feeds usableRect and the dock offset inside CharactersWeb.
  const sheetInsetVh =
    selection && isMobile ? (panelSnap === "peek" ? 30 : panelSnap === "half" ? 48 : 85) : 0

  // A new selection remounts the sheet at peek — reset the snap DURING the
  // selection render (React's adjust-state-during-render pattern) so the
  // selection and the reset land in ONE commit. A post-render useEffect here
  // caused a second full CharactersWeb render on every tap (measured tap
  // spike: 137ms longtask / 166ms worst rAF gap on dev).
  const selectionId = selection?.id ?? null
  const [lastSelectionId, setLastSelectionId] = useState<string | null>(null)
  if (selectionId !== lastSelectionId) {
    setLastSelectionId(selectionId)
    setPanelSnap("peek")
  }

  const threadsFor = (characterId: string): Relationship[] => {
    const all = relationships.filter(
      (r) => r.source === characterId || r.target === characterId,
    )
    return filter ? all.filter((r) => r.type === filter) : all
  }

  const panelRelationships = selection ? threadsFor(selection.id) : []

  const filterControls = useMemo(
    () => (
      <div className="flex flex-col gap-2">
        <button
          type="button"
          onClick={() => setLegendOpen((v) => !v)}
          aria-expanded={legendOpen}
          className={cn(
            "group flex w-full items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-xs font-semibold shadow-lift transition-all",
            "border-line bg-surface text-ink hover:border-ink-faint/40 hover:bg-surface-muted",
          )}
        >
          <Filter className="h-3.5 w-3.5 shrink-0 text-accent-bright transition-transform duration-300 group-hover:rotate-12" />
          <span className="min-w-0 flex-1 truncate text-left">
            {filter ? relationshipMeta[filter].label : "All Relationships"}
          </span>
          {filter && (
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: getRelationshipColor(filter, isDark) }}
            />
          )}
          <ChevronDown
            className={cn(
              "h-3.5 w-3.5 shrink-0 opacity-60 transition-transform duration-300",
              legendOpen && "rotate-180",
            )}
          />
        </button>

        <AnimatePresence initial={false}>
          {legendOpen && (
            <motion.div
              initial={{ opacity: 0, y: -8, height: 0 }}
              animate={{ opacity: 1, y: 0, height: "auto" }}
              exit={{ opacity: 0, y: -8, height: 0 }}
              transition={{ duration: 0.28, ease: EASE }}
              className="overflow-hidden"
            >
              <div className="max-h-[52vh] overflow-y-auto rounded-2xl border border-line bg-surface p-3 text-ink shadow-lift">
                <div className="mb-2.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
                  Filter by relationship
                </div>
                <RelationshipLegend
                  activeFilter={filter}
                  onFilterType={setFilter}
                  compact
                />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    ),
    [legendOpen, filter, relationshipMeta, isDark],
  )

  return (
    <div className="relative h-full w-full overflow-hidden bg-page text-ink transition-colors duration-300">
      <CharactersWeb
        characters={characters}
        relationships={relationships}
        onSelectCharacter={setSelection}
        selectedCharacterId={selection?.id}
        activeFilter={filter}
        topLeftSlot={filterControls}
        hideControls={hideControls}
        sheetInsetVh={sheetInsetVh}
        theme={theme}
        className="h-full w-full rounded-none border-none shadow-none"
      />

      <AnimatePresence>
        {selection && (
          <div
            key={selection.id}
            className="pointer-events-auto fixed inset-x-0 bottom-0 z-40 w-full sm:absolute sm:inset-auto sm:bottom-4 sm:right-4 sm:w-96 sm:max-w-md"
          >
            <CharacterDetailPanel
              character={selection}
              relationships={panelRelationships}
              onClose={() => setSelection(null)}
              onSnapChange={setPanelSnap}
            />
          </div>
        )}
      </AnimatePresence>
    </div>
  )
}
