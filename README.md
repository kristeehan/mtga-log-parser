# mtga-log-parser

Parse Magic: The Gathering Arena (MTGA) log files into structured match data, per-game snapshots, per-turn board state records, and a full action log of every spell cast and ability used. Supports all formats — Ranked, Bo1, Bo3, limited, bot matches. No manual input required — match results, play/draw, deck names, opponent card colors, and opponent platform are all auto-detected from the log.

## Installation

```
npm install mtga-log-parser
```

## Log file locations

MTGA writes a new `UTC_Log - MM-DD-YYYY HH.MM.SS.log` file each session in the following directories:

- **Mac**: `~/Library/Application Support/com.wizards.mtga/Logs/Logs/`
- **Windows**: `%LOCALAPPDATA%\Packages\Wizards.MTGArcade_rwwe4yf3moird\LocalState\Logs\Logs\`

Pass the directory path (not a single file) to `parseAllLogs` — it will read all `UTC_Log - *.log` files it finds there.

## Basic usage

```ts
import { parseAllLogs } from 'mtga-log-parser';

const matches = await parseAllLogs({
  logDir: '/Users/you/Library/Application Support/com.wizards.mtga/Logs/Logs',
});

for (const match of matches) {
  console.log(match.timestamp, match.myDeck, match.matchResult);
}
```

By default all formats are returned. Use `matchFilter` to restrict to a specific queue:

```ts
import { parseAllLogs, MatchFilters } from 'mtga-log-parser';

// Bo3 constructed only (Ranked, seasonal events, Bo3 Play)
const matches = await parseAllLogs({
  logDir: '...',
  matchFilter: MatchFilters.bo3Constructed,
});
```

## `MatchFilters` presets

| Preset | Includes |
|---|---|
| `MatchFilters.all` | Every match (default) |
| `MatchFilters.bo3Constructed` | `Traditional_*` and `Constructed_BestOf3` only |
| `MatchFilters.constructed` | All constructed formats — excludes draft, sealed, and jump-in |

You can also pass a custom predicate:

```ts
matchFilter: (eventId) => eventId.startsWith('Traditional_'),
```

The `eventId` value is the raw MTGA event string from `reservedPlayers[].eventId` in the log.

## With color resolution

Opponent colors are derived by looking up each `grpId` seen on the opponent's cards in the MTGA card database (a SQLite file). Pass an async `resolveColors` callback that queries that database — the package does not bundle a SQLite driver.

```ts
import { parseAllLogs } from 'mtga-log-parser';
import Database from 'better-sqlite3';
import { glob } from 'glob';

// Find the card DB — MTGA writes it as Raw_CardDatabase_*.mtga (SQLite)
const [dbPath] = await glob(
  '/Users/you/Library/Application Support/com.wizards.mtga/Downloads/Raw/Raw_CardDatabase_*.mtga',
);
const db = new Database(dbPath, { readonly: true });

const matches = await parseAllLogs({
  logDir: '/Users/you/Library/Application Support/com.wizards.mtga/Logs/Logs',

  resolveColors: async (grpIds) => {
    if (grpIds.length === 0) return '';
    const placeholders = grpIds.map(() => '?').join(',');
    const rows = db
      .prepare(`SELECT Colors FROM Cards WHERE GrpId IN (${placeholders})`)
      .all(...grpIds) as Array<{ Colors: string }>;

    // Colors is a comma-separated list of integers: 1=W 2=U 3=B 4=R 5=G
    const map: Record<number, string> = { 1: 'W', 2: 'U', 3: 'B', 4: 'R', 5: 'G' };
    const seen = new Set<string>();
    for (const row of rows) {
      for (const c of row.Colors.split(',')) {
        const letter = map[Number(c)];
        if (letter) seen.add(letter);
      }
    }
    return [...seen].sort().join('');
  },
});
```

## Analytics

### `opponentsByPlatform(matches)`

Returns a count of matches played against each opponent client platform. The platform string comes directly from the MTGA log (`"Mac"`, `"Windows"`, `"iOS"`, `"Android"`). Matches where the platform was not recorded fall under `"Unknown"`.

```ts
import { parseAllLogs, opponentsByPlatform } from 'mtga-log-parser';

const matches = await parseAllLogs({ logDir: '...' });
console.log(opponentsByPlatform(matches));
// { Mac: 42, Windows: 18, iOS: 7, Android: 3 }
```

The raw value is also available per-match as `match.opponentPlatform`.

## Full debug output

`parseAllLogsWithDebug` returns additional data alongside the match list:

```ts
import { parseAllLogsWithDebug } from 'mtga-log-parser';

const result = await parseAllLogsWithDebug({ logDir: '...' });

result.matches;           // Match[] — completed matches (all formats by default)
result.gameSnapshots;     // GameSnapshot[] — one per game (life totals, mulligans, turn count)
result.boardSnapshots;    // TurnSnapshot[] — per-phase board state for every turn
result.turnDrawRecords;   // TurnDrawRecord[] — grpIds drawn by local player per turn
result.gameActions;       // GameAction[] — every spell cast and ability used, with targeting
result.myDeckListMap;     // Map<matchId, DeckList> — grpId card lists
result.deckUsages;        // Map<deckName, { deck, timestamp }> — most recent list per deck name
result.opponentGrpIds;    // Map<matchId, Set<number>> — raw grpIds seen on opponent cards
result.debugBoardState(matchId, gameNumber); // RawStateDebug | null — raw zone/object state for diagnosing board snapshots
```

## Game actions (spells, abilities, targeting)

`result.gameActions` is a flat array of `GameAction` records — one per spell cast or ability used in each game. Both players' actions are included where the source card's `grpId` is resolvable (opponent hand is hidden, but battlefield permanents are visible).

```ts
import { parseAllLogsWithDebug } from 'mtga-log-parser';

const result = await parseAllLogsWithDebug({ logDir: '...' });

for (const action of result.gameActions) {
  console.log(action);
  // {
  //   matchId: 'abc-123',
  //   gameNumber: 1,
  //   turnNumber: 4,
  //   type: 'CastSpell',       // 'CastSpell' | 'ActivateAbility' | 'TriggerAbility'
  //   castByMe: true,          // false when opponent acted
  //   sourceGrpId: 84790,      // grpId of the spell/permanent
  //   sourceInstanceId: 1234,  // instanceId within this game
  //   targetInstanceIds: [5678],       // instanceIds of targets (empty if no targets)
  //   targetGrpIds: [75123],           // grpIds of targets resolved at cast time
  // }
}
```

Filter to a specific match and game:

```ts
const game1Actions = result.gameActions.filter(
  (a) => a.matchId === myMatchId && a.gameNumber === 1
);
```

**Notes:**
- Actions are only included for completed matches (same filter as `matches`).
- `targetGrpIds` may be empty even when targets exist if the target is a face-down or otherwise hidden object.
- `targetInstanceIds` always contains the raw instance IDs from the log regardless of visibility.

## `ParseConfig` reference

| Field | Type | Required | Description |
|---|---|---|---|
| `logDir` | `string` | Yes | Directory containing `UTC_Log - *.log` files |
| `matchFilter` | `(eventId: string) => boolean` | No | Predicate to restrict which matches are included. Defaults to `MatchFilters.all`. Use `MatchFilters.bo3Constructed` to replicate pre-2.0 behavior. |
| `resolveColors` | `(grpIds: number[]) => Promise<string>` | No | Async callback to derive opponent color string (e.g. `"WU"`) from card grpIds. If omitted, `match.opponentColors` will be `""`. |

## Migrating from 3.x

Version 4.0 is additive — no existing fields were removed or renamed. The only change is the new `gameActions: GameAction[]` field on `ParseResult`. Existing code continues to work without modification.

## Migrating from 2.x

Version 3.0 removed `boardStateCollector` from `ParseResult`. Replace any usage:

| 2.x | 3.x |
|---|---|
| `result.boardStateCollector.rawState(matchId, gameNum)` | `result.debugBoardState(matchId, gameNum)` |
| `result.boardStateCollector.snapshots()` | `result.boardSnapshots` (already filtered to completed matches) |

## Migrating from 1.x

Version 2.0 is format-agnostic by default. If you were relying on the implicit Bo3-only filter, add `matchFilter: MatchFilters.bo3Constructed` to your config to restore the previous behavior.

## ESM only

This package is **ESM-only** (`"type": "module"`). It cannot be `require()`d directly. CommonJS consumers must use a dynamic `import()`:

```js
// CommonJS
const { parseAllLogs } = await import('mtga-log-parser');
```

