import type { BoardCard, TurnSnapshot } from './types/boardState.js';

interface RawGameObject {
  instanceId: number;
  grpId?: number;
  ownerSeatId?: number;
  controllerSeatId?: number;
  type?: string;
  power?: number;
  toughness?: number;
  zoneId?: number;
  isTapped?: boolean;
  counters?: Record<string, number>;
}

interface RawZone {
  zoneId: number;
  type?: string;
  ownerSeatId?: number;
  objectInstanceIds?: number[];
}

interface RawPlayer {
  systemSeatNumber?: number;
  lifeTotal?: number;
  turnNumber?: number;
}

interface RawTurnInfo {
  turnNumber?: number;
  activePlayer?: number;
  phase?: string;
  step?: string;
}

interface LiveGameState {
  gameObjects: Map<number, RawGameObject>;
  zones: Map<number, RawZone>;
  players: Map<number, RawPlayer>;
  turnInfo: RawTurnInfo | null;
  gameNumber: number | null;
  localSeatId: number | null;
  // MTGA sometimes advances turnNumber before all combat phases are logged.
  // Track the turn and active player at BeginCombat so continuation phases
  // (DeclareAttackers → CombatDamage → EndCombat) are attributed to the correct turn.
  activeCombatTurn: number | null;
  activeCombatPlayer: number | undefined;
}

function gameKey(matchId: string, gameNumber: number): string {
  return `${matchId}:${gameNumber}`;
}


function toGameObject(raw: Record<string, unknown>): RawGameObject | null {
  const instanceId = raw['instanceId'];
  if (typeof instanceId !== 'number') return null;

  const grpId = typeof raw['grpId'] === 'number' ? raw['grpId'] : undefined;
  const ownerSeatId = typeof raw['ownerSeatId'] === 'number' ? raw['ownerSeatId'] : undefined;
  const controllerSeatId = typeof raw['controllerSeatId'] === 'number' ? raw['controllerSeatId'] : undefined;
  const type = typeof raw['type'] === 'string' ? raw['type'] : undefined;
  const power = typeof raw['power'] === 'number' ? raw['power'] : undefined;
  const toughness = typeof raw['toughness'] === 'number' ? raw['toughness'] : undefined;
  const zoneId = typeof raw['zoneId'] === 'number' ? raw['zoneId'] : undefined;

  // isTapped: check direct boolean field or status string
  let isTapped = false;
  if (typeof raw['isTapped'] === 'boolean') {
    isTapped = raw['isTapped'];
  } else if (typeof raw['status'] === 'string') {
    isTapped = raw['status'] === 'StatusType_Tapped';
  }

  // counters: object mapping counter type string to number
  let counters: Record<string, number> | undefined;
  if (raw['counters'] && typeof raw['counters'] === 'object' && !Array.isArray(raw['counters'])) {
    const rawCounters = raw['counters'] as Record<string, unknown>;
    const built: Record<string, number> = {};
    for (const [k, v] of Object.entries(rawCounters)) {
      if (typeof v === 'number') built[k] = v;
    }
    if (Object.keys(built).length > 0) counters = built;
  }

  return { instanceId, grpId, ownerSeatId, controllerSeatId, type, power, toughness, zoneId, isTapped, counters };
}

// Merge a delta game object update into an existing entry.
// Only overwrite fields that are explicitly present in the raw delta — absent fields keep
// their existing values. This prevents delta messages (e.g. {instanceId, isTapped:true})
// from wiping out zoneId, grpId, controllerSeatId, and other fields not in the delta.
function mergeGameObject(
  existing: RawGameObject,
  raw: Record<string, unknown>,
  parsed: RawGameObject,
): RawGameObject {
  const tapExplicit = 'isTapped' in raw || 'status' in raw;
  return {
    instanceId: parsed.instanceId,
    grpId: parsed.grpId ?? existing.grpId,
    ownerSeatId: parsed.ownerSeatId ?? existing.ownerSeatId,
    controllerSeatId: parsed.controllerSeatId ?? existing.controllerSeatId,
    type: parsed.type ?? existing.type,
    power: parsed.power ?? existing.power,
    toughness: parsed.toughness ?? existing.toughness,
    zoneId: parsed.zoneId ?? existing.zoneId,
    isTapped: tapExplicit ? parsed.isTapped : existing.isTapped,
    counters: parsed.counters ?? existing.counters,
  };
}

function toZone(raw: Record<string, unknown>): RawZone | null {
  const zoneId = raw['zoneId'];
  if (typeof zoneId !== 'number') return null;

  const type = typeof raw['type'] === 'string' ? raw['type'] : undefined;
  const ownerSeatId = typeof raw['ownerSeatId'] === 'number' ? raw['ownerSeatId'] : undefined;
  const objectInstanceIds = Array.isArray(raw['objectInstanceIds'])
    ? (raw['objectInstanceIds'] as unknown[]).filter((x): x is number => typeof x === 'number')
    : undefined;

  return { zoneId, type, ownerSeatId, objectInstanceIds };
}

function toPlayer(raw: Record<string, unknown>): RawPlayer {
  return {
    systemSeatNumber: typeof raw['systemSeatNumber'] === 'number' ? raw['systemSeatNumber'] : undefined,
    lifeTotal: typeof raw['lifeTotal'] === 'number' ? raw['lifeTotal'] : undefined,
    turnNumber: typeof raw['turnNumber'] === 'number' ? raw['turnNumber'] : undefined,
  };
}

function toBoardCard(obj: RawGameObject): BoardCard {
  return {
    instanceId: obj.instanceId,
    grpId: obj.grpId ?? 0,
    name: '',  // resolved at endpoint time
    power: obj.power,
    toughness: obj.toughness,
    isTapped: obj.isTapped ?? false,
    counters: obj.counters,
  };
}

function buildSnapshot(
  matchId: string,
  state: LiveGameState,
  phase: string,
  // Capture turn number and active player at the moment of the phase transition rather than
  // at emit time. A single GRE batch can span two turns (e.g., end of turn N and start of
  // turn N+1); by the time all messages are processed, state.turnInfo.turnNumber has already
  // advanced, causing earlier-turn phases to be stamped with the new turn number.
  capturedTurnNumber?: number,
  capturedActivePlayer?: number,
): TurnSnapshot | null {
  const { gameObjects, zones, players, turnInfo, gameNumber, localSeatId } = state;

  const turnNumber = capturedTurnNumber ?? turnInfo?.turnNumber;
  if (turnNumber === undefined || gameNumber === null || localSeatId === null) {
    return null;
  }

  const activePlayerSeat = capturedActivePlayer ?? turnInfo?.activePlayer;
  const activePlayerIsMe = activePlayerSeat === localSeatId;

  // Life totals
  let myLife = 20;
  let oppLife = 20;
  for (const p of players.values()) {
    if (p.systemSeatNumber === localSeatId) {
      myLife = p.lifeTotal ?? 20;
    } else {
      oppLife = p.lifeTotal ?? 20;
    }
  }

  // Use zone.objectInstanceIds as the authoritative source for which objects are in each zone.
  // This is more reliable than obj.zoneId, which can be wiped by delta messages that only
  // update other fields (e.g. tap status). obj.zoneId is only a fallback.
  function getZoneObjects(
    zoneType: string,
    ownerFilter: 'mine' | 'opp' | 'any',
    cardTypeFilter: boolean,
  ): BoardCard[] {
    const isBattlefield = zoneType === 'ZoneType_Battlefield';
    const seen = new Set<number>();
    const cards: BoardCard[] = [];

    for (const zone of zones.values()) {
      if (zone.type !== zoneType) continue;

      // For hand/graveyard: filter to the correct player's zone via zone.ownerSeatId.
      // Battlefield is shared — filtering happens per-object via controllerSeatId below.
      if (!isBattlefield && ownerFilter !== 'any' && zone.ownerSeatId !== undefined) {
        if (ownerFilter === 'mine' && zone.ownerSeatId !== localSeatId) continue;
        if (ownerFilter === 'opp' && zone.ownerSeatId === localSeatId) continue;
      }

      if (zone.objectInstanceIds) {
        // Primary path: use zone's authoritative instance list
        for (const instanceId of zone.objectInstanceIds) {
          if (seen.has(instanceId)) continue;
          const obj = gameObjects.get(instanceId);
          if (!obj || !obj.grpId) continue;

          if (cardTypeFilter) {
            const allowed = isBattlefield
              ? obj.type === 'GameObjectType_Card' || obj.type === 'GameObjectType_Token'
              : obj.type === 'GameObjectType_Card';
            if (!allowed) continue;
          }

          // For battlefield: filter by controllerSeatId (handles stolen permanents)
          if (isBattlefield && ownerFilter !== 'any') {
            const controller = obj.controllerSeatId ?? obj.ownerSeatId;
            if (ownerFilter === 'mine' && controller !== undefined && controller !== localSeatId) continue;
            if (ownerFilter === 'opp' && controller !== undefined && controller === localSeatId) continue;
          }

          // For hand/graveyard: if zone.ownerSeatId was absent, fall back to per-object ownerSeatId.
          // Also acts as a belt-and-suspenders check even when zone.ownerSeatId is set.
          if (!isBattlefield && ownerFilter !== 'any' && obj.ownerSeatId !== undefined) {
            if (ownerFilter === 'mine' && obj.ownerSeatId !== localSeatId) continue;
            if (ownerFilter === 'opp' && obj.ownerSeatId === localSeatId) continue;
          }

          seen.add(instanceId);
          cards.push(toBoardCard(obj));
        }
      } else {
        // Fallback: zone has no objectInstanceIds, use obj.zoneId
        for (const obj of gameObjects.values()) {
          if (obj.zoneId !== zone.zoneId) continue;
          if (seen.has(obj.instanceId)) continue;
          if (!obj.grpId) continue;

          if (cardTypeFilter) {
            const allowed = isBattlefield
              ? obj.type === 'GameObjectType_Card' || obj.type === 'GameObjectType_Token'
              : obj.type === 'GameObjectType_Card';
            if (!allowed) continue;
          }

          if (isBattlefield && ownerFilter !== 'any') {
            const controller = obj.controllerSeatId ?? obj.ownerSeatId;
            if (ownerFilter === 'mine' && controller !== undefined && controller !== localSeatId) continue;
            if (ownerFilter === 'opp' && controller !== undefined && controller === localSeatId) continue;
          }

          // For hand/graveyard in fallback path: filter by ownerSeatId
          if (!isBattlefield && ownerFilter !== 'any' && obj.ownerSeatId !== undefined) {
            if (ownerFilter === 'mine' && obj.ownerSeatId !== localSeatId) continue;
            if (ownerFilter === 'opp' && obj.ownerSeatId === localSeatId) continue;
          }

          seen.add(obj.instanceId);
          cards.push(toBoardCard(obj));
        }
      }
    }
    return cards;
  }

  // Stack: use zone.objectInstanceIds as authoritative to avoid stale resolved objects.
  const stack: BoardCard[] = [];
  for (const zone of zones.values()) {
    if (zone.type !== 'ZoneType_Stack') continue;
    for (const instanceId of zone.objectInstanceIds ?? []) {
      const obj = gameObjects.get(instanceId);
      if (!obj || !obj.grpId) continue;
      stack.push(toBoardCard(obj));
    }
  }

  if (gameNumber < 1 || gameNumber > 3) return null;
  const gn = gameNumber as 1 | 2 | 3;

  return {
    matchId,
    gameNumber: gn,
    turnNumber,
    activePlayerIsMe,
    phase,
    myLife,
    oppLife,
    myHand: getZoneObjects('ZoneType_Hand', 'mine', true),
    myBattlefield: getZoneObjects('ZoneType_Battlefield', 'mine', true),
    oppBattlefield: getZoneObjects('ZoneType_Battlefield', 'opp', true),
    myGraveyard: getZoneObjects('ZoneType_Graveyard', 'mine', true),
    oppGraveyard: getZoneObjects('ZoneType_Graveyard', 'opp', true),
    myExile: getZoneObjects('ZoneType_Exile', 'mine', true),
    oppExile: getZoneObjects('ZoneType_Exile', 'opp', true),
    stack,
  };
}

export interface RawStateDebug {
  gameNumber: number | null;
  localSeatId: number | null;
  turnInfo: RawTurnInfo | null;
  zones: Array<{ zoneId: number; type?: string; ownerSeatId?: number; objectCount: number }>;
  gameObjects: Array<{ instanceId: number; grpId?: number; zoneId?: number; type?: string; ownerSeatId?: number; controllerSeatId?: number; isTapped: boolean }>;
}

export interface BoardStateCollector {
  collect(
    obj: Record<string, unknown>,
    currentMatchId: string | null,
  ): void;
  snapshots(): TurnSnapshot[];
  rawState(matchId: string, gameNumber: number): RawStateDebug | null;
}

export function createBoardStateCollector(): BoardStateCollector {
  // Per-match per-game live state
  const liveStates = new Map<string, LiveGameState>();
  // Track last turn number per game to detect new turns
  const lastTurnNumbers = new Map<string, number>();
  // Track last emitted phase/step label per game — emit whenever turn or label changes
  const lastPhases = new Map<string, string>();
  // Track the last label emitted per (game, turn) for consecutive-duplicate suppression.
  // Keyed by `gameKey:turnNum`. Using last-label rather than an all-time set allows the
  // same label (e.g. Phase_Main) to appear again after an intervening phase (e.g. combat),
  // which is how Main Phase 2 is captured.
  const lastEmittedLabel = new Map<string, string>();
  // Track current game number per match — many delta messages omit gameInfo entirely
  const currentGameNumbers = new Map<string, number>();
  const completed: TurnSnapshot[] = [];

  function getOrCreateState(matchId: string, gameNumber: number): LiveGameState {
    const key = gameKey(matchId, gameNumber);
    if (!liveStates.has(key)) {
      liveStates.set(key, {
        gameObjects: new Map(),
        zones: new Map(),
        players: new Map(),
        turnInfo: null,
        gameNumber,
        localSeatId: null,
        activeCombatTurn: null,
        activeCombatPlayer: undefined,
      });
    }
    return liveStates.get(key)!;
  }

  function tryEmit(
    matchId: string,
    state: LiveGameState,
    phaseLabel: string,
    capturedTurnNumber: number,
    capturedActivePlayer: number | undefined,
  ): void {
    if (state.gameNumber === null) return;
    const key = `${gameKey(matchId, state.gameNumber)}:${capturedTurnNumber}`;
    // Skip consecutive duplicates — pendingEmits already deduplicates within a batch;
    // this catches the rare case of MTGA re-broadcasting the same phase in a later batch.
    if (lastEmittedLabel.get(key) === phaseLabel) return;
    lastEmittedLabel.set(key, phaseLabel);

    const snapshot = buildSnapshot(matchId, state, phaseLabel, capturedTurnNumber, capturedActivePlayer);
    if (snapshot) completed.push(snapshot);
  }

  function collect(
    obj: Record<string, unknown>,
    currentMatchId: string | null,
  ): void {
    if (!currentMatchId) return;

    const gteEvent = obj['greToClientEvent'] as Record<string, unknown> | undefined;
    if (!gteEvent) return;
    const messages = gteEvent['greToClientMessages'] as Array<Record<string, unknown>> | undefined;
    if (!messages) return;

    // Combat continuation phases: MTGA sometimes advances turnNumber before these are logged,
    // so we attribute them to the turn where BeginCombat was first seen.
    const COMBAT_CONTINUATION = new Set([
      'Step_DeclareAttack', 'Step_DeclareBlock', 'Step_CombatDamage', 'Step_EndCombat',
    ]);

    for (const msg of messages) {
      if (msg['type'] !== 'GREMessageType_GameStateMessage') continue;

      // Local seat from systemSeatIds[0]; persist across messages that omit it
      const seatIds = msg['systemSeatIds'] as number[] | undefined;
      const msgLocalSeatId = typeof seatIds?.[0] === 'number' ? seatIds[0] : undefined;

      const gsm = msg['gameStateMessage'] as Record<string, unknown> | undefined;
      if (!gsm) continue;

      const gameInfo = gsm['gameInfo'] as Record<string, unknown> | undefined;
      const gameNumberRaw = gameInfo?.['gameNumber'];
      if (typeof gameNumberRaw === 'number') {
        currentGameNumbers.set(currentMatchId, gameNumberRaw);
      }
      const gameNumber = currentGameNumbers.get(currentMatchId);
      if (typeof gameNumber !== 'number') continue;

      // Each gameNumber gets its own isolated LiveGameState — stale objects from a prior
      // game never pollute a new one because getOrCreateState keys by (matchId, gameNumber).
      const state = getOrCreateState(currentMatchId, gameNumber);

      // Update localSeatId if this message carries one; otherwise keep existing
      if (msgLocalSeatId !== undefined) state.localSeatId = msgLocalSeatId;
      if (state.localSeatId === null) continue; // skip until we've seen a seatId

      const gameStateType = typeof gsm['type'] === 'string' ? gsm['type'] : undefined;
      const isFullState = gameStateType === 'GameStateType_Full';

      const rawGameObjects = gsm['gameObjects'] as Array<Record<string, unknown>> | undefined;
      if (rawGameObjects) {
        if (isFullState) {
          // Full state: authoritative list — remove any objects absent from the message
          // (e.g. cards returned to library during a mulligan).
          const liveIds = new Set<number>();
          for (const raw of rawGameObjects) {
            const id = raw['instanceId'];
            if (typeof id === 'number') liveIds.add(id);
          }
          for (const existingId of state.gameObjects.keys()) {
            if (!liveIds.has(existingId)) state.gameObjects.delete(existingId);
          }
          for (const raw of rawGameObjects) {
            const go = toGameObject(raw);
            if (go) state.gameObjects.set(go.instanceId, go);
          }
        } else {
          // Delta message: merge with existing to preserve fields absent from the delta.
          // Without this, a tap update like {instanceId, isTapped:true} would wipe out
          // zoneId, grpId, controllerSeatId — making the card disappear from zone lookups.
          for (const raw of rawGameObjects) {
            const go = toGameObject(raw);
            if (!go) continue;
            const existing = state.gameObjects.get(go.instanceId);
            if (existing) {
              state.gameObjects.set(go.instanceId, mergeGameObject(existing, raw, go));
            } else {
              state.gameObjects.set(go.instanceId, go);
            }
          }
        }
      }

      // Merge zones — same principle: preserve objectInstanceIds if not in the delta.
      // On full state: remove zones absent from the message (same as game objects) to prevent
      // stale empty graveyard/hand zones from persisting across games or mulligans.
      const rawZones = gsm['zones'] as Array<Record<string, unknown>> | undefined;
      if (rawZones) {
        if (isFullState) {
          const liveZoneIds = new Set<number>();
          for (const raw of rawZones) {
            const id = raw['zoneId'];
            if (typeof id === 'number') liveZoneIds.add(id);
          }
          for (const existingZoneId of state.zones.keys()) {
            if (!liveZoneIds.has(existingZoneId)) state.zones.delete(existingZoneId);
          }
        }
        for (const raw of rawZones) {
          const zone = toZone(raw);
          if (!zone) continue;
          if (!isFullState) {
            const existing = state.zones.get(zone.zoneId);
            if (existing) {
              state.zones.set(zone.zoneId, {
                zoneId: zone.zoneId,
                type: zone.type ?? existing.type,
                ownerSeatId: zone.ownerSeatId ?? existing.ownerSeatId,
                objectInstanceIds: zone.objectInstanceIds ?? existing.objectInstanceIds,
              });
            } else {
              state.zones.set(zone.zoneId, zone);
            }
          } else {
            state.zones.set(zone.zoneId, zone);
          }
        }
      }

      // Merge players
      const rawPlayers = gsm['players'] as Array<Record<string, unknown>> | undefined;
      if (rawPlayers) {
        for (const raw of rawPlayers) {
          const player = toPlayer(raw);
          if (typeof player.systemSeatNumber === 'number') {
            state.players.set(player.systemSeatNumber, player);
          }
        }
      }

      // Merge turnInfo
      const rawTurnInfo = gsm['turnInfo'] as Record<string, unknown> | undefined;
      if (rawTurnInfo) {
        const incomingPhase = typeof rawTurnInfo['phase'] === 'string' ? rawTurnInfo['phase'] : undefined;
        const incomingStep = typeof rawTurnInfo['step'] === 'string' ? rawTurnInfo['step'] : undefined;
        // Step is only meaningful within its parent phase. When phase changes and the new
        // message omits step, clear it — otherwise the old step pollutes the phaseLabel for
        // the new phase, causing Phase_Main (no step) to be silently skipped.
        const phaseChanged = incomingPhase !== undefined && incomingPhase !== state.turnInfo?.phase;
        state.turnInfo = {
          turnNumber: typeof rawTurnInfo['turnNumber'] === 'number' ? rawTurnInfo['turnNumber'] : state.turnInfo?.turnNumber,
          activePlayer: typeof rawTurnInfo['activePlayer'] === 'number' ? rawTurnInfo['activePlayer'] : state.turnInfo?.activePlayer,
          phase: incomingPhase ?? state.turnInfo?.phase,
          step: incomingStep ?? (phaseChanged ? '' : state.turnInfo?.step),
        };
      }

      if (!state.turnInfo?.turnNumber) continue;

      const currentTurn = state.turnInfo.turnNumber;
      const turnKey = gameKey(currentMatchId, gameNumber);
      const prevTurn = lastTurnNumbers.get(turnKey);
      const phase = state.turnInfo.phase ?? 'Phase_Unknown';
      // Use step name when available — steps are sub-phases within Phase_Begin (Untap/Upkeep/Draw)
      // and combat (DeclareAttackers/DeclareBlockers/etc.). Comparing only phase misses these.
      const step = state.turnInfo.step ?? '';
      const phaseLabel = step || phase;
      const prevPhase = lastPhases.get(turnKey);

      // Track combat start so continuation phases can be attributed to the correct turn
      // even when MTGA has already advanced turnNumber by the time it logs them.
      if (phaseLabel === 'Step_BeginCombat') {
        state.activeCombatTurn = currentTurn;
        state.activeCombatPlayer = state.turnInfo.activePlayer;
      }
      const effectiveTurn = (state.activeCombatTurn !== null && COMBAT_CONTINUATION.has(phaseLabel))
        ? state.activeCombatTurn
        : currentTurn;
      const effectivePlayer = (state.activeCombatTurn !== null && COMBAT_CONTINUATION.has(phaseLabel))
        ? state.activeCombatPlayer
        : state.turnInfo.activePlayer;
      if (phaseLabel === 'Step_EndCombat') {
        state.activeCombatTurn = null;
        state.activeCombatPlayer = undefined;
      }

      // Emit a snapshot immediately after each message's state updates are applied.
      // This ensures each snapshot reflects the board state at that exact phase transition,
      // rather than at the end of the batch (which may span multiple turns).
      if (prevTurn !== currentTurn) {
        lastTurnNumbers.set(turnKey, currentTurn);
        lastPhases.set(turnKey, phaseLabel);
        tryEmit(currentMatchId, state, phaseLabel, effectiveTurn, effectivePlayer);
      } else if (phaseLabel !== prevPhase) {
        lastPhases.set(turnKey, phaseLabel);
        tryEmit(currentMatchId, state, phaseLabel, effectiveTurn, effectivePlayer);
      }
    }
  }

  function rawState(matchId: string, gameNumber: number): RawStateDebug | null {
    const state = liveStates.get(gameKey(matchId, gameNumber));
    if (!state) return null;
    return {
      gameNumber: state.gameNumber,
      localSeatId: state.localSeatId,
      turnInfo: state.turnInfo,
      zones: Array.from(state.zones.values()).map((z) => ({
        zoneId: z.zoneId,
        type: z.type,
        ownerSeatId: z.ownerSeatId,
        objectCount: z.objectInstanceIds?.length ?? 0,
      })),
      gameObjects: Array.from(state.gameObjects.values()).map((o) => ({
        instanceId: o.instanceId,
        grpId: o.grpId,
        zoneId: o.zoneId,
        type: o.type,
        ownerSeatId: o.ownerSeatId,
        controllerSeatId: o.controllerSeatId,
        isTapped: o.isTapped ?? false,
      })),
    };
  }

  return { collect, snapshots: () => completed, rawState };
}
