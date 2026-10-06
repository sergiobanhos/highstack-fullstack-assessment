export type GameCommandErrorCode =
  | 'INVALID_BET'
  | 'INVALID_IDEMPOTENCY_KEY'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'GAME_NOT_SYNCHRONIZED'
  | 'ROUND_NOT_ACCEPTING_BETS'
  | 'BET_ALREADY_EXISTS'
  | 'BET_OUTCOME_UNKNOWN'
  | 'BET_NOT_ACTIVE'
  | 'ROUND_NOT_RUNNING'
  | 'CASHOUT_OUTCOME_UNKNOWN'
  | 'INVALID_QUERY'
  | 'SERVICE_UNAVAILABLE';

const ERROR_MESSAGES: Record<GameCommandErrorCode, string> = {
  INVALID_BET: 'Bet request is invalid',
  INVALID_IDEMPOTENCY_KEY: 'Idempotency key is invalid',
  IDEMPOTENCY_KEY_REUSED: 'Idempotency key was already used for a different command',
  GAME_NOT_SYNCHRONIZED: 'Game is reconnecting and cannot accept commands',
  ROUND_NOT_ACCEPTING_BETS: 'The current round is not accepting bets',
  BET_ALREADY_EXISTS: 'A bet already exists for this player and round',
  BET_OUTCOME_UNKNOWN: 'A previous bet for this player and round is still being resolved',
  BET_NOT_ACTIVE: 'Bet is no longer active',
  ROUND_NOT_RUNNING: 'The bet round is not running',
  CASHOUT_OUTCOME_UNKNOWN: 'A cashout for this bet is still being resolved',
  INVALID_QUERY: 'Game query is invalid',
  SERVICE_UNAVAILABLE: 'Game service is unavailable',
};

export class GameCommandError extends Error {
  constructor(readonly code: GameCommandErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'GameCommandError';
  }
}
