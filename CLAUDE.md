# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build      # compile TypeScript to dist/ (tsc -p tsconfig.build.json)
npm run dev        # watch mode
npm publish        # runs prepublishOnly (build) then publishes to npm
```

There are no tests or linter configured — `npm run build` (type-check + emit) is the only verification step.

## Architecture

The library is a single-pass log parser with no runtime dependencies. All public API is re-exported from `src/index.ts`.

### Data flow

```
UTC_Log - *.log files
        ↓
  parseAllLogsWithDebug  (src/logParser.ts)
        ↓ feeds lines into
  parseLines  →  handleMatchStart / handleMatchEnd / tryExtractGameState
                 createGameDataCollector   (src/gameDataParser.ts)
                 createBoardStateCollector (src/boardStateParser.ts)
        ↓
  ParseResult  { matches, gameSnapshots, boardSnapshots, deckUsages, … }
```

### Key design decisions

**Single-pass, event-driven.** `parseLines` scans every line for three sentinel strings (`EventSetDeckV2/CourseDeckSummary`, `matchGameRoomStateChangedEvent`, `greToClientEvent`) and only JSON-parses lines that match. State is accumulated in plain Maps passed by reference.

**Match gating via `matchFilter`.** `handleMatchStart` accepts a `(eventId: string) => boolean` predicate threaded down from `parseAllLogsWithDebug`. The `MatchFilters` export provides presets (`all`, `constructed`, `bo3Constructed`). The default is `MatchFilters.all` — no filtering.

**Deck resolution priority.** Per-event deck lookup (`deckByEvent` map, populated from bulk `Courses` dump at session start or individual `EventSetDeckV2` responses) takes priority over `pendingDeckName` (the last deck seen in the log). This means the correct deck is usually associated even when multiple queues are open.

**`gameEndReason` patching.** In-game `GameStage_GameOver` reasons are unreliable (life deaths can be logged as concedes). `handleMatchEnd` stores raw reasons from `finalMatchResult.resultList` in `gameEndReasonsMap`; these are patched into `GameSnapshot` objects after all files are parsed.

**`opponentColors` resolved in parallel.** After parsing, `resolveColors` is called once per match via `Promise.all`. The callback receives all `grpId`s seen on opponent-owned `GameObjectType_Card` objects.

### Output types (src/types/)

- `Match` — one record per completed match; `game2`/`game3` are `null` for Bo1; includes `opponentPlatform` auto-captured from `reservedPlayers[].platformId`
- `GameSnapshot` — life totals, mulligan counts, turn count, end reason; one per game
- `TurnSnapshot` — full board state snapshot per phase; includes hand, battlefield, graveyard, stack for both players
- `DeckList` — `{ main: CardEntry[], sideboard: CardEntry[] }` where each entry is `{ cardId, quantity }`

### Analytics (src/analytics.ts)

`opponentsByPlatform(matches: Match[]): Record<string, number>` — aggregates matches by opponent platform string. Exported from `src/index.ts`.

### Sub-collectors

`createGameDataCollector` and `createBoardStateCollector` are factory functions that return a `collect(raw, matchId, ...)` method and a `snapshots()` method. They process `greToClientEvent / GameStateMessage` payloads independently and are called from `parseLines` after `tryExtractGameState`.

### ESM-only

`"type": "module"` in `package.json`. Imports within `src/` use `.js` extensions (required for ESM TypeScript). `tsconfig.build.json` emits to `dist/` and excludes test files; `tsconfig.json` is the IDE config.
