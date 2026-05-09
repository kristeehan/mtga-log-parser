# Plan: Readability Refactors

A set of structural refactors aimed at making the codebase easier to understand. None of these add features or change behaviour — they reorganise existing logic so the data flow and architectural decisions are easier to read.

---

## Completed

**#1 — ParseSession consolidation** (`src/logParser.ts`)
`parseLinesAndAddToSession` now takes a single `ParseSession` object (wrapping a `Session` sub-object + collectors + filter). Done.

**#2 — Named event handlers** (`src/logParser.ts`)
`parseLinesAndAddToSession` routes to `handleParseDeck`, `handleParseMatchStateChange`, and `handleParseGREEventLine`. Done.

---

## 1. Extract the primary/fallback paths in `getZoneObjects` into named helpers

**Problem:** `getZoneObjects` in `boardStateParser.ts` is ~80 lines containing two nearly identical blocks — one for when a zone has `objectInstanceIds` (the primary path), one falling back to scanning `obj.zoneId`. The duplication is hard to spot because both blocks contain the same filter logic (battlefield/owner/card-type guards) and are separated only by a comment.

**Refactor:** Extract a shared `objectPassesFilter` predicate and two named helpers. `getZoneObjects` becomes a short router between them:

```ts
function objectPassesFilter(
  obj: RawGameObject,
  isBattlefield: boolean,
  ownerFilter: 'mine' | 'opp' | 'any',
  cardTypeFilter: boolean,
  localSeatId: number,
): boolean { ... }

function collectFromInstanceList(zone: RawZone, seen: Set<number>, ...): BoardCard[] { ... }
function collectFromObjectZoneIds(zone: RawZone, seen: Set<number>, ...): BoardCard[] { ... }

function getZoneObjects(zoneType, ownerFilter, cardTypeFilter): BoardCard[] {
  const cards: BoardCard[] = [];
  const seen = new Set<number>();
  for (const zone of zones.values()) {
    if (zone.type !== zoneType) continue;
    cards.push(...(zone.objectInstanceIds
      ? collectFromInstanceList(zone, seen, ...)
      : collectFromObjectZoneIds(zone, seen, ...)));
  }
  return cards;
}
```

**Files:** `src/boardStateParser.ts`

**Why it helps:** The primary/fallback split is the most important architectural fact about zone membership in this codebase. Naming each path makes the decision visible instead of requiring you to read 80 lines of guards to discover it.

---

## 2. Group the closed-over tracking state in `createBoardStateCollector`

**Problem:** The factory closes over 6 independent maps/variables declared separately at the top of the function. Their key schemes (`gameKey`, `gameKey:turnNum`, matchId) are spread across those declarations and hard to read holistically.

**Refactor:** Group them into a single `CollectorState` object so their key schemes can be read side-by-side. Rename the ambiguous `state` parameter in `tryEmit` to `liveState` to avoid shadowing:

```ts
interface CollectorState {
  liveStates: Map<string, LiveGameState>;       // keyed by gameKey(matchId, gameNumber)
  lastTurnNumbers: Map<string, number>;          // keyed by gameKey
  lastPhases: Map<string, string>;               // keyed by gameKey
  lastEmittedLabel: Map<string, string>;         // keyed by gameKey:turnNum
  currentGameNumbers: Map<string, number>;       // keyed by matchId
  completed: TurnSnapshot[];
}
```

**Files:** `src/boardStateParser.ts`

**Why it helps:** Seeing all the keys grouped together lets a reader understand the three-level key scheme in one pass rather than reverse-engineering it from scattered declarations. The `liveState` rename resolves the ambiguity between `LiveGameState` (the per-game accumulated board) and the collector's own tracking state.

---

## 3. Extract the bulk-Courses parser and de-duplicate `toEntries`

**Problem:** `toEntries` is defined twice in `logParser.ts` — once inside `extractDeckInfo` and once inline in the `Courses` block inside `handleParseDeck` — with identical code. The 40-line bulk-Courses parsing block is inlined in `handleParseDeck` with no name, making "where does the deck name come from?" hard to answer quickly.

**Refactor:** Hoist `toEntries` to module level. Extract the Courses block into a named function:

```ts
function toEntries(arr: Array<Record<string, unknown>> | undefined): CardEntry[] { ... }

function applyCoursesPayload(
  courses: unknown[],
  deckByEvent: Map<string, { name: string; deck: DeckList }>,
): void { ... }
```

`handleParseDeck` becomes two calls: `applyCoursesPayload` for the session-start dump, `extractDeckInfo` for per-event responses.

**Files:** `src/logParser.ts`

**Why it helps:** The two deck-detection paths (bulk session start vs. individual event) become symmetrical named functions, making their relationship and priority order obvious.

---

## 4. Remove `boardStateCollector` from `ParseResult`; surface its data directly

**Problem:** `ParseResult` exposes the raw `BoardStateCollector` object — an internal stateful artifact whose job is done by the time parsing returns. Callers have both `boardSnapshots` (filtered) and `boardStateCollector.snapshots()` (unfiltered) with no clear guidance on which to use. The collector's presence implies it's still "live" after parsing.

**Refactor:** Add `rawBoardSnapshots: TurnSnapshot[]` to `ParseResult`. Replace `boardStateCollector` with a plain debug function:

```ts
export interface ParseResult {
  matches: Match[];
  opponentGrpIds: Map<string, Set<number>>;
  gameSnapshots: GameSnapshot[];
  boardSnapshots: TurnSnapshot[];
  rawBoardSnapshots: TurnSnapshot[];
  myDeckListMap: Map<string, DeckList>;
  deckUsages: Map<string, { deck: DeckList; timestamp: number }>;
  debugBoardState: (matchId: string, gameNumber: number) => RawStateDebug | null;
}
```

**Files:** `src/logParser.ts`, `src/index.ts`

**Breaking change:** Removes `boardStateCollector` from the result. Callers using `boardStateCollector.rawState(matchId, gameNum)` migrate to `debugBoardState(matchId, gameNum)`; callers using `boardStateCollector.snapshots()` migrate to `rawBoardSnapshots`.

**Why it helps:** The public API stops leaking an internal implementation type. Callers see two data fields and one debug hook — self-documenting, with no need to understand `BoardStateCollector` internals.
