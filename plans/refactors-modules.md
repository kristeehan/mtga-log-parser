# Plan: Module Extraction Refactors

`logParser.ts` is 611 lines and carries six distinct responsibilities — pure utilities, types, deck parsing, match start/end handling, GRE state extraction, and the top-level orchestration loop. Each responsibility is a natural extraction target. After all tasks below, `logParser.ts` should shrink to ~200 lines covering only the session types and the parsing loop.

`boardStateParser.ts` at 625 lines has one natural extraction point covered in Task 4.

None of these change behaviour — they redistribute existing code into cohesive homes.

---

## 1. Extract `src/utils.ts` — pure utility functions

**Problem:** `computeMatchResult`, `parseLogDate`, `tryParseJSON`, and `toEntries` live in `logParser.ts` but have zero coupling to parser state — they're pure functions over primitive inputs. `computeMatchResult` and `parseLogDate` are already exported for tests, which is awkward from a 600-line file that also owns the top-level parse entry points. The stale comment on `computeMatchResult` ("Inlined from src/lib/stats.ts") is a relic from a different repo.

**Refactor:** Create `src/utils.ts` and move all four functions there. Remove the stale comment. Export `computeMatchResult` and `parseLogDate`; keep `tryParseJSON` and `toEntries` unexported (they're internal).

```
src/utils.ts
  export function computeMatchResult(...)
  export function parseLogDate(...)
  function tryParseJSON(...)          // internal
  function toEntries(...)             // internal
```

Update `logParser.ts` to import from `./utils.js`. Update `src/__tests__/unit.test.ts` to import `computeMatchResult` and `parseLogDate` from `./utils.js` instead of `./logParser.js`.

**Files:** `src/utils.ts` (new), `src/logParser.ts`, `src/__tests__/unit.test.ts`

**Why it helps:** Tests import from a file that only contains utilities. `logParser.ts` stops exporting implementation helpers.

---

## 2. Extract `src/deckParser.ts` — deck resolution subsystem

**Problem:** `applyCoursesPayload`, `extractDeckInfo`, and `handleParseDeck` form a self-contained subsystem: all three functions exist solely to populate `session.deckByEvent` and `session.pendingDeckName`. The `CardEntry` and `DeckList` types are defined in `logParser.ts` even though they belong semantically to deck parsing. `extractDeckInfo` is exported for tests, which looks strange when it's defined in the same file as `parseAllLogs`.

**Refactor:** Create `src/deckParser.ts`. Move `CardEntry`, `DeckList`, `toEntries`, `applyCoursesPayload`, `extractDeckInfo`, and `handleParseDeck` there. `toEntries` moves here from `src/utils.ts` (it only has one consumer, and that consumer is `deckParser.ts`). Export `CardEntry`, `DeckList`, and `extractDeckInfo`; keep the rest unexported.

```
src/deckParser.ts
  export interface CardEntry { ... }
  export interface DeckList { ... }
  function toEntries(...)
  export function extractDeckInfo(...)
  function applyCoursesPayload(...)
  export function handleParseDeck(line, session): void
```

`handleParseDeck` needs `tryParseJSON` — import from `./utils.js`. It also needs `session.deckByEvent`, `session.pendingDeckName`, `session.pendingDeckList` — pass the `Session` object (same signature as today).

Update `logParser.ts` to import `CardEntry`, `DeckList`, `extractDeckInfo`, and `handleParseDeck` from `./deckParser.js`. Update `src/index.ts` to re-export `CardEntry` and `DeckList` from `./deckParser.js`. Update tests to import `extractDeckInfo` from `./deckParser.js`.

**Files:** `src/deckParser.ts` (new), `src/logParser.ts`, `src/index.ts`, `src/__tests__/unit.test.ts`

**Why it helps:** "Where does deck name resolution live?" has a one-word answer. `logParser.ts` stops defining data types.

---

## 3. Extract `src/matchHandler.ts` — match start/end handlers

**Problem:** `handleMatchStart`, `handleMatchEnd`, and `tryExtractGameState` are 200 lines of match state machine logic embedded in `logParser.ts`. They're called from only two places — `handleParseMatchStateChange` and `handleParseGREEventLine` — but their implementations are buried far from those call sites, making the data flow hard to trace.

**Refactor:** Create `src/matchHandler.ts`. Move `RawGameResult`, `handleMatchStart`, `handleMatchEnd`, and `tryExtractGameState` there. All three functions take only typed parameters (Maps, filter function, raw objects) — no closure state — so this is a straight move.

```
src/matchHandler.ts
  interface RawGameResult { ... }      // internal
  export function handleMatchStart(...)
  export function handleMatchEnd(...)
  export function tryExtractGameState(...)
```

Dependencies: imports `computeMatchResult` from `./utils.js`; imports `Match`, `GameResult`, `MatchResult` from `./types/match.js`; imports `DeckList` from `./deckParser.js`.

`logParser.ts` imports all three functions from `./matchHandler.js`.

**Files:** `src/matchHandler.ts` (new), `src/logParser.ts`

**Why it helps:** `logParser.ts` becomes a composition file — it assembles the sub-handlers rather than implementing them. The match state machine is findable by name.

---

## 4. Extract raw type interfaces from `src/boardStateParser.ts`

**Problem:** `boardStateParser.ts` opens with 130 lines of interface definitions and object-mapping functions (`RawGameObject`, `RawZone`, `RawPlayer`, `RawTurnInfo`, `LiveGameState`, `toGameObject`, `mergeGameObject`, `toZone`, `toPlayer`, `toBoardCard`). These are mechanical data-shape mappings from raw JSON to typed structs — they share no logic with the snapshot builder or the collector's event-routing code. Having them inline makes the file start slowly and buries the actual interesting logic.

**Refactor:** Create `src/rawGameObjects.ts`. Move the five interfaces and five mapping functions there. Keep them all unexported (they're implementation details of `boardStateParser.ts`).

```
src/rawGameObjects.ts
  interface RawGameObject { ... }
  interface RawZone { ... }
  interface RawPlayer { ... }
  interface RawTurnInfo { ... }
  interface LiveGameState { ... }
  export function toGameObject(...)
  export function mergeGameObject(...)
  export function toZone(...)
  export function toPlayer(...)
  export function toBoardCard(...)
```

`boardStateParser.ts` imports the five functions (not the interfaces — it still needs those locally, or re-imports them). Since the interfaces are needed in `boardStateParser.ts` as parameter/return types, export them from `rawGameObjects.ts` and import in `boardStateParser.ts`.

**Files:** `src/rawGameObjects.ts` (new), `src/boardStateParser.ts`

**Why it helps:** `boardStateParser.ts` opens with `createBoardStateCollector` rather than 130 lines of struct definitions. The mapping code is findable without scrolling past `CollectorState`, `buildSnapshot`, and all the merge logic.

---

## After all tasks: expected file sizes

| File | Before | After |
|---|---|---|
| `src/logParser.ts` | 611 lines | ~200 lines |
| `src/boardStateParser.ts` | 625 lines | ~500 lines |
| `src/utils.ts` | — | ~50 lines |
| `src/deckParser.ts` | — | ~100 lines |
| `src/matchHandler.ts` | — | ~210 lines |
| `src/rawGameObjects.ts` | — | ~130 lines |
