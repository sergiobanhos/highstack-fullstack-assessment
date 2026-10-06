import { and, eq, sql } from 'drizzle-orm';
import type { OperatorDatabase } from '../../../db';
import { financialOperations, payouts } from '../financial.schema';
import { FinancialServiceError, type PayoutRequestInput, type PayoutRequestResult } from '../financial.contracts';
import { amountInCents, applyFinancialOperation, withFinancialStorageErrors } from './operation-transaction';
import { payoutProjection, payoutRecord } from './payout-record';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createRequestPayout({ db }: { db: OperatorDatabase }) {
  return async (input: PayoutRequestInput): Promise<PayoutRequestResult> => {
    const amountCents = amountInCents(input.amount);
    if (!UUID_PATTERN.test(input.idempotencyKey)) {
      throw new FinancialServiceError('INVALID_IDEMPOTENCY_KEY');
    }

    const result = await applyFinancialOperation(db, {
      playerId: input.playerId,
      kind: 'debit',
      source: 'payout',
      amountCents,
      engineTxId: null,
      businessKey: `payout:${input.playerId}:${input.idempotencyKey}`,
      betId: null,
      roundId: null,
    }, async (tx, operationId) => {
      await tx.insert(payouts).values({
        id: operationId,
        status: 'processing',
        completeAfter: sql<Date>`now() + interval '5 seconds'`,
      });
    });

    if (result.outcome !== 'applied') return { ...result, payout: null };
    return withFinancialStorageErrors(async () => {
      const [row] = await db
        .select(payoutProjection)
        .from(payouts)
        .innerJoin(financialOperations, eq(payouts.id, financialOperations.id))
        .where(and(eq(payouts.id, result.operationId), eq(financialOperations.playerId, input.playerId)))
        .limit(1);
      if (!row) throw new FinancialServiceError('STORAGE_UNAVAILABLE');
      return { ...result, payout: payoutRecord(row) };
    });
  };
}
