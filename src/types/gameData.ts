export interface GameSnapshot {
  matchId: string;
  gameNumber: 1 | 2 | 3;
  myMulliganCount: number;       // 0 = kept 7; absent in log when 0, so defaults to 0
  opponentMulliganCount: number;
  myFinalLife: number;           // life total at GameStage_GameOver
  opponentFinalLife: number;
  turnCount: number;             // max(myTurnNumber, oppTurnNumber) at game end
  gameEndReason: 'life' | 'concede' | 'timeout' | 'draw' | 'unknown';
}
