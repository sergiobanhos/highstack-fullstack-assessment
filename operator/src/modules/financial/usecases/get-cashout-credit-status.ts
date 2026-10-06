import { and, eq } from 'drizzle-orm';
import type { OperatorDatabase } from '../../../db';
import { financialOperations, walletLedgerEntries } from '../financial.schema';
import { FinancialServiceError, type CashoutCreditStatus } from '../financial.contracts';
import { withFinancialStorageErrors } from './operation-transaction';

export function createGetCashoutCreditStatus({ db }: { db: OperatorDatabase }) {
  return ({ playerId, betId }: { playerId: string; betId: string }): Promise<CashoutCreditStatus> => {
    if (!playerId || !betId) return Promise.reject(new FinancialServiceError('INVALID_LOOKUP'));
    return withFinancialStorageErrors(async () => {
      const [operation] = await db
        .select({ id: financialOperations.id, outcome: financialOperations.outcome, source: financialOperations.source })
        .from(financialOperations)
        .where(and(
          eq(financialOperations.playerId, playerId),
          eq(financialOperations.kind, 'credit'),
          eq(financialOperations.businessKey, `cashout:${betId}`),
          eq(financialOperations.betId, betId),
        ))
        .limit(1);

      if (!operation) return { status: 'pending' };
      if (operation.outcome === 'balance_limit') return { status: 'incident', reason: 'balance_limit' };
      if (operation.outcome !== 'applied') return { status: 'incident', reason: 'unexpected_outcome' };

      const [entry] = await db
        .select({ id: walletLedgerEntries.id })
        .from(walletLedgerEntries)
        .where(and(
          eq(walletLedgerEntries.operationId, operation.id),
          eq(walletLedgerEntries.playerId, playerId),
          eq(walletLedgerEntries.direction, 'credit'),
          eq(walletLedgerEntries.source, operation.source),
          eq(walletLedgerEntries.betId, betId),
        ))
        .limit(1);
      return entry ? { status: 'credited' } : { status: 'incident', reason: 'ledger_missing' };
    });
  };
}
