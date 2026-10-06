/** Centralized cache keys; use the authenticated player id to isolate sessions. */
export const queryKeys = {
  player: (playerId: string) => ['player', playerId] as const,
  wallet: (playerId: string) => ['player', playerId, 'wallet'] as const,
  transactions: (playerId: string) => ['player', playerId, 'transactions'] as const,
  payouts: (playerId: string) => ['player', playerId, 'payouts'] as const,
  payout: (playerId: string, payoutId: string) => ['player', playerId, 'payout', payoutId] as const,
  bets: (playerId: string, limit = 10) => ['player', playerId, 'bets', limit] as const,
  command: (playerId: string, commandId: string) => ['player', playerId, 'command', commandId] as const,
  bet: (playerId: string, betId: string) => ['player', playerId, 'bet', betId] as const,
};
