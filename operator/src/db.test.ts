import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { authSessions, players } from './modules/auth/auth.schema';
import {
  financialOperations,
  walletLedgerEntries,
  wallets,
} from './modules/financial/financial.schema';
import { createDatabase } from './db';

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

  let rootCause = error;
  while (rootCause !== null && typeof rootCause === 'object' && 'cause' in rootCause) {
    const cause = (rootCause as { cause?: unknown }).cause;
    if (cause === undefined) break;
    rootCause = cause;
  }

  expect(rootCause).toMatchObject({ code, constraint_name: constraintName });
}

describe('createDatabase', () => {
  test('rejects invalid URLs without echoing their contents', () => {
    const secret = 'postgres://user:private-password@invalid.example/operator';
    let error: unknown;

    try {
      createDatabase(secret.replace('postgres://', 'mysql://'));
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('DATABASE_URL must be a valid PostgreSQL URL');
    expect((error as Error).message).not.toContain('private-password');
  });

  test('closes an unused pool safely and idempotently', async () => {
    const connection = createDatabase('postgres://operator:operator@127.0.0.1:5432/operator_test');

    await connection.close();
    await connection.close();
    await expect(connection.check()).rejects.toThrow('Database connection is closed');
  });

  test('masks connection errors instead of exposing database credentials', async () => {
    const connection = createDatabase(
      'postgres://operator:private-password@127.0.0.1:1/operator_test',
    );

    try {
      let error: unknown;
      try {
        await connection.check();
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('Database is unavailable');
      expect((error as Error).message).not.toContain('private-password');
    } finally {
      await connection.close();
    }
  });
});

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

function isDedicatedTestDatabase(databaseUrl: string): boolean {
  try {
    const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
    return /(^|[_-])test([_-]|$)/i.test(databaseName);
  } catch {
    return false;
  }
}

if (!testDatabaseUrl) {
  test.skip('PostgreSQL migration/integrity checks require TEST_DATABASE_URL', () => {});
} else if (!isDedicatedTestDatabase(testDatabaseUrl)) {
  test('TEST_DATABASE_URL must point to a dedicated database whose name contains "test"', () => {
    throw new Error('Refusing to run migration integration checks against a database not marked as test-only');
  });
} else {
  const connection = createDatabase(testDatabaseUrl);
  const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url));

  beforeAll(async () => {
    await connection.check();
    await migrate(connection.db, { migrationsFolder });
    await connection.checkSchema();
  });

  afterAll(async () => {
    await connection.close();
  });

  test('migrations are repeatable, preserve auth and financial rows, and enforce financial constraints', async () => {
    await migrate(connection.db, { migrationsFolder });

    const playerId = randomUUID();
    const email = `${playerId}@test.invalid`;
    const sessionId = randomUUID();
    const engineTxId = randomUUID();
    const businessKey = `top-up:${playerId}:${randomUUID()}`;
    const cashoutBetId = randomUUID();
    const cashoutBusinessKey = `cashout:${cashoutBetId}`;

    await connection.db.insert(players).values({
      id: playerId,
      name: 'Migration test',
      email,
      passwordHash: 'test-only-hash',
    });
    await connection.db.insert(authSessions).values({
      id: sessionId,
      playerId,
      tokenHash: 'a'.repeat(64),
      expiresAt: new Date(Date.now() + 60_000),
    });
    await connection.db.insert(wallets).values({ playerId, balanceCents: 900n });
    const [debit] = await connection.db
      .insert(financialOperations)
      .values({
        playerId,
        kind: 'debit',
        source: 'engine',
        amountCents: 100n,
        engineTxId,
        betId: randomUUID(),
        roundId: randomUUID(),
        outcome: 'applied',
        responseBalanceCents: 800n,
      })
      .returning({ id: financialOperations.id });
    const [topup] = await connection.db
      .insert(financialOperations)
      .values({
        playerId,
        kind: 'test_top_up',
        source: 'test',
        amountCents: 500n,
        businessKey,
        outcome: 'applied',
        responseBalanceCents: 1_400n,
      })
      .returning({ id: financialOperations.id });
    const [reconciledCashout] = await connection.db
      .insert(financialOperations)
      .values({
        playerId,
        kind: 'credit',
        source: 'reconciliation',
        amountCents: 500n,
        businessKey: cashoutBusinessKey,
        betId: cashoutBetId,
        outcome: 'applied',
        responseBalanceCents: 1_400n,
      })
      .returning({ id: financialOperations.id });
    const [ledgerEntry] = await connection.db
      .insert(walletLedgerEntries)
      .values({
        operationId: debit!.id,
        playerId,
        direction: 'debit',
        source: 'engine',
        amountCents: 100n,
        balanceAfterCents: 800n,
      })
      .returning({ id: walletLedgerEntries.id });

    try {
      await migrate(connection.db, { migrationsFolder });

      const [persistedPlayer] = await connection.db
        .select({ id: players.id })
        .from(players)
        .where(eq(players.id, playerId));
      expect(persistedPlayer?.id).toBe(playerId);
      const [persistedSession] = await connection.db
        .select({ id: authSessions.id })
        .from(authSessions)
        .where(eq(authSessions.id, sessionId));
      expect(persistedSession?.id).toBe(sessionId);
      const [persistedWallet] = await connection.db
        .select({ balanceCents: wallets.balanceCents })
        .from(wallets)
        .where(eq(wallets.playerId, playerId));
      expect(persistedWallet?.balanceCents).toBe(900n);
      const [persistedDebit] = await connection.db
        .select({ id: financialOperations.id })
        .from(financialOperations)
        .where(eq(financialOperations.engineTxId, engineTxId));
      expect(persistedDebit?.id).toBe(debit!.id);
      const [persistedTopup] = await connection.db
        .select({ id: financialOperations.id })
        .from(financialOperations)
        .where(eq(financialOperations.businessKey, businessKey));
      expect(persistedTopup?.id).toBe(topup!.id);
      const [persistedCashout] = await connection.db
        .select({ id: financialOperations.id })
        .from(financialOperations)
        .where(eq(financialOperations.businessKey, cashoutBusinessKey));
      expect(persistedCashout?.id).toBe(reconciledCashout!.id);
      const [persistedLedgerEntry] = await connection.db
        .select({ id: walletLedgerEntries.id })
        .from(walletLedgerEntries)
        .where(eq(walletLedgerEntries.id, ledgerEntry!.id));
      expect(persistedLedgerEntry?.id).toBe(ledgerEntry!.id);

      await expectPostgresCode(
        connection.db.insert(players).values({
          name: 'Duplicate email',
          email,
          passwordHash: 'test-only-hash',
        }),
        '23505',
        'players_email_unique',
      );

      await expectPostgresCode(
        connection.db.insert(players).values({
          name: 'Non-canonical email',
          email: `Upper-${playerId}@test.invalid`,
          passwordHash: 'test-only-hash',
        }),
        '23514',
        'players_email_canonical',
      );

      await expectPostgresCode(
        connection.db.insert(authSessions).values({
          id: randomUUID(),
          playerId: randomUUID(),
          tokenHash: randomUUID().replaceAll('-', '').padEnd(64, '0'),
          expiresAt: new Date(Date.now() + 60_000),
        }),
        '23503',
        'auth_sessions_player_id_players_id_fk',
      );

      const now = new Date();
      await expectPostgresCode(
        connection.db.insert(authSessions).values({
          playerId,
          tokenHash: randomUUID().replaceAll('-', '').padEnd(64, '1'),
          createdAt: now,
          expiresAt: new Date(now.getTime() - 60_000),
        }),
        '23514',
        'auth_sessions_expiry_after_creation',
      );

      await expectPostgresCode(
        connection.db.insert(wallets).values({ playerId: randomUUID(), balanceCents: -1n }),
        '23514',
        'wallets_balance_cents_range',
      );
      await expectPostgresCode(
        connection.db.insert(wallets).values({ playerId: randomUUID(), balanceCents: 9_007_199_254_740_992n }),
        '23514',
        'wallets_balance_cents_range',
      );
      await expectPostgresCode(
        connection.db.insert(financialOperations).values({
          playerId,
          kind: 'debit',
          source: 'engine',
          amountCents: 0n,
          outcome: 'applied',
          responseBalanceCents: 800n,
        }),
        '23514',
        'financial_operations_amount_cents_range',
      );
      await expectPostgresCode(
        connection.db.insert(financialOperations).values({
          playerId,
          kind: 'debit',
          source: 'engine',
          amountCents: 9_007_199_254_740_992n,
          outcome: 'applied',
          responseBalanceCents: 800n,
        }),
        '23514',
        'financial_operations_amount_cents_range',
      );
      await expectPostgresCode(
        connection.db.insert(financialOperations).values({
          playerId,
          kind: 'debit',
          source: 'engine',
          amountCents: 1n,
          outcome: 'applied',
          responseBalanceCents: 9_007_199_254_740_992n,
        }),
        '23514',
        'financial_operations_response_balance_cents_range',
      );
      await expectPostgresCode(
        connection.db.insert(financialOperations).values({
          playerId: randomUUID(),
          kind: 'debit',
          source: 'engine',
          amountCents: 1n,
          outcome: 'applied',
          responseBalanceCents: 0n,
        }),
        '23503',
        'financial_operations_player_id_wallets_player_id_fk',
      );
      await expectPostgresCode(
        connection.db.insert(financialOperations).values({
          playerId,
          kind: 'debit',
          source: 'engine',
          amountCents: 1n,
          engineTxId,
          outcome: 'applied',
          responseBalanceCents: 800n,
        }),
        '23505',
        'financial_operations_engine_tx_id_unique',
      );
      await expectPostgresCode(
        connection.db.insert(financialOperations).values({
          playerId,
          kind: 'test_top_up',
          source: 'test',
          amountCents: 1n,
          businessKey,
          outcome: 'applied',
          responseBalanceCents: 900n,
        }),
        '23505',
        'financial_operations_business_key_unique',
      );
      await expectPostgresCode(
        connection.db.insert(financialOperations).values({
          playerId,
          kind: 'credit',
          source: 'engine',
          amountCents: 1n,
          engineTxId: randomUUID(),
          businessKey: cashoutBusinessKey,
          betId: cashoutBetId,
          outcome: 'applied',
          responseBalanceCents: 900n,
        }),
        '23505',
        'financial_operations_business_key_unique',
      );
      await expectPostgresCode(
        connection.db.insert(walletLedgerEntries).values({
          operationId: debit!.id,
          playerId,
          direction: 'debit',
          source: 'engine',
          amountCents: 100n,
          balanceAfterCents: 800n,
        }),
        '23505',
        'wallet_ledger_entries_operation_id_unique',
      );
      await expectPostgresCode(
        connection.db.insert(walletLedgerEntries).values({
          operationId: topup!.id,
          playerId,
          direction: 'credit',
          source: 'test',
          amountCents: 9_007_199_254_740_992n,
          balanceAfterCents: 1_400n,
        }),
        '23514',
        'wallet_ledger_entries_amount_cents_range',
      );
      await expectPostgresCode(
        connection.db.insert(walletLedgerEntries).values({
          operationId: topup!.id,
          playerId,
          direction: 'credit',
          source: 'test',
          amountCents: 1n,
          balanceAfterCents: 9_007_199_254_740_992n,
        }),
        '23514',
        'wallet_ledger_entries_balance_after_cents_range',
      );
      await expectPostgresCode(
        connection.db.insert(walletLedgerEntries).values({
          operationId: randomUUID(),
          playerId,
          direction: 'credit',
          source: 'test',
          amountCents: 1n,
          balanceAfterCents: 1n,
        }),
        '23503',
        'wallet_ledger_entries_operation_id_financial_operations_id_fk',
      );
    } finally {
      await connection.db.delete(walletLedgerEntries).where(eq(walletLedgerEntries.playerId, playerId));
      await connection.db.delete(financialOperations).where(eq(financialOperations.playerId, playerId));
      await connection.db.delete(wallets).where(eq(wallets.playerId, playerId));
      await connection.db.delete(authSessions).where(eq(authSessions.playerId, playerId));
      await connection.db.delete(players).where(eq(players.id, playerId));
    }
  });
}
