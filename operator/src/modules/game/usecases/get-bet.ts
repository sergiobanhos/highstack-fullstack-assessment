import type { BetCommandResult, GetGameBetInput } from '../game.contracts';
import { and, eq, inArray } from 'drizzle-orm';
import type { OperatorDatabase } from '../../../db';
import { CrashsimHttpClient, CrashsimHttpError, type CrashsimBet } from '../../../integrations/crashsim/http.client';
import { gameBets, type GameEngineBetStatus, type GameSettlementStatus } from '../game.schema';
import { GameCommandError } from '../game.errors';
import type { BetToPersist } from './place-bet';
import type { StoredCommand } from './command-persistence';

type OwnedBet = typeof gameBets.$inferSelect;

export interface GetGameBetDeps {
  db: OperatorDatabase;
  engine: Pick<CrashsimHttpClient, 'getBet'>;
  cashoutInFlight: Map<string, Promise<BetCommandResult>>;
  loadBet(playerId: string, betId: string): Promise<OwnedBet | undefined>;
  loadUnresolvedCashout(playerId: string, betId: string): Promise<StoredCommand | undefined>;
  currentCommand(playerId: string, commandId: string): Promise<StoredCommand | undefined>;
  reconcileCashout(command: StoredCommand): Promise<BetCommandResult>;
  resultForCommand(command: StoredCommand): Promise<BetCommandResult>;
  settlementFor(playerId: string, bet: BetToPersist): Promise<GameSettlementStatus>;
}

function safeNumber(value: bigint | null): number | null {
  if (value === null) return null;
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) ? numeric : null;
}

/** Reads an owned bet, reconciles it from Crashsim, and persists only forward state. */
export function createGetGameBet(deps: GetGameBetDeps) {
  return async (input: GetGameBetInput): Promise<BetCommandResult | null> => {
    const bet = await deps.loadBet(input.playerId, input.betId);
    if (!bet) return null;

    const unresolvedCashout = await deps.loadUnresolvedCashout(input.playerId, input.betId);
    if (unresolvedCashout) {
      return deps.cashoutInFlight.get(unresolvedCashout.id) ?? deps.reconcileCashout(unresolvedCashout);
    }

    const command = await deps.currentCommand(input.playerId, bet.commandId);
    if (!command || command.status !== 'accepted' || command.commandType !== 'bet') {
      throw new GameCommandError('SERVICE_UNAVAILABLE');
    }

    let current: CrashsimBet;
    try {
      current = await deps.engine.getBet({ betId: bet.betId, playerId: input.playerId, roundId: bet.roundId });
    } catch (error) {
      if (error instanceof CrashsimHttpError && error.kind === 'not_found') {
        if (bet.engineStatus === 'cashed_out') {
          const fallbackSettlement = await deps.settlementFor(input.playerId, {
            betId: bet.betId,
            status: bet.engineStatus,
            multiplierHundredths: safeNumber(bet.multiplierHundredths),
            payoutCents: safeNumber(bet.payoutCents),
            payoutPrecision: bet.settlementStatus === 'precision_incident'
              ? 'unsafe'
              : bet.payoutCents === null ? 'not_provided' : 'safe',
          });
          try {
            await deps.db.update(gameBets)
              .set({ settlementStatus: fallbackSettlement, updatedAt: new Date() })
              .where(and(eq(gameBets.betId, bet.betId), eq(gameBets.playerId, input.playerId)));
          } catch {
            throw new GameCommandError('SERVICE_UNAVAILABLE');
          }
        }
        return deps.resultForCommand(command);
      }
      throw new GameCommandError('SERVICE_UNAVAILABLE');
    }

    if (current.betId !== bet.betId || current.playerId !== input.playerId ||
        current.roundId !== bet.roundId || current.amount !== safeNumber(bet.amountCents) ||
        current.status === 'rejected') {
      throw new GameCommandError('SERVICE_UNAVAILABLE');
    }

    const settlementStatus = await deps.settlementFor(input.playerId, {
      betId: current.betId,
      status: current.status,
      multiplierHundredths: current.multiplierHundredths,
      payoutCents: current.payoutCents,
      payoutPrecision: current.payoutPrecision,
    });
    const payoutCents = current.status === 'cashed_out' ? current.payoutCents : null;
    const multiplierHundredths = current.status === 'cashed_out' ? current.multiplierHundredths : null;
    const refreshableStatuses: GameEngineBetStatus[] = current.status === 'active'
      ? ['active']
      : current.status === 'lost' ? ['active', 'lost'] : ['active', 'cashed_out'];

    try {
      await deps.db.update(gameBets).set({
        engineStatus: current.status,
        multiplierHundredths: multiplierHundredths === null ? null : BigInt(multiplierHundredths),
        payoutCents: payoutCents === null ? null : BigInt(payoutCents),
        settlementStatus,
        updatedAt: new Date(),
      }).where(and(
        eq(gameBets.betId, bet.betId),
        eq(gameBets.playerId, input.playerId),
        inArray(gameBets.engineStatus, refreshableStatuses),
      ));
    } catch {
      throw new GameCommandError('SERVICE_UNAVAILABLE');
    }
    return deps.resultForCommand(command);
  };
}
