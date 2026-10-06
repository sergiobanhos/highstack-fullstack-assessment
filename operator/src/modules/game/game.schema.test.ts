import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createDatabase } from '../../db';
import { gameBets, gameCommands } from './game.schema';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

function isDedicatedTestDatabase(databaseUrl: string): boolean {
  try {
    const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
    return /(^|[_-])test([_-]|$)/i.test(databaseName);
  } catch {
    return false;
  }
}

function rootCause(error: unknown): unknown {
  let current = error;
  while (current !== null && typeof current === 'object' && 'cause' in current) {
    const cause = (current as { cause?: unknown }).cause;
    if (cause === undefined) break;
    current = cause;
  }
  return current;
}

async function expectPostgresCode(
  query: PromiseLike<unknown>,
  code: string,
  constraintName: string,
): Promise<void> {
  let error: unknown;
  try {
    await query;
  } catch (caught) {
    error = caught;
  }
  expect(rootCause(error)).toMatchObject({ code, constraint_name: constraintName });
}

if (!testDatabaseUrl) {
  test.skip('game schema integration checks require TEST_DATABASE_URL', () => {});
} else if (!isDedicatedTestDatabase(testDatabaseUrl)) {
  test('TEST_DATABASE_URL must point to a dedicated database whose name contains "test"', () => {
    throw new Error('Refusing to run game schema checks against a database not marked as test-only');
  });
} else {
  const connection = createDatabase(testDatabaseUrl);
  const migrationsFolder = fileURLToPath(new URL('../../../drizzle', import.meta.url));

  async function cleanPlayer(playerId: string): Promise<void> {
    await connection.db.delete(gameBets).where(eq(gameBets.playerId, playerId));
    await connection.db.delete(gameCommands).where(eq(gameCommands.playerId, playerId));
  }

  async function insertBetCommand({
    playerId,
    roundId,
    idempotencyKey = randomUUID(),
    status = 'pending',
    betId = null,
  }: {
    playerId: string;
    roundId: string;
    idempotencyKey?: string;
    status?: 'pending' | 'accepted' | 'rejected' | 'unknown';
    betId?: string | null;
  }): Promise<string> {
    const [command] = await connection.db
      .insert(gameCommands)
      .values({
        playerId,
        commandType: 'bet',
        idempotencyKey,
        requestHash: 'a'.repeat(64),
        roundId,
        betId,
        amountCents: 250n,
        autoCashoutHundredths: 150,
        status,
      })
      .returning({ id: gameCommands.id });
    return command!.id;
  }

  async function insertCashoutCommand({
    playerId,
    betId,
    idempotencyKey = randomUUID(),
    status = 'pending',
  }: {
    playerId: string;
    betId: string;
    idempotencyKey?: string;
    status?: 'pending' | 'accepted' | 'rejected' | 'unknown';
  }): Promise<string> {
    const [command] = await connection.db
      .insert(gameCommands)
      .values({
        playerId,
        commandType: 'cashout',
        idempotencyKey,
        requestHash: 'b'.repeat(64),
        betId,
        amountCents: null,
        autoCashoutHundredths: null,
        status,
      })
      .returning({ id: gameCommands.id });
    return command!.id;
  }

  beforeAll(async () => {
    await connection.check();
    await migrate(connection.db, { migrationsFolder });
    await connection.checkSchema();
  });

  afterAll(async () => {
    await connection.close();
  });

  describe('game schema', () => {
    test('creates a partial index for active bets by round', async () => {
      const indexes = await connection.db.execute(sql`
        SELECT indexdef
        FROM pg_indexes
        WHERE schemaname = current_schema()
          AND indexname = 'game_bets_active_round_id_idx'
      `);
      const definition = indexes.map((row) => String(row.indexdef)).join('\n');
      expect(definition).toContain('game_bets_active_round_id_idx');
      expect(definition).toContain('round_id');
      expect(definition).toContain('engine_status');
      expect(definition).toContain('active');
    });

    test('creates additive tables, preserves game records across repeated migrations, and stores no session ID', async () => {
      const playerId = randomUUID();
      const roundId = `migration-round-${randomUUID()}`;
      const betId = `migration-bet-${randomUUID()}`;
      let commandId: string | undefined;
      try {
        commandId = await insertBetCommand({
          playerId,
          roundId,
          status: 'accepted',
          betId,
        });
        await connection.db.insert(gameBets).values({
          betId,
          commandId,
          playerId,
          roundId,
          amountCents: 250n,
          autoCashoutHundredths: 150,
          engineStatus: 'active',
          settlementStatus: 'not_applicable',
        });

        await migrate(connection.db, { migrationsFolder });

        const [storedCommand] = await connection.db
          .select({ id: gameCommands.id, status: gameCommands.status })
          .from(gameCommands)
          .where(eq(gameCommands.id, commandId));
        const [storedBet] = await connection.db
          .select({
            betId: gameBets.betId,
            amountCents: gameBets.amountCents,
            autoCashoutHundredths: gameBets.autoCashoutHundredths,
          })
          .from(gameBets)
          .where(eq(gameBets.betId, betId));

        expect(storedCommand).toEqual({ id: commandId, status: 'accepted' });
        expect(storedBet).toEqual({ betId, amountCents: 250n, autoCashoutHundredths: 150 });
        expect(Object.keys(gameCommands)).not.toContain('sessionId');
        expect(Object.keys(gameBets)).not.toContain('sessionId');
      } finally {
        await cleanPlayer(playerId);
      }
    });

    test('serializes concurrent bet reservations and releases the round slot only after rejection', async () => {
      const playerId = randomUUID();
      const roundId = `concurrent-round-${randomUUID()}`;
      try {
        const competing = await Promise.allSettled([
          insertBetCommand({ playerId, roundId }),
          insertBetCommand({ playerId, roundId }),
        ]);
        const accepted = competing.filter((result) => result.status === 'fulfilled');
        const rejected = competing.filter((result) => result.status === 'rejected');
        expect(accepted).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect(rootCause((rejected[0] as PromiseRejectedResult).reason)).toMatchObject({
          code: '23505',
          constraint_name: 'game_commands_player_round_active_bet_unique',
        });

        const firstId = (accepted[0] as PromiseFulfilledResult<string>).value;
        await connection.db.update(gameCommands)
          .set({ status: 'rejected', resultCode: 'insufficient_funds', resolvedAt: new Date() })
          .where(eq(gameCommands.id, firstId));

        const retryId = await insertBetCommand({ playerId, roundId });
        await connection.db.update(gameCommands)
          .set({ status: 'unknown' })
          .where(eq(gameCommands.id, retryId));
        await expectPostgresCode(
          connection.db.insert(gameCommands).values({
            playerId,
            commandType: 'bet',
            idempotencyKey: randomUUID(),
            requestHash: 'c'.repeat(64),
            roundId,
            amountCents: 250n,
            status: 'pending',
          }),
          '23505',
          'game_commands_player_round_active_bet_unique',
        );

        await connection.db.update(gameCommands)
          .set({ status: 'accepted', betId: `accepted-${randomUUID()}` })
          .where(eq(gameCommands.id, retryId));
        await expectPostgresCode(
          connection.db.insert(gameCommands).values({
            playerId,
            commandType: 'bet',
            idempotencyKey: randomUUID(),
            requestHash: 'd'.repeat(64),
            roundId,
            amountCents: 250n,
            status: 'pending',
          }),
          '23505',
          'game_commands_player_round_active_bet_unique',
        );

        await connection.db.update(gameCommands)
          .set({ status: 'rejected', resultCode: 'betting_closed', resolvedAt: new Date() })
          .where(eq(gameCommands.id, retryId));
        const afterDefinitiveRejection = await insertBetCommand({ playerId, roundId });
        expect(afterDefinitiveRejection).toBeString();
      } finally {
        await cleanPlayer(playerId);
      }
    });

    test('enforces cashout reservation, idempotency, and safe fixed-point ranges', async () => {
      const playerId = randomUUID();
      const betId = `cashout-bet-${randomUUID()}`;
      try {
        const competing = await Promise.allSettled([
          insertCashoutCommand({ playerId, betId }),
          insertCashoutCommand({ playerId, betId }),
        ]);
        const accepted = competing.filter((result) => result.status === 'fulfilled');
        const rejected = competing.filter((result) => result.status === 'rejected');
        expect(accepted).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect(rootCause((rejected[0] as PromiseRejectedResult).reason)).toMatchObject({
          code: '23505',
          constraint_name: 'game_commands_pending_cashout_bet_unique',
        });

        const firstId = (accepted[0] as PromiseFulfilledResult<string>).value;
        await connection.db.update(gameCommands)
          .set({ status: 'unknown' })
          .where(eq(gameCommands.id, firstId));
        await expectPostgresCode(
          connection.db.insert(gameCommands).values({
            playerId,
            commandType: 'cashout',
            idempotencyKey: randomUUID(),
            requestHash: 'f'.repeat(64),
            betId,
            status: 'pending',
          }),
          '23505',
          'game_commands_pending_cashout_bet_unique',
        );

        const duplicateKey = randomUUID();
        await insertCashoutCommand({ playerId, betId: `different-bet-${randomUUID()}`, idempotencyKey: duplicateKey });
        await expectPostgresCode(
          connection.db.insert(gameCommands).values({
            playerId,
            commandType: 'cashout',
            idempotencyKey: duplicateKey,
            requestHash: '1'.repeat(64),
            betId: `another-bet-${randomUUID()}`,
            status: 'pending',
          }),
          '23505',
          'game_commands_player_idempotency_key_unique',
        );

        const safeRangeRoundId = `safe-range-round-${randomUUID()}`;
        const safeRangeBetId = `safe-range-bet-${randomUUID()}`;
        const betCommandId = await insertBetCommand({
          playerId,
          roundId: safeRangeRoundId,
          status: 'accepted',
          betId: safeRangeBetId,
        });
        await connection.db.insert(gameBets).values({
          betId: safeRangeBetId,
          commandId: betCommandId,
          playerId,
          roundId: safeRangeRoundId,
          amountCents: 1_000_000_000n,
          autoCashoutHundredths: 100_000_000,
          engineStatus: 'cashed_out',
          multiplierHundredths: 100_000_000n,
          payoutCents: BigInt(Number.MAX_SAFE_INTEGER),
          settlementStatus: 'pending',
        });
        const unsafeRangeRoundId = `unsafe-range-round-${randomUUID()}`;
        const unsafeRangeBetId = `unsafe-range-bet-${randomUUID()}`;
        const unsafeCommandId = await insertBetCommand({
          playerId,
          roundId: unsafeRangeRoundId,
          status: 'accepted',
          betId: unsafeRangeBetId,
        });
        await expectPostgresCode(
          connection.db.insert(gameBets).values({
            betId: `unsafe-payout-${randomUUID()}`,
            commandId: unsafeCommandId,
            playerId,
            roundId: unsafeRangeRoundId,
            amountCents: 1n,
            engineStatus: 'cashed_out',
            payoutCents: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
            settlementStatus: 'pending',
          }),
          '23514',
          'game_bets_payout_cents_range_check',
        );

        const invalidAmountRoundId = `invalid-amount-round-${randomUUID()}`;
        const invalidAmountBetId = `invalid-amount-bet-${randomUUID()}`;
        const invalidAmountCommandId = await insertBetCommand({
          playerId,
          roundId: invalidAmountRoundId,
          status: 'accepted',
          betId: invalidAmountBetId,
        });
        await expectPostgresCode(
          connection.db.insert(gameBets).values({
            betId: invalidAmountBetId,
            commandId: invalidAmountCommandId,
            playerId,
            roundId: invalidAmountRoundId,
            amountCents: 1_000_000_001n,
            engineStatus: 'active',
            settlementStatus: 'not_applicable',
          }),
          '23514',
          'game_bets_amount_cents_range_check',
        );

        const invalidAutoRoundId = `invalid-auto-round-${randomUUID()}`;
        const invalidAutoBetId = `invalid-auto-bet-${randomUUID()}`;
        const invalidAutoCommandId = await insertBetCommand({
          playerId,
          roundId: invalidAutoRoundId,
          status: 'accepted',
          betId: invalidAutoBetId,
        });
        await expectPostgresCode(
          connection.db.insert(gameBets).values({
            betId: invalidAutoBetId,
            commandId: invalidAutoCommandId,
            playerId,
            roundId: invalidAutoRoundId,
            amountCents: 1n,
            autoCashoutHundredths: 100,
            engineStatus: 'active',
            settlementStatus: 'not_applicable',
          }),
          '23514',
          'game_bets_auto_cashout_range_check',
        );
      } finally {
        await cleanPlayer(playerId);
      }
    });
  });
}
