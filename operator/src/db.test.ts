import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { authSessions, players } from './modules/auth/auth.schema';
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
  });

  afterAll(async () => {
    await connection.close();
  });

  test('migrations are repeatable and preserve auth rows and constraints', async () => {
    await migrate(connection.db, { migrationsFolder });

    const playerId = randomUUID();
    const email = `${playerId}@test.invalid`;
    const sessionId = randomUUID();

    await connection.db.insert(players).values({
      id: playerId,
      name: 'Migration test',
      email,
      passwordHash: 'test-only-hash',
    });

    try {
      await migrate(connection.db, { migrationsFolder });

      const [persistedPlayer] = await connection.db
        .select({ id: players.id })
        .from(players)
        .where(eq(players.id, playerId));
      expect(persistedPlayer?.id).toBe(playerId);

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
          id: sessionId,
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
    } finally {
      await connection.db.delete(players).where(eq(players.id, playerId));
    }
  });
}
