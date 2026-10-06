import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { OperatorDatabase } from '../../../db';
import { financialOperations } from '../financial.schema';
import { FinancialServiceError, type BetDebitCandidate, type BetDebitLookupInput } from '../financial.contracts';
import { withFinancialStorageErrors } from './operation-transaction';

export function createFindBetDebit({ db }: { db: OperatorDatabase }) {
  return (input: BetDebitLookupInput): Promise<BetDebitCandidate[]> => {
    if (!input.playerId || !input.roundId || !Number.isSafeInteger(input.amount) || input.amount <= 0 ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(input.createdAt) ||
        Number.isNaN(Date.parse(input.createdAt))) {
      return Promise.reject(new FinancialServiceError('INVALID_LOOKUP'));
    }
    const amountCents = BigInt(input.amount);
    return withFinancialStorageErrors(async () => {
      const rows = await db
        .select({ betId: financialOperations.betId, outcome: financialOperations.outcome })
        .from(financialOperations)
        .where(and(
          eq(financialOperations.playerId, input.playerId),
          eq(financialOperations.kind, 'debit'),
          eq(financialOperations.source, 'engine'),
          eq(financialOperations.roundId, input.roundId),
          eq(financialOperations.amountCents, amountCents),
          inArray(financialOperations.outcome, ['applied', 'insufficient_funds']),
          isNotNull(financialOperations.betId),
          sql`${financialOperations.createdAt} > ${input.createdAt}::timestamptz`,
        ))
        .orderBy(asc(financialOperations.createdAt), asc(financialOperations.id));
      return rows.map((row) => ({
        betId: row.betId!,
        outcome: row.outcome as BetDebitCandidate['outcome'],
      }));
    });
  };
}
