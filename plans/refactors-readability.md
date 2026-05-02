# Plan: Readability Refactors

A set of structural refactors aimed at making the codebase easier to understand. None of these add features or change behaviour — they reorganise existing logic so the data flow and architectural decisions are easier to read.

---

## 1. Consolidate `parseLines` state into a `ParseSession` object

**Problem:** `parseLines` takes 9 positional arguments plus an 8-field `state` bag — two arbitrary namespaces for the same thing: mutable parser state. Why something lives in `state.*` vs. a separate argument is not obvious.

**Refactor:** Define a single `ParseSession` interface that absorbs all of it. `parseLines` and its helpers (`handleMatchStart`, `handleMatchEnd`, etc.) each take `session` instead of 4–8 individual arguments. `parseAllLogsWithDebug` creates one `ParseSession` and passes it through.

```ts
interface ParseSession {
  matchMap: Map<string, Match>;
  localTeamIdMap: Map<string, number>;
  opponentGrpIds: Map<string, Set<number>>;
  myDeckListMap: Map<string, DeckList>;
  pendingDeckName: string;
  pendingDeckList: DeckList;
  currentMatchId: string | null;
  deckByEvent: Map<string, { name: string; deck: DeckList }>;
  gameEndReasonsMap: Map<string, string[]>;
  deckUsages: Map<string, { deck: DeckList; timestamp: number }>;
  seatToTeamByMatch: Map<string, Map<number, number>>;
  localTeamIdGREConfirmed: Set<string>;
  gameDataCollector: GameDataCollector;
  boardStateCollector: BoardStateCollector;
}
```

**Files:** `src/logParser.ts`

**Why it helps:** Readers get a single object that represents "everything the parser accumulates across all files" — one mental model, not two.

---

## 2. Split `parseLines` into three named event handlers

**Problem:** The main loop has three large `if` blocks — deck detection, match lifecycle, GRE events — fused into one function body. Following any one concern means mentally filtering out the other two.

**Refactor:** Extract each branch into a named function. The loop becomes a short router:

```ts
function handleDeckLine(line: string, session: ParseSession): void { ... }
function handleMatchStateChangeLine(line: string, session: ParseSession, matchFilter: ...): void { ... }
function handleGREEventLine(line: string, session: ParseSession): void { ... }

for (const line of lines) {
  if (line.includes('EventSetDeckV2') || line.includes('CourseDeckSummary'))
    handleDeckLine(line, session);
  if (line.includes('matchGameRoomStateChangedEvent'))
    handleMatchStateChangeLine(line, session, matchFilter);
  if (line.includes('greToClientEvent') && line.includes('GameStateMessage'))
    handleGREEventLine(line, session);
}
```

**Files:** `src/logParser.ts`

**Why it helps:** Each of the three event types represents a distinct concern. Naming them makes the architecture scannable — you can navigate directly to the concern you care about.

---

## 3. Extract the primary/fallback paths in `getZoneObjects` into named helpers

**Problem:** `getZoneObjects` in `boardStateParser.ts` is 83 lines containing two nearly identical 35-line blocks — one for when a zone has `objectInstanceIds`, one falling back to `obj.zoneId`. The duplication is hard to spot because the blocks are separated by a comment and interleaved with guards.

**Refactor:** Extract a shared `objectPassesFilter` predicate and two named helpers. `getZoneObjects` becomes a short router between them:

```ts
function objectPassesFilter(obj, zone, isBattlefield, ownerFilter, cardTypeFilter, localSeatId): boolean { ... }
function collectFromZoneInstanceList(zone, seen, ...): BoardCard[] { ... }
function collectFromObjectZoneIds(zone, seen, ...): BoardCard[] { ... }

function getZoneObjects(zoneType, ownerFilter, cardTypeFilter): BoardCard[] {
  const cards: BoardCard[] = [];
  const seen = new Set<number>();
  for (const zone of zones.values()) {
    if (zone.type !== zoneType) continue;
    if (zone.objectInstanceIds) {
      cards.push(...collectFromZoneInstanceList(zone, seen, ...));
    } else {
      cards.push(...collectFromObjectZoneIds(zone, seen, ...));
    }
  }
  return cards;
}
```

**Files:** `src/boardStateParser.ts`

**Why it helps:** The primary/fallback split is the most important architectural fact about zone membership in this codebase. Naming each path makes the decision visible instead of requiring you to read 80 lines of guards to discover it.

---

## 4. Name the deferred-emit queue element and consolidate closed-over maps in `createBoardStateCollector`

**Problem:** The factory closes over 7 independent maps/arrays declared separately at the top of the function. The pending-emit queue is typed inline as `Array<{ state: LiveGameState; phase: string }>`. The three-level key scheme (`gameKey`, `gameKey:turnNum`, matchId) is spread across those 7 declarations and hard to read holistically.

**Refactor:** Introduce a `PendingEmit` interface. Group the 7 closed-over tracking maps into a single `CollectorState` object so their key schemes can be read side-by-side. Rename the ambiguous `state` parameter in `tryEmit`/`collect` to `liveState`.

```ts
interface PendingEmit {
  liveState: LiveGameState;
  phaseLabel: string;
}

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

**Why it helps:** Seeing all the keys grouped together lets a reader understand the three-level key scheme in one pass rather than reverse-engineering it from scattered declarations.

---

## 5. Extract the bulk-Courses parser and de-duplicate `toEntries`

**Problem:** `toEntries` is defined twice in `logParser.ts` — inside `extractDeckInfo` and inline in the Courses block — with identical code. The 40-line bulk-Courses parsing block is inlined in `parseLines` with no name, making "where does the deck name come from?" hard to answer quickly.

**Refactor:** Hoist `toEntries` to module level. Extract the Courses block into a named function:

```ts
function toEntries(arr: Array<Record<string, unknown>> | undefined): CardEntry[] { ... }

function applyCoursesPayload(
  courses: unknown[],
  deckByEvent: Map<string, { name: string; deck: DeckList }>,
): void { ... }
```

The deck-detection branch of `handleDeckLine` (from refactor #2) becomes two calls: `applyCoursesPayload` for the session-start dump, `extractDeckInfo` for per-event responses.

**Files:** `src/logParser.ts`

**Why it helps:** The two deck-detection paths (bulk session start vs. individual event) become symmetrical named functions, making their relationship and priority order obvious.

---

## 6. Remove `boardStateCollector` from `ParseResult`; surface its data directly

**Problem:** `ParseResult` exposes the raw `BoardStateCollector` object — an internal stateful artifact whose job is done by the time parsing returns. Callers have both `boardSnapshots` (filtered) and `boardStateCollector.snapshots()` (unfiltered) with no clear guidance on which to use. The collector's presence implies it's still "live" after parsing.

**Refactor:** Add `rawBoardSnapshots: TurnSnapshot[]` to `ParseResult`. Replace the `boardStateCollector` field with a plain `debugBoardState` function field:

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

**Why it helps:** The public API stops leaking an internal implementation type. Callers see two data fields and one debug hook — self-documenting, with no need to understand `BoardStateCollector` internals. This is a minor breaking change (removes `boardStateCollector` from the result).
