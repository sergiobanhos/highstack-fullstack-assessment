import type { BetCommandResult, EngineBetStatus } from '../../../lib/operator/operator-api';

export interface BetRoundContext {
  roundId: string | null;
  phase: string | null;
}

export function shouldRefreshBetsForSnapshot(
  previousRoundId: string | null,
  current: BetRoundContext,
  connected: boolean,
): boolean {
  if (!connected || current.roundId === null) return false;
  return previousRoundId === null || previousRoundId !== current.roundId || current.phase === 'crashed';
}

const ENGINE_STATUS_LABELS: Record<EngineBetStatus, string> = {
  active: 'Active',
  lost: 'Lost',
  cashed_out: 'Cashed out',
};

/**
 * An accepted active bet is pending only when the operator has evidence that
 * its round is no longer the current open round. The browser never infers a
 * terminal engine outcome from a crash or round transition.
 */
export function isBetOutcomePending(
  bet: BetCommandResult,
  context: BetRoundContext,
): boolean {
  if (bet.betCommandStatus !== 'accepted' || bet.bet?.engineStatus !== 'active') return false;
  if (context.roundId === null) return false;
  return bet.roundId !== context.roundId || (context.phase === 'crashed' && bet.roundId === context.roundId);
}

export function getBetGameStatusLabel(
  bet: BetCommandResult,
  context: BetRoundContext,
): string {
  if (bet.bet === null) return '—';
  if (isBetOutcomePending(bet, context)) return 'Checking result';
  return ENGINE_STATUS_LABELS[bet.bet.engineStatus];
}
