import type { OperatorDatabase } from '../../../db';
import { FinancialServiceError, type DebitInput, type FinancialResult } from '../financial.contracts';
import { amountInCents, applyFinancialOperation } from './operation-transaction';

export function createApplyDebit({ db }: { db: OperatorDatabase }) {
  return async (input: DebitInput): Promise<FinancialResult> => {
    const amountCents = amountInCents(input.amount);
    if (!input.txId) throw new FinancialServiceError('INVALID_IDEMPOTENCY_KEY');
    return applyFinancialOperation(db, {
      playerId: input.playerId,
      kind: 'debit',
      source: 'engine',
      amountCents,
      engineTxId: input.txId,
      businessKey: null,
      betId: input.betId ?? null,
      roundId: input.roundId ?? null,
    });
  };
}
