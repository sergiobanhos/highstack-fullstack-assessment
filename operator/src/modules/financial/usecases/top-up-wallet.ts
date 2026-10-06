import type { OperatorDatabase } from '../../../db';
import { FinancialServiceError, type FinancialResult, type TopUpInput } from '../financial.contracts';
import { amountInCents, applyFinancialOperation } from './operation-transaction';

export function createTopUpWallet({ db }: { db: OperatorDatabase }) {
  return async (input: TopUpInput): Promise<FinancialResult> => {
    const amountCents = amountInCents(input.amount);
    if (!input.idempotencyKey) throw new FinancialServiceError('INVALID_IDEMPOTENCY_KEY');
    return applyFinancialOperation(db, {
      playerId: input.playerId,
      kind: 'test_top_up',
      source: 'test',
      amountCents,
      engineTxId: null,
      businessKey: `top-up:${input.playerId}:${input.idempotencyKey}`,
      betId: null,
      roundId: null,
    });
  };
}
