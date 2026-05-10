import type {
  BoardCard,
  TurnSnapshot,
  TurnDrawRecord,
  RawGameObject,
  RawZone,
  LiveGameState,
  RawStateDebug,
  BoardStateCollector,
  CollectorState,
} from './types.js';
import { toBoardCard, gameKey, toGameObject, mergeGameObject, toZone, toPlayer } from './rawGameObjects.js';


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

  function* zoneObjects(zone: RawZone): Generator<RawGameObject | undefined> {
    if (zone.objectInstanceIds) {
      for (const id of zone.objectInstanceIds) yield gameObjects.get(id);
    } else {
      for (const obj of gameObjects.values()) {
        if (obj.zoneId === zone.zoneId) yield obj;
      }
    }
  }

  function* parseObjects(
    objects: Iterable<RawGameObject | undefined>,
    seen: Set<number>,
    isBattlefield: boolean,
    ownerFilter: 'mine' | 'opp' | 'any',
    cardTypeFilter: boolean,
  ): Generator<BoardCard> {
    for (const obj of objects) {
      if (!obj || !obj.grpId) continue;
      if (seen.has(obj.instanceId)) continue;

      if (cardTypeFilter) {
        const allowed = isBattlefield
          ? obj.type === 'GameObjectType_Card' || obj.type === 'GameObjectType_Token'
          : obj.type === 'GameObjectType_Card';
        if (!allowed) continue;
      }

      if (isBattlefield && ownerFilter !== 'any') {
        const controller = obj.controllerSeatId ?? obj.ownerSeatId;
        if (ownerFilter === 'mine' && controller !== undefined && controller !== localSeatId) continue;
        if (ownerFilter === 'opp'  && controller !== undefined && controller === localSeatId) continue;
      }

      if (!isBattlefield && ownerFilter !== 'any' && obj.ownerSeatId !== undefined) {
        if (ownerFilter === 'mine' && obj.ownerSeatId !== localSeatId) continue;
        if (ownerFilter === 'opp'  && obj.ownerSeatId === localSeatId) continue;
      }

      seen.add(obj.instanceId);
      yield toBoardCard(obj);
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

      for (const card of parseObjects(zoneObjects(zone), seen, isBattlefield, ownerFilter, cardTypeFilter)) {
        cards.push(card);
      }
    }
    return cards;
  }

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

  // Opponent hand count — cards are face-down (grpId=0/undefined) so getZoneObjects skips them.
  // Count all objects in the opponent's hand zone directly.
  let oppHandCount = 0;
  for (const zone of zones.values()) {
    if (zone.type !== 'ZoneType_Hand') continue;
    if (zone.ownerSeatId === localSeatId) continue;
    oppHandCount += zone.objectInstanceIds?.length
      ?? [...gameObjects.values()].filter(o => o.zoneId === zone.zoneId).length;
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
    oppHandCount,
    myBattlefield: getZoneObjects('ZoneType_Battlefield', 'mine', true),
    oppBattlefield: getZoneObjects('ZoneType_Battlefield', 'opp', true),
    myGraveyard: getZoneObjects('ZoneType_Graveyard', 'mine', true),
    oppGraveyard: getZoneObjects('ZoneType_Graveyard', 'opp', true),
    myExile: getZoneObjects('ZoneType_Exile', 'mine', true),
    oppExile: getZoneObjects('ZoneType_Exile', 'opp', true),
    stack,
  };
}

function createCollectorState(): CollectorState {
  return {
    liveStates: new Map<string, LiveGameState>(),
    lastTurnNumbers: new Map<string, number>(),
    lastPhases: new Map<string, string>(),
    lastEmittedLabel: new Map<string, string>(),
    currentGameNumbers: new Map<string, number>(),
    completed: [],
    drawsByTurnKey: new Map<string, TurnDrawRecord>(),
  };
}

export function createBoardStateCollector(): BoardStateCollector {
  const collectorState = createCollectorState();
  const { liveStates, lastTurnNumbers, lastPhases, lastEmittedLabel, currentGameNumbers, completed, drawsByTurnKey } = collectorState;

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
    liveState: LiveGameState,
    phaseLabel: string,
    capturedTurnNumber: number,
    capturedActivePlayer: number | undefined,
  ): void {
    if (liveState.gameNumber === null) return;
    const key = `${gameKey(matchId, liveState.gameNumber)}:${capturedTurnNumber}`;
    // Skip consecutive duplicates — pendingEmits already deduplicates within a batch;
    // this catches the rare case of MTGA re-broadcasting the same phase in a later batch.
    if (lastEmittedLabel.get(key) === phaseLabel) return;
    lastEmittedLabel.set(key, phaseLabel);

    const snapshot = buildSnapshot(matchId, liveState, phaseLabel, capturedTurnNumber, capturedActivePlayer);
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

      // Process ZoneTransfer/Draw annotations to record which cards the local player drew.
      // Annotations are processed after game objects are merged so that newly revealed
      // hand cards (added in the same message) can be looked up by instanceId.
      const rawAnnotations = gsm['annotations'] as Array<Record<string, unknown>> | undefined;
      if (rawAnnotations && state.turnInfo?.turnNumber !== undefined) {
        const turnNum = state.turnInfo.turnNumber;
        for (const ann of rawAnnotations) {
          if (turnNum === 0) continue;
          if (ann['type'] !== 'AnnotationType_ZoneTransfer') continue;
          if (ann['category'] !== 'Draw') continue;

          const affectedIds = ann['affectedIds'];
          if (!Array.isArray(affectedIds)) continue;

          for (const affectedId of affectedIds) {
            if (typeof affectedId !== 'number') continue;
            const go = state.gameObjects.get(affectedId);
            // Only track draws where the grpId is resolvable (local player's cards are visible)
            if (!go?.grpId) continue;
            // Confirm the card is owned by the local player (opponent hand is hidden)
            if (go.ownerSeatId !== undefined && go.ownerSeatId !== state.localSeatId) continue;

            const key = `${currentMatchId}:${gameNumber}:${turnNum}`;
            if (!drawsByTurnKey.has(key)) {
              drawsByTurnKey.set(key, { matchId: currentMatchId, gameNumber, turnNumber: turnNum, drawnGrpIds: [] });
            }
            drawsByTurnKey.get(key)!.drawnGrpIds.push(go.grpId);
          }
        }
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

  return {
    collect,
    snapshots: () => completed,
    drawRecords: () => Array.from(drawsByTurnKey.values()),
    rawState,
  };
}
