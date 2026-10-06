import type { OperatorDatabase } from '../../../db';
import { FinancialServiceError, type CreditCashoutInput, type FinancialResult } from '../financial.contracts';
import { amountInCents, applyFinancialOperation } from './operation-transaction';

export function createCreditCashout({ db }: { db: OperatorDatabase }) {
  return async (input: CreditCashoutInput): Promise<FinancialResult> => {
    const amountCents = amountInCents(input.amount);
    if (!input.betId || (input.source === 'engine' && !input.txId)) {
      throw new FinancialServiceError('INVALID_IDEMPOTENCY_KEY');
    }
    return applyFinancialOperation(db, {
      playerId: input.playerId,
      kind: 'credit',
      source: input.source,
      amountCents,
      engineTxId: input.txId ?? null,
      businessKey: `cashout:${input.betId}`,
      betId: input.betId,
      roundId: input.roundId ?? null,
    });
  };
}
