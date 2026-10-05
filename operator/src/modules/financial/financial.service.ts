import { and, asc, desc, eq, gte, inArray, isNotNull, lt, or, sql } from 'drizzle-orm';
import type { OperatorDatabase } from '../../db';
import {
  financialOperations,
  payouts,
  walletLedgerEntries,
  wallets,
} from './financial.schema';

const MAX_SAFE_CENTS = 9_007_199_254_740_991n;

export type FinancialOutcome = 'applied' | 'insufficient_funds' | 'balance_limit';
export type FinancialSource = 'engine' | 'reconciliation' | 'test' | 'payout';

export type FinancialErrorCode =
  | 'INVALID_AMOUNT'
  | 'INVALID_IDEMPOTENCY_KEY'
  | 'WALLET_NOT_FOUND'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INVALID_PAGE'
  | 'INVALID_LOOKUP'
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

export interface PayoutRequestInput {
  playerId: string;
  amount: number;
  idempotencyKey: string;
}

export interface PayoutRecord {
  id: string;
  amountCents: bigint;
  status: 'processing' | 'done';
  requestedAt: string;
  completedAt: string | null;
}

export interface PayoutCursor {
  /** UTC ISO timestamp with microsecond precision, kept losslessly for keyset paging. */
  requestedAt: string;
  id: string;
}

export interface PayoutPageInput {
  limit: number;
  before?: PayoutCursor;
}

export interface PayoutPage {
  items: PayoutRecord[];
  hasMore: boolean;
}

export interface PayoutRequestResult extends FinancialResult {
  payout: PayoutRecord | null;
}

/** Timestamp returned by the command reservation query, in UTC with microseconds. */
export interface BetDebitLookupInput {
  playerId: string;
  roundId: string;
  amount: number;
  createdAt: string;
}

export interface BetDebitCandidate {
  betId: string;
  outcome: 'applied' | 'insufficient_funds';
}

export type CashoutCreditStatus =
  | { status: 'credited' }
  | { status: 'pending' }
  | { status: 'incident'; reason: 'balance_limit' | 'ledger_missing' | 'unexpected_outcome' };

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

const payoutProjection = {
  id: payouts.id,
  amountCents: financialOperations.amountCents,
  status: payouts.status,
  requestedAt: sql<string>`to_char(${financialOperations.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
  completedAt: sql<string | null>`CASE WHEN ${payouts.completedAt} IS NULL THEN NULL ELSE to_char(${payouts.completedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END`,
};

function payoutRecord(row: {
  id: string;
  amountCents: bigint;
  status: string;
  requestedAt: string;
  completedAt: string | null;
}): PayoutRecord {
  return { ...row, status: row.status as PayoutRecord['status'] };
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

export interface FinancialService {
  /** Provision only from auth.requireUser or another trusted internal identity. */
  ensureWallet(playerId: string): Promise<WalletBalance>;
  getBalance(playerId: string): Promise<WalletBalance>;
  listEntries(playerId: string, page: LedgerPageInput): Promise<LedgerPage>;
  debit(input: DebitInput): Promise<FinancialResult>;
  creditCashoutOnce(input: CreditCashoutInput): Promise<FinancialResult>;
  findBetDebitForCommand(input: BetDebitLookupInput): Promise<BetDebitCandidate[]>;
  getCashoutCreditStatus(input: { playerId: string; betId: string }): Promise<CashoutCreditStatus>;
  topUp(input: TopUpInput): Promise<FinancialResult>;
  requestPayout(input: PayoutRequestInput): Promise<PayoutRequestResult>;
  getPayout(input: { playerId: string; payoutId: string }): Promise<PayoutRecord | null>;
  listPayouts(playerId: string, page: PayoutPageInput): Promise<PayoutPage>;
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

  async function applyOperation(
    input: OperationInput,
    onApplied?: AppliedOperationEffect,
  ): Promise<FinancialResult> {
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

      if (outcome === 'applied' && onApplied) {
        await onApplied(tx, reservation.id);
      }

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

    findBetDebitForCommand(input): Promise<BetDebitCandidate[]> {
      if (!input.playerId || !input.roundId || !Number.isSafeInteger(input.amount) || input.amount <= 0 ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(input.createdAt) ||
          Number.isNaN(Date.parse(input.createdAt))) {
        return Promise.reject(new FinancialServiceError('INVALID_LOOKUP'));
      }
      const amountCents = BigInt(input.amount);
      return withStorageErrors(async () => {
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
    },

    getCashoutCreditStatus({ playerId, betId }): Promise<CashoutCreditStatus> {
      if (!playerId || !betId) {
        return Promise.reject(new FinancialServiceError('INVALID_LOOKUP'));
      }
      return withStorageErrors(async () => {
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
        if (operation.outcome === 'balance_limit') {
          return { status: 'incident', reason: 'balance_limit' };
        }
        if (operation.outcome !== 'applied') {
          return { status: 'incident', reason: 'unexpected_outcome' };
        }

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

    async requestPayout(input) {
      const amountCents = amountInCents(input.amount);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.idempotencyKey)) {
        throw new FinancialServiceError('INVALID_IDEMPOTENCY_KEY');
      }

      const result = await applyOperation({
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

      return withStorageErrors(async () => {
        const [row] = await db
          .select(payoutProjection)
          .from(payouts)
          .innerJoin(financialOperations, eq(payouts.id, financialOperations.id))
          .where(and(eq(payouts.id, result.operationId), eq(financialOperations.playerId, input.playerId)))
          .limit(1);
        if (!row) throw new FinancialServiceError('STORAGE_UNAVAILABLE');
        return { ...result, payout: payoutRecord(row) };
      });
    },

    getPayout({ playerId, payoutId }) {
      if (!playerId || !payoutId) {
        return Promise.reject(new FinancialServiceError('INVALID_LOOKUP'));
      }
      return withStorageErrors(async () => {
        const [row] = await db
          .select(payoutProjection)
          .from(payouts)
          .innerJoin(financialOperations, eq(payouts.id, financialOperations.id))
          .where(and(eq(payouts.id, payoutId), eq(financialOperations.playerId, playerId)))
          .limit(1);
        return row ? payoutRecord(row) : null;
      });
    },

    listPayouts(playerId, page) {
      if (!playerId || !Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > 100) {
        return Promise.reject(new FinancialServiceError('INVALID_PAGE'));
      }
      if (page.before && (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(page.before.id) ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(page.before.requestedAt) ||
        Number.isNaN(Date.parse(page.before.requestedAt))
      )) {
        return Promise.reject(new FinancialServiceError('INVALID_PAGE'));
      }
      return withStorageErrors(async () => {
        const cursorTimestamp = page.before
          ? sql`${page.before.requestedAt}::timestamptz`
          : undefined;
        const cursorCondition = page.before
          ? or(
              lt(financialOperations.createdAt, cursorTimestamp!),
              and(
                eq(financialOperations.createdAt, cursorTimestamp!),
                lt(payouts.id, page.before.id),
              ),
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
    },
  };
}
