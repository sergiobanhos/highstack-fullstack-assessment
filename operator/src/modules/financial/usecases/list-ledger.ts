import { and, desc, eq, lt, or, sql } from 'drizzle-orm';
import type { OperatorDatabase } from '../../../db';
import { walletLedgerEntries } from '../financial.schema';
import { FinancialServiceError, type FinancialSource, type LedgerEntry, type LedgerPage, type LedgerPageInput } from '../financial.contracts';
import { withFinancialStorageErrors } from './operation-transaction';

export function createListLedger({ db }: { db: OperatorDatabase }) {
  return (playerId: string, page: LedgerPageInput): Promise<LedgerPage> => {
    if (!Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > 100) {
      return Promise.reject(new FinancialServiceError('INVALID_PAGE'));
    }
    return withFinancialStorageErrors(async () => {
      const cursorTimestamp = page.before ? sql`${page.before.createdAt}::timestamptz` : undefined;
      const cursorCondition = page.before
        ? or(
            sql`${walletLedgerEntries.createdAt} < ${cursorTimestamp}`,
            and(eq(walletLedgerEntries.createdAt, cursorTimestamp!), lt(walletLedgerEntries.id, page.before.id)),
          )
        : undefined;
      const rows = await db
        .select({
          id: walletLedgerEntries.id,
          operationId: walletLedgerEntries.operationId,
          direction: walletLedgerEntries.direction,
          source: walletLedgerEntries.source,
          amountCents: walletLedgerEntries.amountCents,
          balanceAfterCents: walletLedgerEntries.balanceAfterCents,
          betId: walletLedgerEntries.betId,
          roundId: walletLedgerEntries.roundId,
          createdAt: sql<string>`to_char(${walletLedgerEntries.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        })
        .from(walletLedgerEntries)
        .where(cursorCondition
          ? and(eq(walletLedgerEntries.playerId, playerId), cursorCondition)
          : eq(walletLedgerEntries.playerId, playerId))
        .orderBy(desc(walletLedgerEntries.createdAt), desc(walletLedgerEntries.id))
        .limit(page.limit + 1);

      return {
        items: rows.slice(0, page.limit).map((row) => ({
          ...row,
          direction: row.direction as LedgerEntry['direction'],
          source: row.source as FinancialSource,
        })),
        hasMore: rows.length > page.limit,
      };
    });
  };
}
