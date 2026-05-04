import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import type { Match, GameResult, MatchResult } from './types/match.js';
import type { GameSnapshot } from './types/gameData.js';
import type { TurnSnapshot } from './types/boardState.js';
import { createGameDataCollector } from './gameDataParser.js';
import { createBoardStateCollector, type BoardStateCollector } from './boardStateParser.js';

export interface ParseConfig {
  /** Directory containing "UTC_Log - *.log" files */
  logDir: string;
  /**
   * Filter which matches to include. Receives the raw MTGA eventId string
   * from reservedPlayers[].eventId. Called once per player; a match is
   * included only if ALL players pass the filter.
   *
   * Defaults to () => true (all matches).
   * Use MatchFilters helpers for common presets.
   */
  matchFilter?: (eventId: string) => boolean;
  /**
   * Optional callback to resolve opponent colors from card grpIds.
   * If omitted, match.opponentColors will be an empty string.
   *
   * Typical implementation queries the MTGA SQLite card database.
   * Mac:     ~/Library/Application Support/com.wizards.mtga/Downloads/Raw/Raw_CardDatabase_*.mtga
   * Windows: %APPDATA%\..\LocalLow\Wizards Of The Coast\MTGA\Downloads\Raw\Raw_CardDatabase_*.mtga
   */
  resolveColors?: (grpIds: number[]) => Promise<string>;
}

export const MatchFilters = {
  /** Traditional_ prefix (ranked + seasonal events) and Constructed_BestOf3 only */
  bo3Constructed: (eventId: string): boolean =>
    eventId.startsWith('Traditional_') || eventId === 'Constructed_BestOf3',

  /** All constructed formats — excludes draft, sealed, and jump-in */
  constructed: (eventId: string): boolean =>
    Boolean(eventId) && !/(Draft|Sealed|Jump_?In)/i.test(eventId),

  /** All matches — the default when matchFilter is omitted */
  all: (): boolean => true,
} as const;

export interface CardEntry {
  cardId: number;
  quantity: number;
}

export interface DeckList {
  main: CardEntry[];
  sideboard: CardEntry[];
}

export interface ParseResult {
  matches: Match[];
  opponentGrpIds: Map<string, Set<number>>;
  gameSnapshots: GameSnapshot[];
  boardSnapshots: TurnSnapshot[];
  myDeckListMap: Map<string, DeckList>;
  boardStateCollector: BoardStateCollector;
  deckUsages: Map<string, { deck: DeckList; timestamp: number }>;
}

// Inlined from src/lib/stats.ts — kept here to avoid a runtime dependency
export function computeMatchResult(g1: GameResult, g2: GameResult, g3: GameResult): MatchResult {
  if (g1 === null) return null;

  const results = [g1, g2, g3].filter((g) => g !== null) as (1 | 0 | 'Draw')[];
  const wins = results.filter((g) => g === 1).length;
  const losses = results.filter((g) => g === 0).length;

  if (wins >= 2) return 'Win';
  if (losses >= 2) return 'Loss';
  if (results.includes('Draw')) {
    if (wins === 1 && losses === 0) return 'Win';
    if (losses === 1 && wins === 0) return 'Loss';
    return 'Draw';
  }
  // Match ended early (opponent timeout or forfeit before accumulating 2 wins/losses).
  if (wins > losses) return 'Win';
  if (losses > wins) return 'Loss';
  return null;
}

interface RawGameResult {
  winningTeamId: number;
  reason: string;
}

export function parseLogDate(filename: string): number {
  const match = filename.match(/(\d{2})-(\d{2})-(\d{4}) (\d{2})\.(\d{2})\.(\d{2})/);
  if (!match) return Infinity;
  const [, mm, dd, yyyy, hh, min, ss] = match;
  return new Date(`${yyyy}-${mm}-${dd}T${hh}:${min}:${ss}Z`).getTime();
}

function tryParseJSON(line: string): unknown {
  const start = line.indexOf('{');
  if (start === -1) return null;
  try {
    return JSON.parse(line.slice(start));
  } catch {
    return null;
  }
}

// Extract deck name and full card list from an EventSetDeckV2 response line/object.
// The event name varies by queue (Traditional_Ladder, Play, Constructed_BestOf3, etc.) — we
// detect by structure, not by event name.
export function extractDeckInfo(obj: Record<string, unknown>): { name: string; deck: DeckList } | null {
  const toEntries = (arr: Array<Record<string, unknown>> | undefined): CardEntry[] =>
    (arr ?? []).flatMap((c) => {
      const cardId = c['cardId'];
      const quantity = c['quantity'];
      if (typeof cardId !== 'number' || typeof quantity !== 'number') return [];
      return [{ cardId, quantity }];
    });

  // Direct structure: { InternalEventName, CourseDeckSummary: { Name }, CourseDeck: { MainDeck, Sideboard } }
  const summary = obj['CourseDeckSummary'] as Record<string, unknown> | undefined;
  if (summary && typeof summary['Name'] === 'string') {
    const name = summary['Name'];
    const courseDeck = obj['CourseDeck'] as Record<string, unknown> | undefined;
    const rawMain = courseDeck?.['MainDeck'] as Array<Record<string, unknown>> | undefined;
    const rawSide = courseDeck?.['Sideboard'] as Array<Record<string, unknown>> | undefined;
    return { name, deck: { main: toEntries(rawMain), sideboard: toEntries(rawSide) } };
  }

  // Nested in request string: { request: '{"Summary":{"Name":"..."}}' }
  const request = obj['request'];
  if (typeof request === 'string') {
    try {
      const inner = JSON.parse(request) as Record<string, unknown>;
      const s = inner['Summary'] as Record<string, unknown> | undefined;
      if (typeof s?.['Name'] === 'string') return { name: s['Name'], deck: { main: [], sideboard: [] } };
    } catch {
      // not JSON
    }
  }
  return null;
}

function handleMatchStart(
  obj: Record<string, unknown>,
  gameRoomInfo: Record<string, unknown>,
  matchMap: Map<string, Match>,
  localTeamIdMap: Map<string, number>,
  pendingDeckName: string,
  myDeckListMap: Map<string, DeckList>,
  pendingDeckList: DeckList,
  deckByEvent: Map<string, { name: string; deck: DeckList }>,
  matchFilter: (eventId: string) => boolean,
): void {
  const config = gameRoomInfo['gameRoomConfig'] as Record<string, unknown> | undefined;
  if (!config) return;

  const matchId = config['matchId'] as string | undefined;
  if (!matchId) return;

  const players = config['reservedPlayers'] as Array<Record<string, unknown>> | undefined;
  if (!players || players.length < 2) return;

  const allPass = players.every((p) => {
    const eventId = p['eventId'];
    return typeof eventId === 'string' && matchFilter(eventId);
  });
  if (!allPass) return;

  // Local player: Mac platform → systemSeatId 1 → players[0]
  let localPlayer = players.find((p) => p['platformId'] === 'Mac');
  if (!localPlayer) localPlayer = players.find((p) => p['systemSeatId'] === 1);
  if (!localPlayer) localPlayer = players[0];

  const opponent = players.find((p) => p['userId'] !== localPlayer!['userId']);
  if (!opponent) return;

  const localTeamId = localPlayer['teamId'];
  if (typeof localTeamId !== 'number') return;
  localTeamIdMap.set(matchId, localTeamId);

  const timestamp =
    typeof obj['timestamp'] === 'string' ? parseInt(obj['timestamp'], 10) : Date.now();

  // Derive a friendly event label from the first player's eventId
  const rawEventId = players[0]?.['eventId'] as string | undefined ?? '';
  const eventLabel = rawEventId === 'Traditional_Ladder' ? 'Ranked'
    : rawEventId.startsWith('Traditional_') ? rawEventId.replace(/^Traditional_/, '').replace(/_/g, ' ')
    : rawEventId === 'Constructed_BestOf3' ? 'Bo3 Play'
    : rawEventId === 'Play' ? 'Bo1 Play'
    : rawEventId === 'PlayRanked' ? 'Bo1 Ranked'
    : rawEventId === 'AIBotMatch' ? 'Bot Match'
    : rawEventId;

  // Prefer per-event deck lookup (from Courses dump or individual EventSetDeckV2).
  // Fall back to pendingDeckName (last-seen deck) only if no event-specific entry exists.
  const eventDeck = deckByEvent.get(rawEventId);
  const resolvedDeckName = eventDeck?.name ?? pendingDeckName;
  const resolvedDeckList = eventDeck?.deck ?? pendingDeckList;

  myDeckListMap.set(matchId, resolvedDeckList);

  matchMap.set(matchId, {
    id: matchId,
    timestamp,
    opponent: (opponent['playerName'] as string) ?? 'Unknown',
    opponentPlatform: (opponent['platformId'] as string) ?? '',
    opponentDeck: '',
    opponentColors: '',
    myDeck: resolvedDeckName,
    onPlay: null,
    game1: null,
    game2: null,
    game3: null,
    matchResult: null,
    eventId: eventLabel,
    importedAt: Date.now(),
    notes: '',
  });
}

function handleMatchEnd(
  gameRoomInfo: Record<string, unknown>,
  matchMap: Map<string, Match>,
  localTeamIdMap: Map<string, number>,
  gameEndReasonsMap: Map<string, string[]>,
): void {
  const finalResult = gameRoomInfo['finalMatchResult'] as Record<string, unknown> | undefined;
  if (!finalResult) return;

  const matchId = finalResult['matchId'] as string | undefined;
  if (!matchId) return;

  const existing = matchMap.get(matchId);
  if (!existing) return;
  if (existing.game1 !== null) return; // already processed

  const localTeamId = localTeamIdMap.get(matchId);
  if (localTeamId === undefined) return;

  const resultList = finalResult['resultList'] as Array<Record<string, unknown>> | undefined;
  if (!resultList) return;

  const gameResults: RawGameResult[] = resultList
    .filter((r) => r['scope'] === 'MatchScope_Game')
    .flatMap((r) => {
      const winningTeamId = r['winningTeamId'];
      const reason = r['reason'];
      if (typeof winningTeamId !== 'number' || typeof reason !== 'string') return [];
      return [{ winningTeamId, reason }];
    });

  // Store the raw per-game reasons so the caller can patch GameSnapshot.gameEndReason.
  // The in-game GameStage_GameOver reasons are unreliable (e.g. life deaths sometimes log
  // as ResultReason_Concede); finalMatchResult.resultList is the authoritative source.
  gameEndReasonsMap.set(matchId, gameResults.map((r) => r.reason));

  const games: GameResult[] = gameResults.map((r) => {
    if (r.reason === 'ResultReason_Draw') return 'Draw';
    return r.winningTeamId === localTeamId ? 1 : 0;
  });

  const g1: GameResult = games[0] ?? null;
  const g2: GameResult = games[1] ?? null;
  const g3: GameResult = games[2] ?? null;

  matchMap.set(matchId, {
    ...existing,
    game1: g1,
    game2: g2,
    game3: g3,
    matchResult: computeMatchResult(g1, g2, g3),
  });
}

// Try to extract onPlay and opponent grpIds from GRE GameStateMessages
// currentMatchId is tracked by the caller from match start/end events
function tryExtractGameState(
  obj: Record<string, unknown>,
  matchMap: Map<string, Match>,
  currentMatchId: string | null,
  opponentGrpIds: Map<string, Set<number>>,
): void {
  if (!currentMatchId) return;
  const existing = matchMap.get(currentMatchId);
  if (!existing) return;

  const gteEvent = obj['greToClientEvent'] as Record<string, unknown> | undefined;
  if (!gteEvent) return;

  const messages = gteEvent['greToClientMessages'] as Array<Record<string, unknown>> | undefined;
  if (!messages) return;

  for (const msg of messages) {
    if (msg['type'] !== 'GREMessageType_GameStateMessage') continue;

    const seatIds = msg['systemSeatIds'] as number[] | undefined;
    const localSeatId = seatIds?.[0];
    if (typeof localSeatId !== 'number') continue;

    const gsm = msg['gameStateMessage'] as Record<string, unknown> | undefined;
    if (!gsm) continue;

    // Collect opponent grpIds from game objects (battlefield, graveyard = visible)
    const gameObjects = gsm['gameObjects'] as Array<Record<string, unknown>> | undefined;
    if (gameObjects) {
      if (!opponentGrpIds.has(currentMatchId)) opponentGrpIds.set(currentMatchId, new Set());
      const grpSet = opponentGrpIds.get(currentMatchId)!;
      for (const go of gameObjects) {
        const owner = go['ownerSeatId'];
        const grp = go['grpId'];
        // Only opponent-owned, real card grpIds (> 100 to skip special token IDs)
        if (typeof owner === 'number' && owner !== localSeatId && typeof grp === 'number' && grp > 100 && go['type'] === 'GameObjectType_Card') {
          grpSet.add(grp);
        }
      }
    }

    // Play/draw detection: game 1, turn 1 only
    const gameInfo = gsm['gameInfo'] as Record<string, unknown> | undefined;
    if (gameInfo?.['gameNumber'] !== 1) continue;

    const turnInfo = gsm['turnInfo'] as Record<string, unknown> | undefined;
    if (!turnInfo) continue;

    const turnNumber = turnInfo['turnNumber'];
    const activePlayer = turnInfo['activePlayer'];
    if (typeof turnNumber !== 'number' || turnNumber !== 1) continue;
    if (typeof activePlayer !== 'number') continue;

    if (existing.onPlay === null) {
      matchMap.set(currentMatchId, { ...existing, onPlay: activePlayer === localSeatId });
    }
  }
}

type MatchFilter = (eventId: string) => boolean;

interface Session {
  matchMap: Map<string, Match>,
  localTeamIdMap: Map<string, number>,
  opponentGrpIds: Map<string, Set<number>>,
  myDeckListMap: Map<string, DeckList>,

    pendingDeckName: string,
    pendingDeckList: DeckList,
    currentMatchId: string | null,
    deckByEvent: Map<string, { name: string; deck: DeckList }>,
    gameEndReasonsMap: Map<string, string[]>,
    deckUsages: Map<string, { deck: DeckList; timestamp: number }>,
    // seatId→teamId per match, used to correct localTeamIdMap from GRE systemSeatIds
    seatToTeamByMatch: Map<string, Map<number, number>>,
    localTeamIdGREConfirmed: Set<string>,

}

interface ParseSession {
  lines: string[],
  session: Session
  gameDataCollector: ReturnType<typeof createGameDataCollector>,
  boardStateCollector: ReturnType<typeof createBoardStateCollector>,
  matchFilter: MatchFilter,
}
function handleParseDeck(line:string, session: Session) {
   const obj = tryParseJSON(line);
      if (obj && typeof obj === 'object') {
        const raw = obj as Record<string, unknown>;

        // Bulk Courses dump: {"Courses": [{InternalEventName, CourseDeckSummary, CourseDeck}...]}
        // This is emitted at session start and contains the current deck for every event queue.
        const courses = raw['Courses'];
        if (Array.isArray(courses)) {
          const toEntries = (arr: Array<Record<string, unknown>> | undefined): CardEntry[] =>
            (arr ?? []).flatMap((c) => {
              const cardId = c['cardId'];
              const quantity = c['quantity'];
              if (typeof cardId !== 'number' || typeof quantity !== 'number') return [];
              return [{ cardId, quantity }];
            });

          for (const course of courses) {
            const c = course as Record<string, unknown>;
            const eventName = c['InternalEventName'];
            const summary = c['CourseDeckSummary'] as Record<string, unknown> | undefined;
            const courseDeck = c['CourseDeck'] as Record<string, unknown> | undefined;
            if (typeof eventName !== 'string' || !summary) continue;
            const name = summary['Name'];
            if (typeof name !== 'string' || name.startsWith('?=?')) continue;
            const rawMain = courseDeck?.['MainDeck'] as Array<Record<string, unknown>> | undefined;
            const rawSide = courseDeck?.['Sideboard'] as Array<Record<string, unknown>> | undefined;
            session.deckByEvent.set(eventName, {
              name,
              deck: { main: toEntries(rawMain), sideboard: toEntries(rawSide) },
            });
          }
        }

        // Individual EventSetDeckV2 / single-course CourseDeckSummary event
        const info = extractDeckInfo(raw);
        if (info) {
          session.pendingDeckName = info.name;
          session.pendingDeckList = info.deck;
          const eventName = raw['InternalEventName'];
          if (typeof eventName === 'string') {
            session.deckByEvent.set(eventName, { name: info.name, deck: info.deck });
          }
        }
      }
}

function handleParseMatchStateChange(line: string, session: Session, ps: ParseSession) {
 const obj = tryParseJSON(line);
      if (obj && typeof obj === 'object') {
        const raw = obj as Record<string, unknown>;
        const event = raw['matchGameRoomStateChangedEvent'] as Record<string, unknown> | undefined;
        if (event) {
          const gameRoomInfo = event['gameRoomInfo'] as Record<string, unknown> | undefined;
          const stateType = (event['stateType'] ?? gameRoomInfo?.['stateType']) as string | undefined;

          if (stateType === 'MatchGameRoomStateType_Playing' && gameRoomInfo) {
            handleMatchStart(raw, gameRoomInfo, session.matchMap, session.localTeamIdMap, session.pendingDeckName, session.myDeckListMap, session.pendingDeckList, session.deckByEvent, ps.matchFilter);
            // Track current match for GRE message association
            const config = gameRoomInfo['gameRoomConfig'] as Record<string, unknown> | undefined;
            const matchId = config?.['matchId'] as string | undefined;
            if (matchId) {
              session.currentMatchId = matchId;
              // Build seatId→teamId map so GRE systemSeatIds can correct the localTeamId
              // (platformId === 'Mac' fails when both players are on Mac)
              const reservedPlayers = config?.['reservedPlayers'] as Array<Record<string, unknown>> | undefined;
              if (reservedPlayers) {
                const seatTeam = new Map<number, number>();
                for (const p of reservedPlayers) {
                  const s = p['systemSeatId'], t = p['teamId'];
                  if (typeof s === 'number' && typeof t === 'number') seatTeam.set(s, t);
                }
                session.seatToTeamByMatch.set(matchId, seatTeam);
              }
            }

            const players = config?.['reservedPlayers'] as Array<Record<string, unknown>> | undefined;
            const rawEventId = (players?.[0]?.['eventId'] as string) ?? '';
            const ts = typeof raw['timestamp'] === 'string' ? parseInt(raw['timestamp'], 10) : 0;
            const eventDeck = session.deckByEvent.get(rawEventId);
            const name = eventDeck?.name ?? session.pendingDeckName;
            const deck = eventDeck?.deck ?? session.pendingDeckList;
            if (name && !name.startsWith('?=?')) {
              const existing = session.deckUsages.get(name);
              if (!existing || ts > existing.timestamp) {
                session.deckUsages.set(name, { deck, timestamp: ts });
              }
            }
          } else if (stateType === 'MatchGameRoomStateType_MatchCompleted' && gameRoomInfo) {
            handleMatchEnd(gameRoomInfo, session.matchMap, session.localTeamIdMap, session.gameEndReasonsMap);
            // Do NOT null currentMatchId here — MTGA often writes trailing GRE messages for
            // the final turns after the MatchCompleted event. Keeping currentMatchId set lets
            // the board state and game data collectors capture those. The next MatchPlaying
            // event naturally replaces it when the next match begins.
          }
        }
      }
}

function handleParseGREEventLine(line: string, session: Session, ps: ParseSession) {
   const obj = tryParseJSON(line);
      if (obj && typeof obj === 'object') {
        const raw = obj as Record<string, unknown>;

        // Correct localTeamId using GRE systemSeatIds — more reliable than the platformId
        // heuristic, which fails when both players are on Mac. Use the first GRE message
        // seen for each match (subsequent messages are the same seat so no need to repeat).
        if (session.currentMatchId && !session.localTeamIdGREConfirmed.has(session.currentMatchId)) {
          const gteEvent = raw['greToClientEvent'] as Record<string, unknown> | undefined;
          const msgs = gteEvent?.['greToClientMessages'] as Array<Record<string, unknown>> | undefined;
          if (msgs) {
            for (const msg of msgs) {
              if (msg['type'] !== 'GREMessageType_GameStateMessage') continue;
              const seatIds = msg['systemSeatIds'] as number[] | undefined;
              const localSeatId = seatIds?.[0];
              if (typeof localSeatId !== 'number') continue;
              const teamId = session.seatToTeamByMatch.get(session.currentMatchId)?.get(localSeatId);
              if (typeof teamId === 'number') {
                session.localTeamIdMap.set(session.currentMatchId, teamId);
                session.localTeamIdGREConfirmed.add(session.currentMatchId);
              }
              break;
            }
          }
        }

        tryExtractGameState(raw, session.matchMap, session.currentMatchId, session.opponentGrpIds);
        ps.gameDataCollector.collect(raw, session.currentMatchId, session.localTeamIdMap);
        ps.boardStateCollector.collect(raw, session.currentMatchId);
      }
}

function parseLinesAndAddToSession(ps: ParseSession): void {
  const session = ps.session;
  for (const line of ps.lines) {
    // Deck name + card list detection: EventSetDeckV2 response or CourseDeckSummary
    if (line.includes('EventSetDeckV2') || line.includes('CourseDeckSummary')) {
      handleParseDeck(line, session);
    }

    // Match state changes
    if (line.includes('matchGameRoomStateChangedEvent')) {
     handleParseMatchStateChange(line, session, ps)
    }

    // Play/draw + opponent card detection + game snapshot data from GRE GameStateMessages
    if (line.includes('greToClientEvent') && line.includes('GameStateMessage')) {
     handleParseGREEventLine(line, session, ps)
    }
  }
}

export async function parseAllLogs(config: ParseConfig): Promise<Match[]> {
  return (await parseAllLogsWithDebug(config)).matches;
}

function buildNewSession(matchFilter: MatchFilter): ParseSession {
  const emptyDeck: DeckList = { main: [], sideboard: [] };
  return {
    lines: [],
    matchFilter,
    session: {
      matchMap: new Map(),
      localTeamIdMap: new Map(),
      opponentGrpIds: new Map(),
      myDeckListMap: new Map(),
      pendingDeckName: '',
      pendingDeckList: emptyDeck,
      currentMatchId: null,
      deckByEvent: new Map(),
      gameEndReasonsMap: new Map(),
      deckUsages: new Map(),
      seatToTeamByMatch: new Map(),
      localTeamIdGREConfirmed: new Set(),
    },
    gameDataCollector: createGameDataCollector(),
    boardStateCollector: createBoardStateCollector(),
  };
}

export async function parseAllLogsWithDebug(config: ParseConfig): Promise<ParseResult> {
  const entries = await readdir(config.logDir);
  const logFiles = entries
    .filter((f) => f.startsWith('UTC_Log') && f.endsWith('.log'))
    .sort((a, b) => parseLogDate(a) - parseLogDate(b));

  const effectiveFilter = config.matchFilter ?? MatchFilters.all;
  const ps = buildNewSession(effectiveFilter);

  for (const filename of logFiles) {
    const text = await readFile(join(config.logDir, filename), 'utf8');
    ps.lines = text.split('\n');
    parseLinesAndAddToSession(ps);
  }

  const { matchMap, opponentGrpIds, myDeckListMap, gameEndReasonsMap, deckUsages } = ps.session;
  const { gameDataCollector, boardStateCollector } = ps;

  // Derive opponent colors from collected grpIds via optional callback — resolved in parallel
  await Promise.all(
    Array.from(opponentGrpIds.entries()).map(async ([matchId, grpSet]) => {
      const existing = matchMap.get(matchId);
      if (!existing) return;
      const colors = (await config.resolveColors?.(Array.from(grpSet))) ?? '';
      if (colors) matchMap.set(matchId, { ...existing, opponentColors: colors });
    }),
  );

  const matches = Array.from(matchMap.values()).filter((m) => m.matchResult !== null);

  // Filter snapshots to only completed matches
  const matchIds = new Set(matches.map((m) => m.id));

  // Patch game end reasons from finalMatchResult — more reliable than in-game GameStage_GameOver
  // reasons which can mislabel life-total deaths as concedes.
  const rawGameSnapshots = gameDataCollector.snapshots().filter((s) => matchIds.has(s.matchId));
  const gameSnapshots = rawGameSnapshots.map((s) => {
    const rawReason = gameEndReasonsMap.get(s.matchId)?.[s.gameNumber - 1];
    if (!rawReason) return s;
    const gameEndReason: GameSnapshot['gameEndReason'] =
      rawReason === 'ResultReason_Life' ? 'life' :
      rawReason === 'ResultReason_Concede' ? 'concede' :
      rawReason === 'ResultReason_Timeout' ? 'timeout' :
      rawReason === 'ResultReason_Draw' ? 'draw' : 'unknown';
    return { ...s, gameEndReason };
  });

  const boardSnapshots = boardStateCollector.snapshots().filter((s) => matchIds.has(s.matchId));

  return {
    matches,
    opponentGrpIds,
    gameSnapshots,
    boardSnapshots,
    myDeckListMap,
    boardStateCollector,
    deckUsages,
  };
}
