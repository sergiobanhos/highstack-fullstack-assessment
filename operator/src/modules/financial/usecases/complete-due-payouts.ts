import { and, eq, lte, sql } from 'drizzle-orm';
import type { OperatorDatabase } from '../../../db';
import { payouts } from '../financial.schema';
import { withFinancialStorageErrors } from './operation-transaction';

export function createCompleteDuePayouts({ db }: { db: OperatorDatabase }) {
  return (): Promise<string[]> => withFinancialStorageErrors(async () => {
    const completed = await db
      .update(payouts)
      .set({ status: 'done', completedAt: sql<Date>`now()` })
      .where(and(eq(payouts.status, 'processing'), lte(payouts.completeAfter, sql`now()`)))
      .returning({ id: payouts.id });
    return completed.map(({ id }) => id);
  });
}
