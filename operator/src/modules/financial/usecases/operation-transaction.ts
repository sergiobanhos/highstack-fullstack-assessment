import { and, eq, gte, or, sql } from 'drizzle-orm';
import type { OperatorDatabase } from '../../../db';
import { financialOperations, walletLedgerEntries, wallets } from '../financial.schema';
import {
  FinancialServiceError,
  type FinancialOutcome,
  type FinancialResult,
  type FinancialSource,
} from '../financial.contracts';

const MAX_SAFE_CENTS = 9_007_199_254_740_991n;

interface OperationInput {
  playerId: string;
  kind: 'debit' | 'credit' | 'test_top_up';
  source: FinancialSource;
  amountCents: bigint;
  engineTxId: string | null;
  businessKey: string | null;
  betId: string | null;
  roundId: string | null;
}

type FinancialTransaction = Parameters<Parameters<OperatorDatabase['transaction']>[0]>[0];
type AppliedOperationEffect = (tx: FinancialTransaction, operationId: string) => Promise<void>;

interface Reservation {
  id: string;
  existing?: { outcome: FinancialOutcome; responseBalanceCents: bigint };
}

function sameCashoutSource(existing: FinancialSource, incoming: FinancialSource): boolean {
  const isCashoutSource = (source: FinancialSource): source is 'engine' | 'reconciliation' =>
    source === 'engine' || source === 'reconciliation';
  return existing === incoming || (isCashoutSource(existing) && isCashoutSource(incoming));
}

function matchesOperation(
  existing: typeof financialOperations.$inferSelect,
  input: OperationInput,
): boolean {
  return existing.playerId === input.playerId &&
    existing.kind === input.kind &&
    existing.amountCents === input.amountCents &&
    existing.betId === input.betId &&
    existing.roundId === input.roundId &&
    sameCashoutSource(existing.source as FinancialSource, input.source) &&
    (input.engineTxId === null || existing.engineTxId === null || existing.engineTxId === input.engineTxId) &&
    (existing.businessKey === null || existing.businessKey === input.businessKey);
}

function asFinancialError(error: unknown): FinancialServiceError {
  if (error instanceof FinancialServiceError) return error;
  if (error !== null && typeof error === 'object' && 'code' in error) {
    const postgresError = error as { code?: unknown; constraint_name?: unknown };
    const idempotencyIndex = postgresError.constraint_name === 'financial_operations_engine_tx_id_unique' ||
      postgresError.constraint_name === 'financial_operations_business_key_unique';
    if (postgresError.code === '23505' && idempotencyIndex) {
      return new FinancialServiceError('IDEMPOTENCY_CONFLICT');
    }
  }
  return new FinancialServiceError('STORAGE_UNAVAILABLE');
}

export async function withFinancialStorageErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw asFinancialError(error);
  }
}

export function amountInCents(amount: number): bigint {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new FinancialServiceError('INVALID_AMOUNT');
  }
  return BigInt(amount);
}

async function reserveOperation(
  tx: FinancialTransaction,
  input: OperationInput,
): Promise<Reservation> {
  const [inserted] = await tx
    .insert(financialOperations)
    .values({
      playerId: input.playerId,
      kind: input.kind,
      source: input.source,
      amountCents: input.amountCents,
      engineTxId: input.engineTxId,
      businessKey: input.businessKey,
      betId: input.betId,
      roundId: input.roundId,
      outcome: 'applied',
      responseBalanceCents: 0n,
    })
    .onConflictDoNothing()
    .returning({ id: financialOperations.id });

  if (inserted) return { id: inserted.id };

  const selectors = [];
  if (input.engineTxId !== null) selectors.push(eq(financialOperations.engineTxId, input.engineTxId));
  if (input.businessKey !== null) selectors.push(eq(financialOperations.businessKey, input.businessKey));
  if (selectors.length === 0) throw new FinancialServiceError('IDEMPOTENCY_CONFLICT');

  const matches = await tx
    .select()
    .from(financialOperations)
    .where(or(...selectors))
    .for('update');

  if (matches.length !== 1 || !matchesOperation(matches[0]!, input)) {
    throw new FinancialServiceError('IDEMPOTENCY_CONFLICT');
  }

  const existing = matches[0]!;
  if (input.engineTxId !== null && existing.engineTxId === null) {
    const [associated] = await tx
      .update(financialOperations)
      .set({ engineTxId: input.engineTxId })
      .where(eq(financialOperations.id, existing.id))
      .returning({ id: financialOperations.id });
    if (!associated) throw new FinancialServiceError('STORAGE_UNAVAILABLE');
  }

  return {
    id: existing.id,
    existing: {
      outcome: existing.outcome as FinancialOutcome,
      responseBalanceCents: existing.responseBalanceCents,
    },
  };
}

async function readWalletForUpdate(tx: FinancialTransaction, playerId: string) {
  const [wallet] = await tx
    .select({ playerId: wallets.playerId, balanceCents: wallets.balanceCents })
    .from(wallets)
    .where(eq(wallets.playerId, playerId))
    .for('update');
  if (!wallet) throw new FinancialServiceError('WALLET_NOT_FOUND');
  return wallet;
}

/** Shared atomic transaction for ledger movements, payout debit, and test top-up. */
export async function applyFinancialOperation(
  db: OperatorDatabase,
  input: OperationInput,
  onApplied?: AppliedOperationEffect,
): Promise<FinancialResult> {
  return withFinancialStorageErrors(() => db.transaction(async (tx) => {
    const wallet = await readWalletForUpdate(tx, input.playerId);
    const reservation = await reserveOperation(tx, input);
    if (reservation.existing) {
      return {
        operationId: reservation.id,
        outcome: reservation.existing.outcome,
        balanceCents: reservation.existing.responseBalanceCents,
        replayed: true,
      };
    }

    let outcome: FinancialOutcome = 'applied';
    let responseBalanceCents = wallet.balanceCents;
    const isDebit = input.kind === 'debit';
    const exceedsSafeBalance = !isDebit && wallet.balanceCents > MAX_SAFE_CENTS - input.amountCents;

    if (isDebit && wallet.balanceCents < input.amountCents) {
      outcome = 'insufficient_funds';
    } else if (exceedsSafeBalance) {
      outcome = 'balance_limit';
    } else {
      const delta = isDebit ? -input.amountCents : input.amountCents;
      const predicate = isDebit
        ? and(eq(wallets.playerId, input.playerId), gte(wallets.balanceCents, input.amountCents))
        : and(
            eq(wallets.playerId, input.playerId),
            sql`${wallets.balanceCents} <= ${MAX_SAFE_CENTS - input.amountCents}`,
          );
      const [updated] = await tx
        .update(wallets)
        .set({ balanceCents: sql`${wallets.balanceCents} + ${delta}`, updatedAt: new Date() })
        .where(predicate)
        .returning({ balanceCents: wallets.balanceCents });
      if (!updated) throw new FinancialServiceError('STORAGE_UNAVAILABLE');
      responseBalanceCents = updated.balanceCents;

      await tx.insert(walletLedgerEntries).values({
        operationId: reservation.id,
        playerId: input.playerId,
        direction: isDebit ? 'debit' : 'credit',
        source: input.source,
        amountCents: input.amountCents,
        balanceAfterCents: responseBalanceCents,
        betId: input.betId,
        roundId: input.roundId,
      });
    }

    await tx
      .update(financialOperations)
      .set({ outcome, responseBalanceCents })
      .where(eq(financialOperations.id, reservation.id));

    if (outcome === 'applied' && onApplied) await onApplied(tx, reservation.id);

    return { operationId: reservation.id, outcome, balanceCents: responseBalanceCents, replayed: false };
  }));
}
