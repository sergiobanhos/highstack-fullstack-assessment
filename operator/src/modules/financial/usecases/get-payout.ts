import { and, eq } from 'drizzle-orm';
import type { OperatorDatabase } from '../../../db';
import { financialOperations, payouts } from '../financial.schema';
import { FinancialServiceError, type PayoutRecord } from '../financial.contracts';
import { withFinancialStorageErrors } from './operation-transaction';
import { payoutProjection, payoutRecord } from './payout-record';

export function createGetPayout({ db }: { db: OperatorDatabase }) {
  return ({ playerId, payoutId }: { playerId: string; payoutId: string }): Promise<PayoutRecord | null> => {
    if (!playerId || !payoutId) return Promise.reject(new FinancialServiceError('INVALID_LOOKUP'));
    return withFinancialStorageErrors(async () => {
      const [row] = await db
        .select(payoutProjection)
        .from(payouts)
        .innerJoin(financialOperations, eq(payouts.id, financialOperations.id))
        .where(and(eq(payouts.id, payoutId), eq(financialOperations.playerId, playerId)))
        .limit(1);
      return row ? payoutRecord(row) : null;
    });
  };
}
