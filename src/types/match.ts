export type GameResult = 1 | 0 | 'Draw' | null;

export type MatchResult = 'Win' | 'Loss' | 'Draw' | null;

export interface Match {
  id: string;           // matchId UUID from log
  timestamp: number;    // ms epoch from log
  opponent: string;     // opponent playerName from log
  opponentPlatform: string; // opponent's client platform from log, e.g. "Mac", "Windows", "iOS", "Android"
  opponentDeck: string;   // manual entry, default ''
  opponentColors: string; // manual entry, e.g. "WU", "BR", "RG" — standard MTG color letters
  myDeck: string;         // auto-detected from log, default ''
  onPlay: boolean | null; // auto-detected from log
  game1: GameResult;
  game2: GameResult;
  game3: GameResult;
  matchResult: MatchResult; // calculated, not stored raw
  eventId: string;      // e.g. "Ranked"
  importedAt: number;   // when we parsed this match
  notes: string;       // manual entry, default ''
}

export type MatchUpdate = Partial<Pick<Match, 'opponentDeck' | 'opponentColors' | 'myDeck' | 'notes'>>;
