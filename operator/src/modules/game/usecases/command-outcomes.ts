import type { BetCommandResult } from '../game.contracts';
import { and, eq, inArray } from 'drizzle-orm';
import type { Logger } from '../../../config';
import type { OperatorDatabase } from '../../../db';
import type { FinancialModule } from '../../financial/financial.module';
import { gameBets, gameCommands, type GameSettlementStatus } from '../game.schema';
import type { BetToPersist } from './place-bet';
import { commandProjection, type StoredCommand } from './command-persistence';

export function safeNumber(value: bigint | null): number | null {
  if (value === null) return null;
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) ? numeric : null;
}

export function unknownResult(command: StoredCommand, resultCode = 'outcome_unknown', betId = command.betId): BetCommandResult {
  return {
    commandId: command.id,
    roundId: command.roundId ?? '',
    amountCents: safeNumber(command.amountCents) ?? 0,
    autoCashoutHundredths: command.autoCashoutHundredths,
    betCommandStatus: 'unknown',
    resultCode,
    betId,
    bet: null,
  };
}

export interface CommandOutcomesDeps {
  db: OperatorDatabase;
  financial: Pick<FinancialModule, 'getCashoutCreditStatus'>;
  logger: Logger;
}

/** Shared projections for committed command outcomes and financial settlement state. */
export function createCommandOutcomes({ db, financial, logger }: CommandOutcomesDeps) {
  async function resultForCashoutCommand(command: StoredCommand): Promise<BetCommandResult> {
    if (!command.betId) return unknownResult(command, 'cashout_bet_missing');
    try {
      const [bet] = await db.select().from(gameBets).where(and(
        eq(gameBets.betId, command.betId), eq(gameBets.playerId, command.playerId),
      )).limit(1);
      if (!bet) return unknownResult(command, 'cashout_bet_missing');
      const amountCents = safeNumber(bet.amountCents);
      if (amountCents === null) return unknownResult(command, 'unsafe_stored_amount');
      return {
        commandId: command.id,
        roundId: bet.roundId,
        amountCents,
        autoCashoutHundredths: bet.autoCashoutHundredths,
        betCommandStatus: command.status,
        resultCode: command.resultCode,
        betId: bet.betId,
        bet: {
          betId: bet.betId,
          engineStatus: bet.engineStatus,
          multiplierHundredths: safeNumber(bet.multiplierHundredths),
          payoutCents: safeNumber(bet.payoutCents),
          settlementStatus: bet.settlementStatus,
        },
      };
    } catch {
      return unknownResult(command, 'storage_unavailable');
    }
  }

  async function resultForCommand(command: StoredCommand): Promise<BetCommandResult> {
    if (command.commandType === 'cashout') return resultForCashoutCommand(command);
    const base = {
      commandId: command.id,
      roundId: command.roundId ?? '',
      amountCents: safeNumber(command.amountCents) ?? 0,
      autoCashoutHundredths: command.autoCashoutHundredths,
      betCommandStatus: command.status,
      resultCode: command.resultCode,
      betId: command.betId,
    };
    if (command.status !== 'accepted' || !command.betId) return { ...base, bet: null };
    try {
      const [bet] = await db.select().from(gameBets).where(and(
        eq(gameBets.betId, command.betId), eq(gameBets.playerId, command.playerId),
      )).limit(1);
      if (!bet) return { ...base, betCommandStatus: 'unknown', resultCode: 'accepted_bet_missing', bet: null };
      if (safeNumber(bet.amountCents) === null) return { ...base, betCommandStatus: 'unknown', resultCode: 'unsafe_stored_amount', bet: null };
      return {
        ...base,
        bet: {
          betId: bet.betId,
          engineStatus: bet.engineStatus,
          multiplierHundredths: safeNumber(bet.multiplierHundredths),
          payoutCents: safeNumber(bet.payoutCents),
          settlementStatus: bet.settlementStatus,
        },
      };
    } catch {
      return unknownResult(command, 'storage_unavailable');
    }
  }

  async function persistUnknown(command: StoredCommand, betId: string | null, resultCode: string): Promise<BetCommandResult> {
    try {
      const persisted = await db.transaction(async (tx) => {
        const [updated] = await tx.update(gameCommands).set({
          status: 'unknown', resultCode, betId, resolvedAt: null, updatedAt: new Date(),
        }).where(and(eq(gameCommands.id, command.id), inArray(gameCommands.status, ['pending', 'unknown'])))
          .returning(commandProjection);
        if (updated) return updated;
        const [latest] = await tx.select(commandProjection).from(gameCommands).where(eq(gameCommands.id, command.id)).for('update');
        return latest;
      });
      if (!persisted) return unknownResult(command, 'storage_unavailable', betId);
      if (persisted.status !== 'unknown') return resultForCommand(persisted);
      logger.warn(persisted.commandType === 'cashout' ? 'game.cashout.unknown' : 'game.bet.unknown', {
        commandId: persisted.id, roundId: persisted.roundId, betId: persisted.betId, reason: persisted.resultCode ?? resultCode,
      });
      return resultForCommand(persisted);
    } catch {
      logger.error(command.commandType === 'cashout' ? 'game.cashout.outcome_persistence_failed' : 'game.bet.outcome_persistence_failed', {
        commandId: command.id, betId, category: 'unknown',
      });
      return unknownResult(command, 'outcome_unknown', betId);
    }
  }

  async function settlementFor(playerId: string, bet: BetToPersist): Promise<GameSettlementStatus> {
    if (bet.status !== 'cashed_out') return 'not_applicable';
    if (bet.payoutPrecision === 'unsafe') {
      logger.error('game.cashout.precision_incident', { betId: bet.betId, category: 'unsafe_payout' });
      return 'precision_incident';
    }
    try {
      const status = await financial.getCashoutCreditStatus({ playerId, betId: bet.betId });
      return status.status === 'credited' ? 'confirmed' : 'pending';
    } catch {
      return 'pending';
    }
  }

  return { resultForCommand, resultForCashoutCommand, persistUnknown, settlementFor };
}
