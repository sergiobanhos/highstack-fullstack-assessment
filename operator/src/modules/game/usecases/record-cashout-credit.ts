import type { RecordCashoutCreditInput } from '../game.contracts';
import { and, eq, inArray, ne } from 'drizzle-orm';
import type { Logger } from '../../../config';
import type { OperatorDatabase } from '../../../db';
import { gameBets } from '../game.schema';
import { GameCommandError } from '../game.errors';

export interface RecordCashoutCreditDeps {
  db: OperatorDatabase;
  logger: Logger;
}

/** Marks a bet settled after financial has committed the idempotent credit. */
export function createRecordCashoutCredit({ db, logger }: RecordCashoutCreditDeps) {
  return async (input: RecordCashoutCreditInput): Promise<'applied' | 'ignored'> => {
    let updated: { betId: string }[];
    try {
      updated = await db
        .update(gameBets)
        .set({
          engineStatus: 'cashed_out',
          payoutCents: BigInt(input.payoutCents),
          settlementStatus: 'confirmed',
          updatedAt: new Date(),
        })
        .where(and(
          eq(gameBets.betId, input.betId),
          eq(gameBets.playerId, input.playerId),
          inArray(gameBets.engineStatus, ['active', 'cashed_out']),
          ne(gameBets.settlementStatus, 'confirmed'),
        ))
        .returning({ betId: gameBets.betId });
    } catch {
      throw new GameCommandError('SERVICE_UNAVAILABLE');
    }

    if (updated.length === 0) {
      logger.info('game.bet.credit_recorded', { betId: input.betId, roundId: input.roundId, outcome: 'already_settled' });
      return 'ignored';
    }
    logger.info('game.bet.credit_recorded', {
      betId: input.betId,
      roundId: input.roundId,
      outcome: 'applied',
      payoutCents: input.payoutCents,
    });
    return 'applied';
  };
}
