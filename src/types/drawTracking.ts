/** One record per turn, listing the grpIds drawn by the local player that turn. */
export interface TurnDrawRecord {
  matchId: string;
  gameNumber: number;
  turnNumber: number;
  /** grpIds drawn by the local player this turn (in draw order). */
  drawnGrpIds: number[];
}
