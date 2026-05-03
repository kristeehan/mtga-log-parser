export interface BoardCard {
  instanceId: number;
  grpId: number;
  name: string;           // resolved from card DB
  power?: number;
  toughness?: number;
  isTapped: boolean;
  counters?: Record<string, number>;
}

export interface TurnSnapshot {
  matchId: string;
  gameNumber: 1 | 2 | 3;
  turnNumber: number;
  activePlayerIsMe: boolean;
  phase: string;
  myLife: number;
  oppLife: number;
  myHand: BoardCard[];
  oppHandCount: number;
  myBattlefield: BoardCard[];
  oppBattlefield: BoardCard[];
  myGraveyard: BoardCard[];
  oppGraveyard: BoardCard[];
  myExile: BoardCard[];
  oppExile: BoardCard[];
  stack: BoardCard[];
}
