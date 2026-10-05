import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { fileURLToPath } from 'node:url';
import { createDatabase } from '../../db';
import { authSessions, players } from './auth.schema';
import {
  AuthServiceError,
  createAuthService,
  validateSessionTtlSeconds,
} from './auth.service';

function isDedicatedTestDatabase(databaseUrl: string): boolean {
  try {
    const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
    return /(^|[_-])test([_-]|$)/i.test(databaseName);
  } catch {
    return false;
  }
}

function getAuthErrorCode(result: PromiseSettledResult<unknown>): string | undefined {
  if (result.status !== 'rejected' || !(result.reason instanceof AuthServiceError)) return undefined;
  return result.reason.code;
}

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

if (!testDatabaseUrl) {
  test.skip('auth service integration checks require TEST_DATABASE_URL', () => {});
} else if (!isDedicatedTestDatabase(testDatabaseUrl)) {
  test('TEST_DATABASE_URL must point to a dedicated database whose name contains "test"', () => {
    throw new Error('Refusing to run auth integration checks against a database not marked as test-only');
  });
} else {
  const connection = createDatabase(testDatabaseUrl);
  const service = createAuthService({ db: connection.db, sessionTtlSeconds: 3_600 });
  const migrationsFolder = fileURLToPath(new URL('../../../drizzle', import.meta.url));

  async function removePlayer(email: string): Promise<void> {
    const [player] = await connection.db
      .select({ id: players.id })
      .from(players)
      .where(eq(players.email, email));
    if (!player) return;

    await connection.db.delete(authSessions).where(eq(authSessions.playerId, player.id));
    await connection.db.delete(players).where(eq(players.id, player.id));
  }

  beforeAll(async () => {
    await connection.check();
    await migrate(connection.db, { migrationsFolder });
  });

  afterAll(async () => {
    await connection.close();
  });

  describe('auth service', () => {
    test('normalizes email and returns only public player data', async () => {
      const email = `  Auth-${randomUUID()}@TEST.INVALID  `;
      const normalizedEmail = email.trim().toLowerCase();
      const password = 'correct horse battery staple';

      try {
        const user = await service.register({ name: '  Test Player  ', email, password });
        const [storedPlayer] = await connection.db
          .select()
          .from(players)
          .where(eq(players.id, user.id));

        expect(user).toEqual({ id: expect.any(String), name: 'Test Player', email: normalizedEmail });
        expect(user).not.toHaveProperty('passwordHash');
        expect(storedPlayer?.passwordHash).not.toBe(password);
        expect(await Bun.password.verify(password, storedPlayer!.passwordHash)).toBe(true);
      } finally {
        await removePlayer(normalizedEmail);
      }
    });

    test('allows one concurrent canonical email and rejects excess hash work without queueing', async () => {
      const email = `race-${randomUUID()}@test.invalid`;
      const otherEmail = `other-${randomUUID()}@test.invalid`;

      try {
        const results = await Promise.allSettled([
          service.register({ name: 'First', email: ` ${email.toUpperCase()} `, password: 'password one' }),
          service.register({ name: 'Second', email: `${email} `, password: 'password two' }),
          service.register({ name: 'Third', email: otherEmail, password: 'password three' }),
        ]);

        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        expect(results.filter((result) => getAuthErrorCode(result) === 'EMAIL_IN_USE')).toHaveLength(1);
        expect(results.filter((result) => getAuthErrorCode(result) === 'RATE_LIMITED')).toHaveLength(1);

        const [stored] = await connection.db
          .select({ id: players.id })
          .from(players)
          .where(eq(players.email, email));
        expect(stored?.id).toBeDefined();
      } finally {
        await removePlayer(email);
        await removePlayer(otherEmail);
      }
    });

    test('uses the same generic login failure for unknown email and wrong password', async () => {
      const email = `login-${randomUUID()}@test.invalid`;
      const unknownEmail = `missing-${randomUUID()}@test.invalid`;
      const password = 'correct horse battery staple';

      try {
        await service.register({ name: 'Login Player', email, password });

        const outcomes = await Promise.allSettled([
          service.login({ email, password: 'incorrect password' }),
          service.login({ email: unknownEmail, password: 'incorrect password' }),
        ]);

        expect(outcomes.map(getAuthErrorCode)).toEqual(['INVALID_CREDENTIALS', 'INVALID_CREDENTIALS']);
        const [session] = await connection.db
          .select({ id: authSessions.id })
          .from(authSessions)
          .innerJoin(players, eq(authSessions.playerId, players.id))
          .where(eq(players.email, email));
        expect(session).toBeUndefined();
      } finally {
        await removePlayer(email);
      }
    });

    test('persists only token hashes and enforces expiry and revocation across service instances', async () => {
      const email = `session-${randomUUID()}@test.invalid`;
      const password = 'correct horse battery staple';

      try {
        const registered = await service.register({ name: 'Session Player', email, password });
        const firstLogin = await service.login({ email, password });
        const secondLogin = await service.login({ email, password });
        const thirdLogin = await service.login({ email, password });
        const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
        const recreatedService = createAuthService({ db: connection.db, sessionTtlSeconds: 3_600 });

        expect(firstLogin.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(firstLogin.user).toEqual(registered);
        expect(firstLogin.expiresAt.getTime()).toBeGreaterThan(Date.now());
        expect(await service.resolveSession(firstLogin.token)).toEqual(registered);
        expect(await recreatedService.resolveSession(firstLogin.token)).toEqual(registered);

        const [storedSession] = await connection.db
          .select({ tokenHash: authSessions.tokenHash })
          .from(authSessions)
          .where(eq(authSessions.tokenHash, tokenHash(firstLogin.token)));
        expect(storedSession?.tokenHash).toBe(tokenHash(firstLogin.token));
        expect(storedSession?.tokenHash).not.toContain(firstLogin.token);

        const expiredAt = new Date(Date.now() - 1_000);
        await connection.db
          .update(authSessions)
          .set({
            createdAt: new Date(expiredAt.getTime() - 60_000),
            expiresAt: expiredAt,
          })
          .where(eq(authSessions.tokenHash, tokenHash(firstLogin.token)));
        expect(await recreatedService.resolveSession(firstLogin.token)).toBeNull();

        await service.logout(secondLogin.token);
        await service.logout(secondLogin.token);
        expect(await recreatedService.resolveSession(secondLogin.token)).toBeNull();
        expect(await recreatedService.resolveSession(thirdLogin.token)).toEqual(registered);
        await service.logout('unknown-token');
      } finally {
        await removePlayer(email);
      }
    });

    test('validates finite session TTL bounds', () => {
      expect(validateSessionTtlSeconds(60)).toBe(60);
      expect(validateSessionTtlSeconds(604_800)).toBe(604_800);

      for (const value of [Number.NaN, Number.POSITIVE_INFINITY, 59, 604_801, 60.5]) {
        expect(() => validateSessionTtlSeconds(value)).toThrow(
          'AUTH_SESSION_TTL_SECONDS must be an integer between 60 and 604800',
        );
      }
    });

    test('does not turn a database outage into an invalid-credentials result', async () => {
      const unavailable = createDatabase('postgres://operator:private-password@127.0.0.1:1/operator_test');
      const unavailableService = createAuthService({ db: unavailable.db, sessionTtlSeconds: 3_600 });

      try {
        const result = await Promise.allSettled([
          unavailableService.login({ email: `missing-${randomUUID()}@test.invalid`, password: 'any password' }),
        ]);

        expect(result[0]?.status).toBe('rejected');
        expect(getAuthErrorCode(result[0]!)).not.toBe('INVALID_CREDENTIALS');
      } finally {
        await unavailable.close();
      }
    });
  });
}
