import { and, desc, eq, lt, or, sql } from 'drizzle-orm';
import type { OperatorDatabase } from '../../../db';
import { financialOperations, payouts } from '../financial.schema';
import { FinancialServiceError, type PayoutCursor, type PayoutPage, type PayoutPageInput } from '../financial.contracts';
import { withFinancialStorageErrors } from './operation-transaction';
import { payoutProjection, payoutRecord } from './payout-record';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MICROSECOND_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

function validCursor(cursor: PayoutCursor): boolean {
  return UUID_PATTERN.test(cursor.id) && MICROSECOND_TIMESTAMP.test(cursor.requestedAt) &&
    !Number.isNaN(Date.parse(cursor.requestedAt));
}

export function createListPayouts({ db }: { db: OperatorDatabase }) {
  return (playerId: string, page: PayoutPageInput): Promise<PayoutPage> => {
    if (!playerId || !Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > 100) {
      return Promise.reject(new FinancialServiceError('INVALID_PAGE'));
    }
    if (page.before && !validCursor(page.before)) {
      return Promise.reject(new FinancialServiceError('INVALID_PAGE'));
    }
    return withFinancialStorageErrors(async () => {
      const cursorTimestamp = page.before ? sql`${page.before.requestedAt}::timestamptz` : undefined;
      const cursorCondition = page.before
        ? or(
            lt(financialOperations.createdAt, cursorTimestamp!),
            and(eq(financialOperations.createdAt, cursorTimestamp!), lt(payouts.id, page.before.id)),
          )
        : undefined;
      const rows = await db
        .select(payoutProjection)
        .from(payouts)
        .innerJoin(financialOperations, eq(payouts.id, financialOperations.id))
        .where(cursorCondition
          ? and(eq(financialOperations.playerId, playerId), cursorCondition)
          : eq(financialOperations.playerId, playerId))
        .orderBy(desc(financialOperations.createdAt), desc(payouts.id))
        .limit(page.limit + 1);
      return {
        items: rows.slice(0, page.limit).map(payoutRecord),
        hasMore: rows.length > page.limit,
      };
    });
  };
}
