import { sql } from 'drizzle-orm';
import {
  bigint,
  char,
  check,
  index,
  integer,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

const MAX_BET_CENTS = 1_000_000_000;
const MAX_BET_CENTS_SQL = sql.raw(String(MAX_BET_CENTS));
const MAX_SAFE_INTEGER = 9_007_199_254_740_991n;
const MAX_SAFE_INTEGER_SQL = sql.raw(String(MAX_SAFE_INTEGER));
const MAX_AUTO_CASHOUT_HUNDREDTHS = 100_000_000;
const MAX_AUTO_CASHOUT_HUNDREDTHS_SQL = sql.raw(String(MAX_AUTO_CASHOUT_HUNDREDTHS));

export type GameCommandType = 'bet' | 'cashout';
export type GameCommandStatus = 'pending' | 'accepted' | 'rejected' | 'unknown';
export type GameEngineBetStatus = 'active' | 'lost' | 'cashed_out';
export type GameSettlementStatus = 'not_applicable' | 'pending' | 'confirmed' | 'precision_incident';

/** Durable client commands; player IDs deliberately have no FK into auth's private schema. */
export const gameCommands = pgTable(
  'game_commands',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    playerId: uuid('player_id').notNull(),
    commandType: varchar('command_type', { length: 16 }).$type<GameCommandType>().notNull(),
    idempotencyKey: uuid('idempotency_key').notNull(),
    requestHash: char('request_hash', { length: 64 }).notNull(),
    roundId: varchar('round_id', { length: 255 }),
    betId: varchar('bet_id', { length: 255 }),
    amountCents: bigint('amount_cents', { mode: 'bigint' }),
    autoCashoutHundredths: integer('auto_cashout_hundredths'),
    status: varchar('status', { length: 16 }).$type<GameCommandStatus>().notNull(),
    resultCode: varchar('result_code', { length: 64 }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    check(
      'game_commands_type_check',
      sql`${table.commandType} IN ('bet', 'cashout')`,
    ),
    check(
      'game_commands_status_check',
      sql`${table.status} IN ('pending', 'accepted', 'rejected', 'unknown')`,
    ),
    check(
      'game_commands_request_hash_check',
      sql`${table.requestHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'game_commands_bet_fields_check',
      sql`(${table.commandType} = 'bet' AND ${table.roundId} IS NOT NULL AND ${table.amountCents} IS NOT NULL AND ${table.amountCents} BETWEEN 1 AND ${MAX_BET_CENTS_SQL}) OR (${table.commandType} = 'cashout' AND ${table.betId} IS NOT NULL AND ${table.amountCents} IS NULL AND ${table.autoCashoutHundredths} IS NULL)`,
    ),
    check(
      'game_commands_auto_cashout_range_check',
      sql`${table.autoCashoutHundredths} IS NULL OR ${table.autoCashoutHundredths} BETWEEN 101 AND ${MAX_AUTO_CASHOUT_HUNDREDTHS_SQL}`,
    ),
    check(
      'game_commands_accepted_bet_id_check',
      sql`${table.commandType} <> 'bet' OR ${table.status} <> 'accepted' OR ${table.betId} IS NOT NULL`,
    ),
    uniqueIndex('game_commands_player_idempotency_key_unique')
      .on(table.playerId, table.idempotencyKey),
    uniqueIndex('game_commands_player_round_active_bet_unique')
      .on(table.playerId, table.roundId)
      .where(sql`${table.commandType} = 'bet' AND ${table.status} IN ('pending', 'unknown', 'accepted')`),
    uniqueIndex('game_commands_pending_cashout_bet_unique')
      .on(table.betId)
      .where(sql`${table.commandType} = 'cashout' AND ${table.status} IN ('pending', 'unknown')`),
    index('game_commands_player_created_at_id_idx').on(
      table.playerId,
      table.createdAt,
      table.id,
    ),
    index('game_commands_bet_id_idx')
      .on(table.betId)
      .where(sql`${table.betId} IS NOT NULL`),
  ],
);

/** Accepted Crashsim bets owned by their durable originating command. */
export const gameBets = pgTable(
  'game_bets',
  {
    betId: varchar('bet_id', { length: 255 }).primaryKey(),
    commandId: uuid('command_id')
      .notNull()
      .references(() => gameCommands.id),
    playerId: uuid('player_id').notNull(),
    roundId: varchar('round_id', { length: 255 }).notNull(),
    amountCents: bigint('amount_cents', { mode: 'bigint' }).notNull(),
    autoCashoutHundredths: integer('auto_cashout_hundredths'),
    engineStatus: varchar('engine_status', { length: 16 }).$type<GameEngineBetStatus>().notNull(),
    multiplierHundredths: bigint('multiplier_hundredths', { mode: 'bigint' }),
    payoutCents: bigint('payout_cents', { mode: 'bigint' }),
    settlementStatus: varchar('settlement_status', { length: 24 }).$type<GameSettlementStatus>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'game_bets_amount_cents_range_check',
      sql`${table.amountCents} BETWEEN 1 AND ${MAX_BET_CENTS_SQL}`,
    ),
    check(
      'game_bets_auto_cashout_range_check',
      sql`${table.autoCashoutHundredths} IS NULL OR ${table.autoCashoutHundredths} BETWEEN 101 AND ${MAX_AUTO_CASHOUT_HUNDREDTHS_SQL}`,
    ),
    check(
      'game_bets_engine_status_check',
      sql`${table.engineStatus} IN ('active', 'lost', 'cashed_out')`,
    ),
    check(
      'game_bets_multiplier_hundredths_range_check',
      sql`${table.multiplierHundredths} IS NULL OR ${table.multiplierHundredths} BETWEEN 100 AND ${MAX_SAFE_INTEGER_SQL}`,
    ),
    check(
      'game_bets_payout_cents_range_check',
      sql`${table.payoutCents} IS NULL OR ${table.payoutCents} BETWEEN 0 AND ${MAX_SAFE_INTEGER_SQL}`,
    ),
    check(
      'game_bets_settlement_status_check',
      sql`${table.settlementStatus} IN ('not_applicable', 'pending', 'confirmed', 'precision_incident')`,
    ),
    check(
      'game_bets_settlement_consistency_check',
      sql`(${table.engineStatus} = 'cashed_out' AND ${table.settlementStatus} IN ('pending', 'confirmed', 'precision_incident')) OR (${table.engineStatus} IN ('active', 'lost') AND ${table.settlementStatus} = 'not_applicable')`,
    ),
    check(
      'game_bets_payout_requires_cashout_check',
      sql`${table.payoutCents} IS NULL OR ${table.engineStatus} = 'cashed_out'`,
    ),
    uniqueIndex('game_bets_command_id_unique').on(table.commandId),
    index('game_bets_player_created_at_bet_id_idx').on(
      table.playerId,
      table.createdAt,
      table.betId,
    ),
    index('game_bets_player_round_id_idx').on(table.playerId, table.roundId),
    index('game_bets_active_round_id_idx')
      .on(table.roundId)
      .where(sql`${table.engineStatus} = 'active'`),
  ],
);

export type GameCommand = typeof gameCommands.$inferSelect;
export type NewGameCommand = typeof gameCommands.$inferInsert;
export type GameBet = typeof gameBets.$inferSelect;
export type NewGameBet = typeof gameBets.$inferInsert;
