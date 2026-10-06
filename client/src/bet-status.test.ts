import { describe, expect, test } from 'bun:test';
import type { BetCommandResult, EngineBetStatus } from './operator-api';
import {
  getBetGameStatusLabel,
  isBetOutcomePending,
  shouldRefreshBetsForSnapshot,
} from './bet-status';

function bet(engineStatus: EngineBetStatus | null = 'active'): BetCommandResult {
  return {
    commandId: 'command-1',
    roundId: 'round-1',
    amountCents: 1000,
    autoCashoutHundredths: null,
    betCommandStatus: 'accepted',
    resultCode: null,
    betId: 'bet-1',
    bet: engineStatus === null ? null : {
      betId: 'bet-1',
      engineStatus,
      multiplierHundredths: engineStatus === 'cashed_out' ? 240 : null,
      payoutCents: engineStatus === 'cashed_out' ? 2400 : null,
      settlementStatus: engineStatus === 'cashed_out' ? 'pending' : 'not_applicable',
    },
  };
}

describe('bet status projection', () => {
  test('keeps an active bet in the current open round as in progress', () => {
    const currentBet = bet();
    expect(isBetOutcomePending(currentBet, { roundId: 'round-1', phase: 'running' })).toBe(false);
    expect(getBetGameStatusLabel(currentBet, { roundId: 'round-1', phase: 'running' })).toBe('Active');
    expect(getBetGameStatusLabel(currentBet, { roundId: 'round-1', phase: 'betting' })).toBe('Active');
  });

  test('shows a same-round active bet as checking after a known crash', () => {
    const currentBet = bet();
    const context = { roundId: 'round-1', phase: 'crashed' };
    expect(isBetOutcomePending(currentBet, context)).toBe(true);
    expect(getBetGameStatusLabel(currentBet, context)).toBe('Checking result');
  });

  test('shows an active bet from an older round as checking after snapshot advances', () => {
    const context = { roundId: 'round-2', phase: 'betting' };
    expect(isBetOutcomePending(bet(), context)).toBe(true);
    expect(getBetGameStatusLabel(bet(), context)).toBe('Checking result');
  });

  test('does not invent a result without a snapshot or override terminal engine statuses', () => {
    expect(getBetGameStatusLabel(bet(), { roundId: null, phase: null })).toBe('Active');
    expect(getBetGameStatusLabel(bet('lost'), { roundId: 'round-2', phase: 'running' })).toBe('Lost');
    expect(getBetGameStatusLabel(bet('cashed_out'), { roundId: 'round-2', phase: 'running' })).toBe('Cashed out');
    expect(getBetGameStatusLabel(bet(null), { roundId: 'round-2', phase: 'running' })).toBe('—');
  });

  test('does not project rejected or non-active commands as pending', () => {
    const rejected = { ...bet(), betCommandStatus: 'rejected' as const };
    expect(isBetOutcomePending(rejected, { roundId: 'round-2', phase: 'running' })).toBe(false);
  });

  test('reloads bets on first sync, crash, or round change, but not on ordinary ticks', () => {
    expect(shouldRefreshBetsForSnapshot(null, { roundId: 'round-1', phase: 'running' }, true)).toBe(true);
    expect(shouldRefreshBetsForSnapshot('round-1', { roundId: 'round-1', phase: 'running' }, true)).toBe(false);
    expect(shouldRefreshBetsForSnapshot('round-1', { roundId: 'round-1', phase: 'crashed' }, true)).toBe(true);
    expect(shouldRefreshBetsForSnapshot('round-1', { roundId: 'round-2', phase: 'betting' }, true)).toBe(true);
    expect(shouldRefreshBetsForSnapshot('round-1', { roundId: 'round-2', phase: 'betting' }, false)).toBe(false);
  });
});
