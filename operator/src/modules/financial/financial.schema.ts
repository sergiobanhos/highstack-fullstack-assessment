import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

const MAX_SAFE_CENTS = 9_007_199_254_740_991;
const MAX_SAFE_CENTS_SQL = sql.raw(String(MAX_SAFE_CENTS));

/** One USD wallet per stable player ID. Auth tables remain private to auth. */
export const wallets = pgTable(
  'wallets',
  {
    playerId: uuid('player_id').primaryKey(),
    balanceCents: bigint('balance_cents', { mode: 'bigint' }).notNull().default(sql`0`),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'wallets_balance_cents_range',
      sql`${table.balanceCents} BETWEEN 0 AND ${MAX_SAFE_CENTS_SQL}`,
    ),
  ],
);

export const financialOperations = pgTable(
  'financial_operations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    playerId: uuid('player_id')
      .notNull()
      .references(() => wallets.playerId),
    kind: varchar('kind', { length: 32 }).notNull(),
    source: varchar('source', { length: 24 }).notNull(),
    amountCents: bigint('amount_cents', { mode: 'bigint' }).notNull(),
    engineTxId: varchar('engine_tx_id', { length: 255 }),
    businessKey: varchar('business_key', { length: 512 }),
    betId: varchar('bet_id', { length: 255 }),
    roundId: varchar('round_id', { length: 255 }),
    outcome: varchar('outcome', { length: 32 }).notNull(),
    responseBalanceCents: bigint('response_balance_cents', { mode: 'bigint' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'financial_operations_kind_check',
      sql`${table.kind} IN ('debit', 'credit', 'test_top_up')`,
    ),
    check(
      'financial_operations_source_check',
      sql`${table.source} IN ('engine', 'reconciliation', 'test', 'payout')`,
    ),
    check(
      'financial_operations_kind_source_check',
      sql`(${table.source} = 'engine' AND ${table.kind} IN ('debit', 'credit')) OR (${table.source} = 'reconciliation' AND ${table.kind} = 'credit') OR (${table.source} = 'test' AND ${table.kind} = 'test_top_up') OR (${table.source} = 'payout' AND ${table.kind} = 'debit')`,
    ),
    check(
      'financial_operations_amount_cents_range',
      sql`${table.amountCents} BETWEEN 1 AND ${MAX_SAFE_CENTS_SQL}`,
    ),
    check(
      'financial_operations_outcome_check',
      sql`${table.outcome} IN ('applied', 'insufficient_funds', 'balance_limit')`,
    ),
    check(
      'financial_operations_response_balance_cents_range',
      sql`${table.responseBalanceCents} BETWEEN 0 AND ${MAX_SAFE_CENTS_SQL}`,
    ),
    uniqueIndex('financial_operations_engine_tx_id_unique')
      .on(table.engineTxId)
      .where(sql`${table.engineTxId} IS NOT NULL`),
    uniqueIndex('financial_operations_business_key_unique')
      .on(table.businessKey)
      .where(sql`${table.businessKey} IS NOT NULL`),
    index('financial_operations_player_created_at_id_idx').on(
      table.playerId,
      table.createdAt,
      table.id,
    ),
    index('financial_operations_bet_id_idx')
      .on(table.betId)
      .where(sql`${table.betId} IS NOT NULL`),
  ],
);

/** Durable state for local-only wallet payout simulations. */
export const payouts = pgTable(
  'payouts',
  {
    id: uuid('id')
      .primaryKey()
      .references(() => financialOperations.id),
    status: varchar('status', { length: 16 }).notNull(),
    completeAfter: timestamp('complete_after', { withTimezone: true, mode: 'date' }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    check('payouts_status_check', sql`${table.status} IN ('processing', 'done')`),
    check(
      'payouts_status_timestamps_check',
      sql`(${table.status} = 'processing' AND ${table.completedAt} IS NULL) OR (${table.status} = 'done' AND ${table.completedAt} IS NOT NULL)`,
    ),
    index('payouts_processing_complete_after_id_idx')
      .on(table.completeAfter, table.id)
      .where(sql`${table.status} = 'processing'`),
  ],
);

export const walletLedgerEntries = pgTable(
  'wallet_ledger_entries',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    operationId: uuid('operation_id')
      .notNull()
      .references(() => financialOperations.id),
    playerId: uuid('player_id')
      .notNull()
      .references(() => wallets.playerId),
    direction: varchar('direction', { length: 8 }).notNull(),
    source: varchar('source', { length: 24 }).notNull(),
    amountCents: bigint('amount_cents', { mode: 'bigint' }).notNull(),
    balanceAfterCents: bigint('balance_after_cents', { mode: 'bigint' }).notNull(),
    betId: varchar('bet_id', { length: 255 }),
    roundId: varchar('round_id', { length: 255 }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    check('wallet_ledger_entries_direction_check', sql`${table.direction} IN ('debit', 'credit')`),
    check(
      'wallet_ledger_entries_source_check',
      sql`${table.source} IN ('engine', 'reconciliation', 'test', 'payout')`,
    ),
    check(
      'wallet_ledger_entries_source_direction_check',
      sql`${table.source} <> 'payout' OR ${table.direction} = 'debit'`,
    ),
    check(
      'wallet_ledger_entries_amount_cents_range',
      sql`${table.amountCents} BETWEEN 1 AND ${MAX_SAFE_CENTS_SQL}`,
    ),
    check(
      'wallet_ledger_entries_balance_after_cents_range',
      sql`${table.balanceAfterCents} BETWEEN 0 AND ${MAX_SAFE_CENTS_SQL}`,
    ),
    uniqueIndex('wallet_ledger_entries_operation_id_unique').on(table.operationId),
    index('wallet_ledger_entries_player_created_at_id_idx').on(
      table.playerId,
      table.createdAt,
      table.id,
    ),
  ],
);
