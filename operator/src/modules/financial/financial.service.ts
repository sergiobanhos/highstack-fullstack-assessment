import { and, desc, eq, gte, lt, or, sql } from 'drizzle-orm';
import type { OperatorDatabase } from '../../db';
import {
  financialOperations,
  walletLedgerEntries,
  wallets,
} from './financial.schema';

const MAX_SAFE_CENTS = 9_007_199_254_740_991n;

export type FinancialOutcome = 'applied' | 'insufficient_funds' | 'balance_limit';
export type FinancialSource = 'engine' | 'reconciliation' | 'test';

export type FinancialErrorCode =
  | 'INVALID_AMOUNT'
  | 'INVALID_IDEMPOTENCY_KEY'
  | 'WALLET_NOT_FOUND'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INVALID_PAGE'
  | 'STORAGE_UNAVAILABLE';

export class FinancialServiceError extends Error {
  constructor(readonly code: FinancialErrorCode) {
    super(code);
    this.name = 'FinancialServiceError';
  }
}

export interface WalletBalance {
  playerId: string;
  balanceCents: bigint;
}

export interface FinancialResult {
  operationId: string;
  outcome: FinancialOutcome;
  balanceCents: bigint;
  replayed: boolean;
}

export interface LedgerCursor {
  /** UTC ISO timestamp with microsecond precision, kept losslessly for keyset paging. */
  createdAt: string;
  id: string;
}

export interface LedgerPageInput {
  limit: number;
  before?: LedgerCursor;
}

export interface LedgerEntry {
  id: string;
  operationId: string;
  direction: 'debit' | 'credit';
  source: FinancialSource;
  amountCents: bigint;
  balanceAfterCents: bigint;
  betId: string | null;
  roundId: string | null;
  createdAt: string;
}

export interface LedgerPage {
  items: LedgerEntry[];
  hasMore: boolean;
}

export interface DebitInput {
  txId: string;
  playerId: string;
  amount: number;
  betId?: string | null;
  roundId?: string | null;
}

export interface CreditCashoutInput {
  playerId: string;
  amount: number;
  betId: string;
  roundId?: string | null;
  source: 'engine' | 'reconciliation';
  txId?: string;
}

export interface TopUpInput {
  playerId: string;
  amount: number;
  idempotencyKey: string;
}

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

interface Reservation {
  id: string;
  existing?: {
    outcome: FinancialOutcome;
    responseBalanceCents: bigint;
  };
}

function amountInCents(amount: number): bigint {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new FinancialServiceError('INVALID_AMOUNT');
  }
  return BigInt(amount);
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

function sameCashoutSource(existing: FinancialSource, incoming: FinancialSource): boolean {
  return existing === incoming ||
    (existing !== 'test' && incoming !== 'test');
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

export interface FinancialService {
  /** Provision only from auth.requireUser or another trusted internal identity. */
  ensureWallet(playerId: string): Promise<WalletBalance>;
  getBalance(playerId: string): Promise<WalletBalance>;
  listEntries(playerId: string, page: LedgerPageInput): Promise<LedgerPage>;
  debit(input: DebitInput): Promise<FinancialResult>;
  creditCashoutOnce(input: CreditCashoutInput): Promise<FinancialResult>;
  topUp(input: TopUpInput): Promise<FinancialResult>;
}

/**
 * Persistent wallet operations. Every mutation reserves its idempotency key,
 * updates the wallet, stores the result, and appends its ledger row in one DB
 * transaction; only applied movements create ledger entries.
 */
export function createFinancialService({ db }: { db: OperatorDatabase }): FinancialService {
  async function withStorageErrors<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      throw asFinancialError(error);
    }
  }

  async function reserveOperation(tx: Parameters<Parameters<OperatorDatabase['transaction']>[0]>[0], input: OperationInput): Promise<Reservation> {
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

  async function readWalletForUpdate(
    tx: Parameters<Parameters<OperatorDatabase['transaction']>[0]>[0],
    playerId: string,
  ): Promise<WalletBalance> {
    const [wallet] = await tx
      .select({ playerId: wallets.playerId, balanceCents: wallets.balanceCents })
      .from(wallets)
      .where(eq(wallets.playerId, playerId))
      .for('update');
    if (!wallet) throw new FinancialServiceError('WALLET_NOT_FOUND');
    return wallet;
  }

  async function applyOperation(input: OperationInput): Promise<FinancialResult> {
    return withStorageErrors(() => db.transaction(async (tx) => {
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
          .set({
            balanceCents: sql`${wallets.balanceCents} + ${delta}`,
            updatedAt: new Date(),
          })
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

      return {
        operationId: reservation.id,
        outcome,
        balanceCents: responseBalanceCents,
        replayed: false,
      };
    }));
  }

  return {
    ensureWallet(playerId) {
      return withStorageErrors(async () => {
        const [created] = await db
          .insert(wallets)
          .values({ playerId })
          .onConflictDoNothing()
          .returning({ playerId: wallets.playerId, balanceCents: wallets.balanceCents });
        if (created) return created;
        const [existing] = await db
          .select({ playerId: wallets.playerId, balanceCents: wallets.balanceCents })
          .from(wallets)
          .where(eq(wallets.playerId, playerId));
        if (!existing) throw new FinancialServiceError('STORAGE_UNAVAILABLE');
        return existing;
      });
    },

    getBalance(playerId) {
      return withStorageErrors(async () => {
        const [wallet] = await db
          .select({ playerId: wallets.playerId, balanceCents: wallets.balanceCents })
          .from(wallets)
          .where(eq(wallets.playerId, playerId));
        if (!wallet) throw new FinancialServiceError('WALLET_NOT_FOUND');
        return wallet;
      });
    },

    listEntries(playerId, page) {
      if (!Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > 100) {
        return Promise.reject(new FinancialServiceError('INVALID_PAGE'));
      }
      return withStorageErrors(async () => {
        const cursorTimestamp = page.before
          ? sql`${page.before.createdAt}::timestamptz`
          : undefined;
        const cursorCondition = page.before
          ? or(
              sql`${walletLedgerEntries.createdAt} < ${cursorTimestamp}`,
              and(
                eq(walletLedgerEntries.createdAt, cursorTimestamp!),
                lt(walletLedgerEntries.id, page.before.id),
              ),
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
    },

    async debit(input) {
      const amountCents = amountInCents(input.amount);
      if (!input.txId) throw new FinancialServiceError('INVALID_IDEMPOTENCY_KEY');
      return applyOperation({
        playerId: input.playerId,
        kind: 'debit',
        source: 'engine',
        amountCents,
        engineTxId: input.txId,
        businessKey: null,
        betId: input.betId ?? null,
        roundId: input.roundId ?? null,
      });
    },

    async creditCashoutOnce(input) {
      const amountCents = amountInCents(input.amount);
      if (!input.betId) throw new FinancialServiceError('INVALID_IDEMPOTENCY_KEY');
      if (input.source === 'engine' && !input.txId) {
        throw new FinancialServiceError('INVALID_IDEMPOTENCY_KEY');
      }
      return applyOperation({
        playerId: input.playerId,
        kind: 'credit',
        source: input.source,
        amountCents,
        engineTxId: input.txId ?? null,
        businessKey: `cashout:${input.betId}`,
        betId: input.betId,
        roundId: input.roundId ?? null,
      });
    },

    async topUp(input) {
      const amountCents = amountInCents(input.amount);
      if (!input.idempotencyKey) throw new FinancialServiceError('INVALID_IDEMPOTENCY_KEY');
      return applyOperation({
        playerId: input.playerId,
        kind: 'test_top_up',
        source: 'test',
        amountCents,
        engineTxId: null,
        businessKey: `top-up:${input.playerId}:${input.idempotencyKey}`,
        betId: null,
        roundId: null,
      });
    },
  };
}
