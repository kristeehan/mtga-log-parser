// Main entry point — re-exports all public API surface

// Core parse functions
export { parseAllLogs, parseAllLogsWithDebug, MatchFilters } from './logParser.js';

// Sub-collector factories
export { createGameDataCollector } from './gameDataParser.js';
export { createBoardStateCollector } from './boardStateParser.js';

// Config / result types from logParser
export type { ParseConfig, ParseResult, CardEntry, DeckList } from './logParser.js';

// Match types
export type { Match, GameResult, MatchResult, MatchUpdate } from './types/match.js';

// Game snapshot types
export type { GameSnapshot } from './types/gameData.js';

// Board state types
export type { BoardCard, TurnSnapshot } from './types/boardState.js';

// Collector interfaces
export type { GameDataCollector } from './gameDataParser.js';
export type { BoardStateCollector, RawStateDebug } from './boardStateParser.js';

// Analytics
export { opponentsByPlatform } from './analytics.js';
