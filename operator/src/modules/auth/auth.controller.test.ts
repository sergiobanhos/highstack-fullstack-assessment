import Fastify, { type FastifyInstance } from 'fastify';
import type { FastifyRequest } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { fileURLToPath } from 'node:url';
import type { OperatorDatabase } from '../../db';
import { createDatabase } from '../../db';
import { authSessions, players } from './auth.schema';
import { createAuthModule } from './auth.module';
import type { AuthenticatedPlayer } from './auth.service';

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
  test.skip('auth controller integration checks require TEST_DATABASE_URL', () => {});
} else if (!isDedicatedTestDatabase(testDatabaseUrl)) {
  test('TEST_DATABASE_URL must point to a dedicated database whose name contains "test"', () => {
    throw new Error('Refusing to run auth integration checks against a database not marked as test-only');
  });
} else {
  const connection = createDatabase(testDatabaseUrl);
  const migrationsFolder = fileURLToPath(new URL('../../../drizzle', import.meta.url));
  const logger = { warn: (_message: string, _fields?: Record<string, unknown>) => undefined };
  const responseJson = (response: { body: string }): Record<string, any> => JSON.parse(response.body);

  async function removePlayer(email: string): Promise<void> {
    const [player] = await connection.db
      .select({ id: players.id })
      .from(players)
      .where(eq(players.email, email));
    if (!player) return;
    await connection.db.delete(authSessions).where(eq(authSessions.playerId, player.id));
    await connection.db.delete(players).where(eq(players.id, player.id));
  }

  describe('auth REST controller', () => {
    let app: FastifyInstance;
    let requireUser: (request: FastifyRequest) => Promise<AuthenticatedPlayer>;

    beforeAll(async () => {
      await connection.check();
      await migrate(connection.db, { migrationsFolder });
    });

    afterAll(async () => {
      await connection.close();
    });

    beforeEach(async () => {
      app = Fastify({ logger: false });
      const auth = createAuthModule({
        app,
        db: connection.db,
        sessionTtlSeconds: 3_600,
        logger,
      });
      requireUser = auth.requireUser;
      app.get('/protected-test-only', async (request, reply) => {
        try {
          const user = await requireUser(request);
          return { user, sameRequestUser: user === (await requireUser(request)) };
        } catch {
          return reply.code(401).send({ error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } });
        }
      });
      await app.ready();
    });

    afterEach(async () => {
      await app.close();
    });

    test('register returns only a public user and no-store headers', async () => {
      const email = `http-register-${randomUUID()}@test.invalid`;
      try {
        const response = await app.inject({
          method: 'POST',
          url: '/auth/register',
          payload: { name: '  HTTP Player  ', email: ` ${email} `, password: 'long enough password' },
        });

        expect(response.statusCode).toBe(201);
        expect(response.headers['cache-control']).toBe('no-store');
        expect(responseJson(response)).toEqual({
          user: { id: expect.any(String), name: 'HTTP Player', email },
        });
        expect(response.body).not.toContain('password');
      } finally {
        await removePlayer(email);
      }
    });

    test('rejects malformed and unknown fields without echoing supplied values', async () => {
      const secret = `sensitive-${randomUUID()}`;
      const response = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: { name: '', email: 'bad-email', password: 'short', playerId: secret },
      });

      expect(response.statusCode).toBe(400);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(responseJson(response)).toEqual({ error: { code: 'VALIDATION_ERROR', message: 'Request is invalid' } });
      expect(response.body).not.toContain(secret);
    });

    test('returns conflict for an email already in use', async () => {
      const email = `http-conflict-${randomUUID()}@test.invalid`;
      try {
        const first = await app.inject({
          method: 'POST', url: '/auth/register', payload: { name: 'One', email, password: 'long enough password' },
        });
        const duplicate = await app.inject({
          method: 'POST', url: '/auth/register', payload: { name: 'Two', email, password: 'long enough password' },
        });

        expect(first.statusCode).toBe(201);
        expect(duplicate.statusCode).toBe(409);
        expect(responseJson(duplicate)).toEqual({ error: { code: 'EMAIL_IN_USE', message: 'Email is already registered' } });
      } finally {
        await removePlayer(email);
      }
    });

    test('login returns token and ISO expiry; invalid credentials share one response', async () => {
      const email = `http-login-${randomUUID()}@test.invalid`;
      const password = 'long enough password';
      try {
        await app.inject({
          method: 'POST', url: '/auth/register', payload: { name: 'Login Player', email, password },
        });
        const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password } });
        const wrongPassword = await app.inject({
          method: 'POST', url: '/auth/login', payload: { email, password: 'wrong password long' },
        });
        const missingUser = await app.inject({
          method: 'POST', url: '/auth/login', payload: { email: `missing-${email}`, password },
        });

        expect(login.statusCode).toBe(200);
        expect(login.headers['cache-control']).toBe('no-store');
        expect(responseJson(login)).toMatchObject({
          token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
          expiresAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT.*Z$/),
          user: { id: expect.any(String), name: 'Login Player', email },
        });
        expect(wrongPassword.statusCode).toBe(401);
        expect(missingUser.statusCode).toBe(401);
        expect(wrongPassword.body).toBe(missingUser.body);
        expect(wrongPassword.headers['cache-control']).toBe('no-store');
      } finally {
        await removePlayer(email);
      }
    });

    test('me and protected contract use only the authenticated request identity', async () => {
      const firstEmail = `http-identity-a-${randomUUID()}@test.invalid`;
      const secondEmail = `http-identity-b-${randomUUID()}@test.invalid`;
      const password = 'long enough password';
      try {
        const firstUserResponse = await app.inject({
          method: 'POST', url: '/auth/register', payload: { name: 'Player A', email: firstEmail, password },
        });
        const secondUserResponse = await app.inject({
          method: 'POST', url: '/auth/register', payload: { name: 'Player B', email: secondEmail, password },
        });
        const [firstLogin, secondLogin] = await Promise.all([
          app.inject({ method: 'POST', url: '/auth/login', payload: { email: firstEmail, password } }),
          app.inject({ method: 'POST', url: '/auth/login', payload: { email: secondEmail, password } }),
        ]);
        const firstToken = responseJson(firstLogin).token as string;
        const secondToken = responseJson(secondLogin).token as string;

        const [firstMe, secondMe] = await Promise.all([
          app.inject({ method: 'GET', url: '/auth/me?playerId=spoofed', headers: { authorization: `Bearer ${firstToken}` } }),
          app.inject({ method: 'GET', url: '/auth/me', headers: { authorization: `Bearer ${secondToken}` } }),
        ]);
        const [firstProtected, secondProtected] = await Promise.all([
          app.inject({ method: 'GET', url: '/protected-test-only', headers: { authorization: `Bearer ${firstToken}` }, payload: { playerId: 'spoofed' } }),
          app.inject({ method: 'GET', url: '/protected-test-only', headers: { authorization: `Bearer ${secondToken}` } }),
        ]);

        expect(firstUserResponse.statusCode).toBe(201);
        expect(secondUserResponse.statusCode).toBe(201);
        expect(responseJson(firstMe).user).toMatchObject({ name: 'Player A', email: firstEmail });
        expect(responseJson(secondMe).user).toMatchObject({ name: 'Player B', email: secondEmail });
        expect(responseJson(firstProtected)).toMatchObject({ user: { email: firstEmail }, sameRequestUser: true });
        expect(responseJson(secondProtected)).toMatchObject({ user: { email: secondEmail }, sameRequestUser: true });
      } finally {
        await removePlayer(firstEmail);
        await removePlayer(secondEmail);
      }
    });

    test('me rejects a missing bearer credential with a no-store response', async () => {
      const response = await app.inject({ method: 'GET', url: '/auth/me' });
      expect(response.statusCode).toBe(401);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(responseJson(response)).toEqual({ error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } });
    });

    test('logout is idempotent and requires a syntactically valid bearer token', async () => {
      const email = `http-logout-${randomUUID()}@test.invalid`;
      const password = 'long enough password';
      try {
        await app.inject({ method: 'POST', url: '/auth/register', payload: { name: 'Logout Player', email, password } });
        const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password } });
        const token = responseJson(login).token as string;
        const logout = await app.inject({ method: 'POST', url: '/auth/logout', headers: { authorization: `Bearer ${token}` } });
        const secondLogout = await app.inject({ method: 'POST', url: '/auth/logout', headers: { authorization: `Bearer ${token}` } });
        const me = await app.inject({ method: 'GET', url: '/auth/me', headers: { authorization: `Bearer ${token}` } });
        const invalid = await app.inject({ method: 'POST', url: '/auth/logout', headers: { authorization: 'Bearer invalid' } });

        expect(logout.statusCode).toBe(204);
        expect(logout.body).toBe('');
        expect(logout.headers['cache-control']).toBe('no-store');
        expect(secondLogout.statusCode).toBe(204);
        expect(me.statusCode).toBe(401);
        expect(invalid.statusCode).toBe(400);
      } finally {
        await removePlayer(email);
      }
    });

    test('invalid registration attempts consume the route limit before validation', async () => {
      const attempts = [];
      for (let attempt = 0; attempt < 6; attempt += 1) {
        attempts.push(await app.inject({ method: 'POST', url: '/auth/register', payload: { name: '' } }));
      }
      expect(attempts.slice(0, 5).every((response) => response.statusCode === 400)).toBe(true);
      expect(attempts[5]?.statusCode).toBe(429);
      expect(attempts[5]?.headers['cache-control']).toBe('no-store');
      expect(responseJson(attempts[5]!)).toEqual({ error: { code: 'RATE_LIMITED', message: 'Too many requests' } });
    });

    test('invalid login attempts consume the independent login limit before validation', async () => {
      const attempts = [];
      for (let attempt = 0; attempt < 11; attempt += 1) {
        attempts.push(await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'invalid' } }));
      }
      expect(attempts.slice(0, 10).every((response) => response.statusCode === 400)).toBe(true);
      expect(attempts[10]?.statusCode).toBe(429);
      expect(attempts[10]?.headers['cache-control']).toBe('no-store');
    });

    test('limits request bodies and returns a safe error envelope', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: { name: 'x'.repeat(20_000) },
      });
      expect(response.statusCode).toBe(413);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(responseJson(response)).toEqual({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large' } });
    });

    test('maps database failures to a controlled 503 without exposing the error', async () => {
      const failingApp = Fastify({ logger: false });
      const fakeDb = {
        select: () => { throw new Error('postgres://secret:password@db/private'); },
        update: () => { throw new Error('postgres://secret:password@db/private'); },
      } as unknown as OperatorDatabase;
      createAuthModule({ app: failingApp, db: fakeDb, sessionTtlSeconds: 3_600, logger });
      await failingApp.ready();
      try {
        const response = await failingApp.inject({
          method: 'POST',
          url: '/auth/login',
          payload: { email: 'player@test.invalid', password: 'long enough password' },
        });
        const logout = await failingApp.inject({
          method: 'POST',
          url: '/auth/logout',
          headers: { authorization: `Bearer ${randomBytes(32).toString('base64url')}` },
        });
        expect(response.statusCode).toBe(503);
        expect(response.headers['cache-control']).toBe('no-store');
        expect(responseJson(response)).toEqual({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Authentication service is unavailable' } });
        expect(response.body).not.toContain('postgres://');
        expect(logout.statusCode).toBe(503);
        expect(logout.headers['cache-control']).toBe('no-store');
        expect(logout.body).not.toContain('postgres://');
      } finally {
        await failingApp.close();
      }
    });
  });
}
