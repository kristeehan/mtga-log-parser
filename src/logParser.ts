import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import type { Match, GameResult, MatchResult } from './types/match.js';
import type { GameSnapshot } from './types/gameData.js';
import type { TurnSnapshot } from './types/boardState.js';
import { createGameDataCollector } from './gameDataParser.js';
import { createBoardStateCollector } from './boardStateParser.js';

export interface ParseConfig {
  /** Directory containing "UTC_Log - *.log" files */
  logDir: string;
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
  boardStateCollector: ReturnType<typeof createBoardStateCollector>;
  deckUsages: Map<string, { deck: DeckList; timestamp: number }>;
}

// Inlined from src/lib/stats.ts — kept here to avoid a runtime dependency
function computeMatchResult(g1: GameResult, g2: GameResult, g3: GameResult): MatchResult {
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

function parseLogDate(filename: string): number {
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
function extractDeckInfo(obj: Record<string, unknown>): { name: string; deck: DeckList } | null {
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
): void {
  const config = gameRoomInfo['gameRoomConfig'] as Record<string, unknown> | undefined;
  if (!config) return;

  const matchId = config['matchId'] as string | undefined;
  if (!matchId) return;

  const players = config['reservedPlayers'] as Array<Record<string, unknown>> | undefined;
  if (!players || players.length < 2) return;

  // Accept all Traditional (Bo3) constructed event formats.
  // Traditional_Ladder = ranked, Traditional_Cons_Event_* = season events, Constructed_BestOf3 = open play BO3.
  // Exclude casual Play, AIBotMatch, and limited formats.
  function isBo3Constructed(eventId: unknown): boolean {
    if (typeof eventId !== 'string') return false;
    return (
      eventId.startsWith('Traditional_') ||
      eventId === 'Constructed_BestOf3'
    );
  }
  const allBo3 = players.every((p) => isBo3Constructed(p['eventId']));
  if (!allBo3) return;

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

// True for any format where the player builds their own deck.
// Excludes draft, sealed, and jump-in where you use a drafted/opened card pool.
function isConstructedEvent(eventId: string): boolean {
  return Boolean(eventId) && !/(Draft|Sealed|Jump_?In)/i.test(eventId);
}

function parseLines(
  lines: string[],
  matchMap: Map<string, Match>,
  localTeamIdMap: Map<string, number>,
  opponentGrpIds: Map<string, Set<number>>,
  myDeckListMap: Map<string, DeckList>,
  state: {
    pendingDeckName: string;
    pendingDeckList: DeckList;
    currentMatchId: string | null;
    deckByEvent: Map<string, { name: string; deck: DeckList }>;
    gameEndReasonsMap: Map<string, string[]>;
    deckUsages: Map<string, { deck: DeckList; timestamp: number }>;
  },
  gameDataCollector: ReturnType<typeof createGameDataCollector>,
  boardStateCollector: ReturnType<typeof createBoardStateCollector>,
): void {
  for (const line of lines) {
    // Deck name + card list detection: EventSetDeckV2 response or CourseDeckSummary
    if (line.includes('EventSetDeckV2') || line.includes('CourseDeckSummary')) {
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
            state.deckByEvent.set(eventName, {
              name,
              deck: { main: toEntries(rawMain), sideboard: toEntries(rawSide) },
            });
          }
        }

        // Individual EventSetDeckV2 / single-course CourseDeckSummary event
        const info = extractDeckInfo(raw);
        if (info) {
          state.pendingDeckName = info.name;
          state.pendingDeckList = info.deck;
          const eventName = raw['InternalEventName'];
          if (typeof eventName === 'string') {
            state.deckByEvent.set(eventName, { name: info.name, deck: info.deck });
          }
        }
      }
    }

    // Match state changes
    if (line.includes('matchGameRoomStateChangedEvent')) {
      const obj = tryParseJSON(line);
      if (obj && typeof obj === 'object') {
        const raw = obj as Record<string, unknown>;
        const event = raw['matchGameRoomStateChangedEvent'] as Record<string, unknown> | undefined;
        if (event) {
          const gameRoomInfo = event['gameRoomInfo'] as Record<string, unknown> | undefined;
          const stateType = (event['stateType'] ?? gameRoomInfo?.['stateType']) as string | undefined;

          if (stateType === 'MatchGameRoomStateType_Playing' && gameRoomInfo) {
            handleMatchStart(raw, gameRoomInfo, matchMap, localTeamIdMap, state.pendingDeckName, myDeckListMap, state.pendingDeckList, state.deckByEvent);
            // Track current match for GRE message association
            const config = gameRoomInfo['gameRoomConfig'] as Record<string, unknown> | undefined;
            const matchId = config?.['matchId'] as string | undefined;
            if (matchId) state.currentMatchId = matchId;

            // Track deck usage for ALL constructed formats (not just Bo3) so the Decks tab
            // shows decks played in Bo1, bot matches, etc. Match recording is unaffected.
            const players = config?.['reservedPlayers'] as Array<Record<string, unknown>> | undefined;
            const rawEventId = (players?.[0]?.['eventId'] as string) ?? '';
            if (isConstructedEvent(rawEventId)) {
              const ts = typeof raw['timestamp'] === 'string' ? parseInt(raw['timestamp'], 10) : 0;
              const eventDeck = state.deckByEvent.get(rawEventId);
              const name = eventDeck?.name ?? state.pendingDeckName;
              const deck = eventDeck?.deck ?? state.pendingDeckList;
              if (name && !name.startsWith('?=?')) {
                const existing = state.deckUsages.get(name);
                if (!existing || ts > existing.timestamp) {
                  state.deckUsages.set(name, { deck, timestamp: ts });
                }
              }
            }
          } else if (stateType === 'MatchGameRoomStateType_MatchCompleted' && gameRoomInfo) {
            handleMatchEnd(gameRoomInfo, matchMap, localTeamIdMap, state.gameEndReasonsMap);
            state.currentMatchId = null;
          }
        }
      }
    }

    // Play/draw + opponent card detection + game snapshot data from GRE GameStateMessages
    if (line.includes('greToClientEvent') && line.includes('GameStateMessage')) {
      const obj = tryParseJSON(line);
      if (obj && typeof obj === 'object') {
        const raw = obj as Record<string, unknown>;
        tryExtractGameState(raw, matchMap, state.currentMatchId, opponentGrpIds);
        gameDataCollector.collect(raw, state.currentMatchId, localTeamIdMap);
        boardStateCollector.collect(raw, state.currentMatchId);
      }
    }
  }
}

export async function parseAllLogs(config: ParseConfig): Promise<Match[]> {
  return (await parseAllLogsWithDebug(config)).matches;
}

export async function parseAllLogsWithDebug(config: ParseConfig): Promise<ParseResult> {
  const entries = await readdir(config.logDir);
  const logFiles = entries
    .filter((f) => f.startsWith('UTC_Log') && f.endsWith('.log'))
    .sort((a, b) => parseLogDate(a) - parseLogDate(b));

  const matchMap = new Map<string, Match>();
  const localTeamIdMap = new Map<string, number>();
  const opponentGrpIds = new Map<string, Set<number>>();
  const myDeckListMap = new Map<string, DeckList>();
  const emptyDeck: DeckList = { main: [], sideboard: [] };
  const state = {
    pendingDeckName: '',
    pendingDeckList: emptyDeck,
    currentMatchId: null as string | null,
    deckByEvent: new Map<string, { name: string; deck: DeckList }>(),
    gameEndReasonsMap: new Map<string, string[]>(),
    deckUsages: new Map<string, { deck: DeckList; timestamp: number }>(),
  };
  const gameDataCollector = createGameDataCollector();
  const boardStateCollector = createBoardStateCollector();

  for (const filename of logFiles) {
    const text = await readFile(join(config.logDir, filename), 'utf8');
    parseLines(text.split('\n'), matchMap, localTeamIdMap, opponentGrpIds, myDeckListMap, state, gameDataCollector, boardStateCollector);
  }

  // Derive opponent colors from collected grpIds via optional callback
  for (const [matchId, grpSet] of opponentGrpIds.entries()) {
    const existing = matchMap.get(matchId);
    if (!existing) continue;
    const colors = (await config.resolveColors?.(Array.from(grpSet))) ?? '';
    if (colors) matchMap.set(matchId, { ...existing, opponentColors: colors });
  }

  const matches = Array.from(matchMap.values()).filter((m) => m.matchResult !== null);

  // Filter snapshots to only completed matches
  const matchIds = new Set(matches.map((m) => m.id));

  // Patch game end reasons from finalMatchResult — more reliable than in-game GameStage_GameOver
  // reasons which can mislabel life-total deaths as concedes.
  const rawGameSnapshots = gameDataCollector.snapshots().filter((s) => matchIds.has(s.matchId));
  const gameSnapshots = rawGameSnapshots.map((s) => {
    const rawReason = state.gameEndReasonsMap.get(s.matchId)?.[s.gameNumber - 1];
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
    deckUsages: state.deckUsages,
  };
}
