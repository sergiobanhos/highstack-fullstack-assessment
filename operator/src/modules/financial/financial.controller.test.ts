import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { createHmac, randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { fileURLToPath } from 'node:url';
import { loadConfig, type Logger } from '../../config';
import { createDatabase } from '../../db';
import { financialOperations, payouts, walletLedgerEntries, wallets } from './financial.schema';
import { createFinancialModule } from './financial.module';
import { FinancialServiceError, type FinancialService } from './financial.service';
import { registerFinancialController } from './financial.controller';
import { UnauthenticatedError, type AuthModule, type AuthenticatedPlayer } from '../auth/auth.module';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const webhookSecret = 'controller-test-webhook-secret';

function isDedicatedTestDatabase(databaseUrl: string): boolean {
  try {
    const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
    return /(^|[_-])test([_-]|$)/i.test(databaseName);
  } catch {
    return false;
  }
}

function signedHeaders(rawBody: string, timestamp = String(Math.floor(Date.now() / 1_000))): Record<string, string> {
  const signature = createHmac('sha256', webhookSecret)
    .update(`${timestamp}.`)
    .update(Buffer.from(rawBody))
    .digest('hex');
  return { 'content-type': 'application/json', 'x-timestamp': timestamp, 'x-signature': signature };
}

function responseJson(response: { body: string }): Record<string, any> {
  return JSON.parse(response.body);
}

if (!testDatabaseUrl) {
  test.skip('financial controller integration checks require TEST_DATABASE_URL', () => {});
} else if (!isDedicatedTestDatabase(testDatabaseUrl)) {
  test('TEST_DATABASE_URL must point to a dedicated database whose name contains "test"', () => {
    throw new Error('Refusing to run financial integration checks against a database not marked as test-only');
  });
} else {
  const connection = createDatabase(testDatabaseUrl);
  const migrationsFolder = fileURLToPath(new URL('../../../drizzle', import.meta.url));
  const config = loadConfig({
    DATABASE_URL: testDatabaseUrl,
    APP_ENV: 'test',
    ENGINE_WEBHOOK_SECRET: webhookSecret,
  });
  const localConfig = loadConfig({
    DATABASE_URL: testDatabaseUrl,
    APP_ENV: 'local',
    ENGINE_WEBHOOK_SECRET: webhookSecret,
    WALLET_TEST_TOPUP_ENABLED: 'true',
    PAYOUT_MOCK_ENABLED: 'true',
  });
  const identitiesByToken = new Map<string, AuthenticatedPlayer>();
  const testAuth: Pick<AuthModule, 'requireUser'> = {
    async requireUser(request) {
      const authorization = request.headers.authorization;
      const token = typeof authorization === 'string' && authorization.startsWith('Bearer ')
        ? authorization.slice('Bearer '.length)
        : '';
      const identity = identitiesByToken.get(token);
      if (!identity) throw new UnauthenticatedError();
      return identity;
    },
  };
  const capturedLogs: string[] = [];
  const logger: Logger = {
    debug: (message, fields) => capturedLogs.push(`${message} ${JSON.stringify(fields ?? {})}`),
    info: (message, fields) => capturedLogs.push(`${message} ${JSON.stringify(fields ?? {})}`),
    warn: (message, fields) => capturedLogs.push(`${message} ${JSON.stringify(fields ?? {})}`),
    error: (message, fields) => capturedLogs.push(`${message} ${JSON.stringify(fields ?? {})}`),
  };

  async function cleanWallet(playerId: string): Promise<void> {
    const operations = await connection.db.select({ id: financialOperations.id })
      .from(financialOperations).where(eq(financialOperations.playerId, playerId));
    if (operations.length > 0) {
      await connection.db.delete(payouts).where(inArray(payouts.id, operations.map(({ id }) => id)));
    }
    await connection.db.delete(walletLedgerEntries).where(eq(walletLedgerEntries.playerId, playerId));
    await connection.db.delete(financialOperations).where(eq(financialOperations.playerId, playerId));
    await connection.db.delete(wallets).where(eq(wallets.playerId, playerId));
  }

  function authenticatedAs(playerId: string): { authorization: string } {
    const token = randomUUID();
    identitiesByToken.set(token, { id: playerId, name: 'Test Player', email: `${playerId}@test.invalid` });
    return { authorization: `Bearer ${token}` };
  }

  describe('financial REST controller', () => {
    let app: FastifyInstance;
    let localApp: FastifyInstance;
    let service: FinancialService;
    let localService: FinancialService;

    beforeAll(async () => {
      await connection.check();
      await migrate(connection.db, { migrationsFolder });
      await connection.checkSchema();
    });

    afterAll(async () => {
      await connection.close();
    });

    beforeAll(async () => {
      app = Fastify({ logger: false });
      service = createFinancialModule({ app, db: connection.db, config, logger, auth: testAuth });
      await app.ready();
      localApp = Fastify({ logger: false });
      localService = createFinancialModule({ app: localApp, db: connection.db, config: localConfig, logger, auth: testAuth });
      await localApp.ready();
    });

    afterEach(() => {
      capturedLogs.length = 0;
      identitiesByToken.clear();
    });

    afterAll(async () => {
      await Promise.all([app.close(), localApp.close()]);
    });

    test('requires an authenticated identity and provisions only that player’s zero USD wallet', async () => {
      const unauthenticatedBalance = await app.inject({ method: 'GET', url: '/wallet' });
      const unauthenticatedHistory = await app.inject({ method: 'GET', url: '/wallet/transactions' });
      expect(unauthenticatedBalance.statusCode).toBe(401);
      expect(unauthenticatedHistory.statusCode).toBe(401);

      const playerId = randomUUID();
      try {
        const response = await app.inject({ method: 'GET', url: '/wallet', headers: authenticatedAs(playerId) });
        expect(response.statusCode).toBe(200);
        expect(response.headers['cache-control']).toBe('no-store');
        expect(responseJson(response)).toEqual({ balance: 0, currency: 'USD' });
        expect(await service.getBalance(playerId)).toEqual({ playerId, balanceCents: 0n });

        const forgedQuery = await app.inject({
          method: 'GET', url: `/wallet?playerId=${randomUUID()}`, headers: authenticatedAs(playerId),
        });
        expect(forgedQuery.statusCode).toBe(400);
      } finally {
        await cleanWallet(playerId);
      }
    });

    test('registers test top-up only in explicit local configuration', async () => {
      expect(app.hasRoute({ method: 'POST', url: '/wallet/top-ups' })).toBe(false);
      expect(localApp.hasRoute({ method: 'POST', url: '/wallet/top-ups' })).toBe(true);
      const unauthorized = await localApp.inject({
        method: 'POST', url: '/wallet/top-ups',
        headers: { 'idempotency-key': randomUUID() }, payload: { amount: 100 },
      });
      expect(unauthorized.statusCode).toBe(401);
      const disabledRoute = await app.inject({
        method: 'POST', url: '/wallet/top-ups',
        headers: { ...authenticatedAs(randomUUID()), 'idempotency-key': randomUUID() },
        payload: { amount: 100 },
      });
      expect(disabledRoute.statusCode).toBe(404);
    });

    test('registers payout routes only when enabled and requires authentication', async () => {
      expect(app.hasRoute({ method: 'POST', url: '/payouts' })).toBe(false);
      expect(app.hasRoute({ method: 'GET', url: '/payouts' })).toBe(false);
      expect(localApp.hasRoute({ method: 'POST', url: '/payouts' })).toBe(true);
      expect(localApp.hasRoute({ method: 'GET', url: '/payouts' })).toBe(true);
      expect((await localApp.inject({ method: 'POST', url: '/payouts', payload: { amount: 100 } })).statusCode).toBe(401);
      expect((await localApp.inject({ method: 'GET', url: '/payouts' })).statusCode).toBe(401);
      expect((await localApp.inject({ method: 'GET', url: `/payouts/${randomUUID()}` })).statusCode).toBe(401);
      expect((await app.inject({
        method: 'GET', url: '/payouts', headers: authenticatedAs(randomUUID()),
      })).statusCode).toBe(404);
    });

    test('requests an idempotent payout, exposes owned status/history, and rejects invalid input', async () => {
      const playerId = randomUUID();
      const otherPlayerId = randomUUID();
      const idempotencyKey = randomUUID();
      try {
        await localService.ensureWallet(playerId);
        await localService.ensureWallet(otherPlayerId);
        await localService.topUp({ playerId, amount: 1_000, idempotencyKey: randomUUID() });
        await localService.topUp({ playerId: otherPlayerId, amount: 500, idempotencyKey: randomUUID() });
        const authorization = authenticatedAs(playerId);
        const headers = { ...authorization, 'idempotency-key': idempotencyKey };

        const missingKey = await localApp.inject({ method: 'POST', url: '/payouts', headers: authorization, payload: { amount: 300 } });
        const malformedKey = await localApp.inject({
          method: 'POST', url: '/payouts', headers: { ...authorization, 'idempotency-key': 'bad-key' }, payload: { amount: 300 },
        });
        const invalidAmount = await localApp.inject({ method: 'POST', url: '/payouts', headers, payload: { amount: 0 } });
        const unsafeAmount = await localApp.inject({
          method: 'POST', url: '/payouts', headers, payload: { amount: Number.MAX_SAFE_INTEGER + 1 },
        });
        const forgedPlayer = await localApp.inject({
          method: 'POST', url: '/payouts', headers, payload: { amount: 300, playerId: otherPlayerId },
        });
        expect([missingKey, malformedKey, invalidAmount, unsafeAmount, forgedPlayer].map(({ statusCode }) => statusCode))
          .toEqual([400, 400, 400, 400, 400]);

        const first = await localApp.inject({ method: 'POST', url: '/payouts', headers, payload: { amount: 300 } });
        const replay = await localApp.inject({ method: 'POST', url: '/payouts', headers, payload: { amount: 300 } });
        const conflict = await localApp.inject({ method: 'POST', url: '/payouts', headers, payload: { amount: 301 } });
        expect(first.statusCode).toBe(201);
        expect(first.headers['cache-control']).toBe('no-store');
        expect(responseJson(first)).toMatchObject({
          id: expect.any(String), amountCents: 300, currency: 'USD', status: 'processing',
          requestedAt: expect.any(String), completedAt: null, simulated: true,
        });
        expect(replay.statusCode).toBe(201);
        expect(responseJson(replay).id).toBe(responseJson(first).id);
        expect(conflict.statusCode).toBe(409);
        expect(responseJson(conflict)).toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT' } });
        expect(await localService.getBalance(playerId)).toEqual({ playerId, balanceCents: 700n });

        const secondPayout = await localApp.inject({
          method: 'POST', url: '/payouts',
          headers: { ...authorization, 'idempotency-key': randomUUID() }, payload: { amount: 100 },
        });
        const thirdPayout = await localApp.inject({
          method: 'POST', url: '/payouts',
          headers: { ...authorization, 'idempotency-key': randomUUID() }, payload: { amount: 100 },
        });
        expect(secondPayout.statusCode).toBe(201);
        expect(thirdPayout.statusCode).toBe(201);

        const payoutId = responseJson(first).id as string;
        const ownStatus = await localApp.inject({ method: 'GET', url: `/payouts/${payoutId}`, headers: authorization });
        const foreignStatus = await localApp.inject({
          method: 'GET', url: `/payouts/${payoutId}`, headers: authenticatedAs(otherPlayerId),
        });
        const absentStatus = await localApp.inject({
          method: 'GET', url: `/payouts/${randomUUID()}`, headers: authorization,
        });
        expect(ownStatus.statusCode).toBe(200);
        expect(ownStatus.headers['cache-control']).toBe('no-store');
        expect(responseJson(ownStatus)).toMatchObject({ id: payoutId, amountCents: 300, simulated: true });
        expect(foreignStatus.statusCode).toBe(404);
        expect(responseJson(foreignStatus)).toEqual(responseJson(absentStatus));

        const history = await localApp.inject({ method: 'GET', url: '/payouts?limit=1', headers: authorization });
        expect(history.statusCode).toBe(200);
        expect(history.headers['cache-control']).toBe('no-store');
        expect(responseJson(history).items).toHaveLength(1);
        expect(responseJson(history).items[0]).toMatchObject({ id: responseJson(thirdPayout).id, simulated: true });
        expect(responseJson(history).nextCursor).toEqual(expect.any(String));
        const nextPage = await localApp.inject({
          method: 'GET',
          url: `/payouts?limit=1&cursor=${encodeURIComponent(responseJson(history).nextCursor)}`,
          headers: authorization,
        });
        expect(responseJson(nextPage).items).toHaveLength(1);
        expect(responseJson(nextPage).items[0].id).toBe(responseJson(secondPayout).id);
        expect(responseJson(nextPage).items[0].id).not.toBe(responseJson(history).items[0].id);
        for (const url of ['/payouts?limit=0', '/payouts?limit=101', '/payouts?cursor=AAAA', `/payouts?playerId=${otherPlayerId}`]) {
          expect((await localApp.inject({ method: 'GET', url, headers: authorization })).statusCode).toBe(400);
        }
        expect((await localApp.inject({ method: 'GET', url: '/payouts/not-a-uuid', headers: authorization })).statusCode).toBe(400);

        const insufficient = await localApp.inject({
          method: 'POST', url: '/payouts',
          headers: { ...authorization, 'idempotency-key': randomUUID() }, payload: { amount: 701 },
        });
        expect(insufficient.statusCode).toBe(402);
        expect(responseJson(insufficient)).toMatchObject({ error: { code: 'INSUFFICIENT_FUNDS' } });
        const logs = capturedLogs.join('\n');
        expect(logs).toContain('financial.payout.requested');
        expect(logs).toContain('financial.payout.replayed');
        expect(logs).toContain('financial.payout.conflict');
        for (const sensitive of [idempotencyKey, playerId, otherPlayerId, '"amount"']) {
          expect(logs).not.toContain(sensitive);
        }
      } finally {
        await cleanWallet(playerId);
        await cleanWallet(otherPlayerId);
      }
    });

    test('top-ups use only the authenticated player and replay or conflict by Idempotency-Key', async () => {
      const playerId = randomUUID();
      const otherPlayerId = randomUUID();
      const idempotencyKey = randomUUID();
      try {
        await localService.ensureWallet(otherPlayerId);
        const authorization = authenticatedAs(playerId);
        const headers = { ...authorization, 'idempotency-key': idempotencyKey };
        const forgedTarget = await localApp.inject({
          method: 'POST', url: '/wallet/top-ups', headers, payload: { amount: 500, playerId: otherPlayerId },
        });
        expect(forgedTarget.statusCode).toBe(400);

        const missingKey = await localApp.inject({
          method: 'POST', url: '/wallet/top-ups', headers: authorization, payload: { amount: 500 },
        });
        expect(missingKey.statusCode).toBe(400);
        const malformedKey = await localApp.inject({
          method: 'POST', url: '/wallet/top-ups',
          headers: { ...authorization, 'idempotency-key': 'not-a-uuid' }, payload: { amount: 500 },
        });
        expect(malformedKey.statusCode).toBe(400);
        const unsafeAmount = await localApp.inject({
          method: 'POST', url: '/wallet/top-ups', headers,
          payload: { amount: Number.MAX_SAFE_INTEGER + 1 },
        });
        expect(unsafeAmount.statusCode).toBe(400);
        const oversized = await localApp.inject({
          method: 'POST', url: '/wallet/top-ups',
          headers: { ...authorization, 'idempotency-key': randomUUID() },
          payload: { amount: 1, extra: 'x'.repeat(16 * 1024) },
        });
        expect(oversized.statusCode).toBe(413);
        expect(responseJson(oversized)).toMatchObject({ error: { code: 'PAYLOAD_TOO_LARGE' } });
        const first = await localApp.inject({ method: 'POST', url: '/wallet/top-ups', headers, payload: { amount: 500 } });
        const replay = await localApp.inject({ method: 'POST', url: '/wallet/top-ups', headers, payload: { amount: 500 } });
        const conflict = await localApp.inject({ method: 'POST', url: '/wallet/top-ups', headers, payload: { amount: 501 } });

        expect(first.statusCode).toBe(201);
        expect(responseJson(first)).toMatchObject({ transactionId: expect.any(String), balance: 500, currency: 'USD' });
        expect(responseJson(replay)).toEqual(responseJson(first));
        expect(replay.statusCode).toBe(201);
        expect(conflict.statusCode).toBe(409);
        expect(await localService.getBalance(playerId)).toEqual({ playerId, balanceCents: 500n });
        expect(await localService.getBalance(otherPlayerId)).toEqual({ playerId: otherPlayerId, balanceCents: 0n });
        expect(await connection.db.select().from(walletLedgerEntries).where(eq(walletLedgerEntries.playerId, playerId))).toHaveLength(1);
        expect(await connection.db.select().from(financialOperations).where(eq(financialOperations.playerId, playerId))).toHaveLength(1);
        expect(await connection.db.select().from(financialOperations).where(eq(financialOperations.playerId, otherPlayerId))).toHaveLength(0);
      } finally {
        await cleanWallet(playerId);
        await cleanWallet(otherPlayerId);
      }
    });

    test('rejects a top-up that would exceed the safe balance without changing wallet or ledger', async () => {
      const playerId = randomUUID();
      const idempotencyKey = randomUUID();
      const nearLimit = 9_007_199_254_740_986n;
      try {
        await localService.ensureWallet(playerId);
        await connection.db.update(wallets).set({ balanceCents: nearLimit }).where(eq(wallets.playerId, playerId));
        const headers = { ...authenticatedAs(playerId), 'idempotency-key': idempotencyKey };
        const first = await localApp.inject({ method: 'POST', url: '/wallet/top-ups', headers, payload: { amount: 6 } });
        const replay = await localApp.inject({ method: 'POST', url: '/wallet/top-ups', headers, payload: { amount: 6 } });
        expect(first.statusCode).toBe(422);
        expect(replay.statusCode).toBe(422);
        expect(await localService.getBalance(playerId)).toEqual({ playerId, balanceCents: nearLimit });
        expect(await connection.db.select().from(walletLedgerEntries).where(eq(walletLedgerEntries.playerId, playerId))).toHaveLength(0);
      } finally {
        await cleanWallet(playerId);
      }
    });

    test('paginates only the authenticated player’s ledger with a stable cursor and validates query input', async () => {
      const playerId = randomUUID();
      const otherPlayerId = randomUUID();
      try {
        await localService.ensureWallet(playerId);
        await localService.ensureWallet(otherPlayerId);
        for (const amount of [100, 200, 300]) {
          await localService.topUp({ playerId, amount, idempotencyKey: randomUUID() });
        }
        await localService.topUp({ playerId: otherPlayerId, amount: 999, idempotencyKey: randomUUID() });

        const headers = authenticatedAs(playerId);
        const first = await app.inject({ method: 'GET', url: '/wallet/transactions?limit=2', headers });
        expect(first.statusCode).toBe(200);
        const firstPage = responseJson(first);
        expect(firstPage.items).toHaveLength(2);
        expect(firstPage.nextCursor).toEqual(expect.any(String));
        expect(firstPage.items.map((entry: { amountCents: number }) => entry.amountCents)).toEqual([300, 200]);
        expect(firstPage.items.every((entry: Record<string, unknown>) => !('playerId' in entry))).toBe(true);

        const second = await app.inject({
          method: 'GET',
          url: `/wallet/transactions?limit=2&cursor=${encodeURIComponent(firstPage.nextCursor)}`,
          headers,
        });
        const secondPage = responseJson(second);
        expect(second.statusCode).toBe(200);
        expect(secondPage.items).toHaveLength(1);
        expect(secondPage.items.map((entry: { amountCents: number }) => entry.amountCents)).toEqual([100]);
        expect(secondPage.nextCursor).toBeNull();
        const itemIds = [
          ...firstPage.items.map((entry: { id: string }) => entry.id),
          ...secondPage.items.map((entry: { id: string }) => entry.id),
        ];
        expect(new Set(itemIds).size).toBe(3);

        for (const url of [
          '/wallet/transactions?limit=0',
          '/wallet/transactions?limit=101',
          '/wallet/transactions?cursor=AAAA',
          `/wallet/transactions?playerId=${otherPlayerId}`,
        ]) {
          expect((await app.inject({ method: 'GET', url, headers })).statusCode).toBe(400);
        }
        const defaultLimit = await app.inject({ method: 'GET', url: '/wallet/transactions', headers });
        expect(responseJson(defaultLimit).items).toHaveLength(3);
      } finally {
        await cleanWallet(playerId);
        await cleanWallet(otherPlayerId);
      }
    });

    test('accepts an HMAC-authenticated debit without browser auth and returns committed balance', async () => {
      const playerId = randomUUID();
      try {
        await service.ensureWallet(playerId);
        await service.topUp({ playerId, amount: 1_000, idempotencyKey: randomUUID() });
        const request = { txId: randomUUID(), playerId, amount: 275, betId: randomUUID(), roundId: randomUUID() };
        const rawBody = JSON.stringify(request);
        const response = await app.inject({ method: 'POST', url: '/wallet/debit', headers: signedHeaders(rawBody), payload: rawBody });

        expect(response.statusCode).toBe(200);
        expect(responseJson(response)).toEqual({ balance: 725 });
        expect(await service.getBalance(playerId)).toEqual({ playerId, balanceCents: 725n });
        expect(capturedLogs.join('\n')).toContain('wallet.debit.applied');
        expect(capturedLogs.join('\n')).not.toContain(playerId);
      } finally {
        await cleanWallet(playerId);
      }
    });

    test('credits cashout once and replays the committed result', async () => {
      const playerId = randomUUID();
      try {
        await service.ensureWallet(playerId);
        const request = { txId: randomUUID(), playerId, amount: 375, betId: randomUUID(), roundId: randomUUID() };
        const rawBody = JSON.stringify(request);
        const headers = signedHeaders(rawBody);
        const first = await app.inject({ method: 'POST', url: '/wallet/credit', headers, payload: rawBody });
        const replay = await app.inject({ method: 'POST', url: '/wallet/credit', headers, payload: rawBody });

        expect(first.statusCode).toBe(200);
        expect(responseJson(first)).toEqual({ balance: 375 });
        expect(replay.statusCode).toBe(200);
        expect(responseJson(replay)).toEqual({ balance: 375 });
        const entries = await connection.db.select().from(walletLedgerEntries).where(eq(walletLedgerEntries.playerId, playerId));
        expect(entries).toHaveLength(1);
        expect(capturedLogs.join('\n')).toContain('wallet.operation.replayed');
      } finally {
        await cleanWallet(playerId);
      }
    });

    test('persists insufficient debit and maps operation conflicts and missing wallets', async () => {
      const playerId = randomUUID();
      const unknownPlayerId = randomUUID();
      const debit = { txId: randomUUID(), playerId, amount: 100, betId: randomUUID(), roundId: randomUUID() };
      try {
        await service.ensureWallet(playerId);
        const rawDebit = JSON.stringify(debit);
        const declined = await app.inject({ method: 'POST', url: '/wallet/debit', headers: signedHeaders(rawDebit), payload: rawDebit });
        expect(declined.statusCode).toBe(402);
        expect(await service.getBalance(playerId)).toEqual({ playerId, balanceCents: 0n });
        expect(await connection.db.select().from(walletLedgerEntries).where(eq(walletLedgerEntries.playerId, playerId))).toHaveLength(0);

        const conflicting = JSON.stringify({ ...debit, amount: 101 });
        const conflict = await app.inject({ method: 'POST', url: '/wallet/debit', headers: signedHeaders(conflicting), payload: conflicting });
        expect(conflict.statusCode).toBe(409);

        const missingWallet = JSON.stringify({ ...debit, txId: randomUUID(), playerId: unknownPlayerId });
        const missing = await app.inject({ method: 'POST', url: '/wallet/debit', headers: signedHeaders(missingWallet), payload: missingWallet });
        expect(missing.statusCode).toBe(404);
        const [operation] = await connection.db.select().from(financialOperations).where(eq(financialOperations.engineTxId, debit.txId));
        expect(operation?.outcome).toBe('insufficient_funds');
        expect(capturedLogs.join('\n')).toContain('wallet.operation.conflict');
        expect(capturedLogs.join('\n')).not.toContain('"amount"');
        expect(capturedLogs.join('\n')).not.toContain(playerId);
      } finally {
        await cleanWallet(playerId);
      }
    });

    test('rejects invalid HMAC, missing headers, and timestamps outside ±60 seconds before database mutation', async () => {
      const playerId = randomUUID();
      try {
        await service.ensureWallet(playerId);
        const request = { txId: randomUUID(), playerId, amount: 1, betId: randomUUID(), roundId: randomUUID() };
        const rawBody = JSON.stringify(request);
        const timestamp = Math.floor(Date.now() / 1_000);
        const invalidSignature = 'signature-must-not-be-logged';
        const variants = [
          { headers: { 'content-type': 'application/json' }, payload: rawBody },
          { headers: { ...signedHeaders(rawBody), 'x-signature': invalidSignature }, payload: rawBody },
          { headers: signedHeaders(rawBody, String(timestamp - 90)), payload: rawBody },
          { headers: signedHeaders(rawBody, String(timestamp + 90)), payload: rawBody },
          { headers: signedHeaders(rawBody), payload: `${rawBody} ` },
        ];
        for (const variant of variants) {
          const response = await app.inject({ method: 'POST', url: '/wallet/debit', ...variant });
          expect(response.statusCode).toBe(401);
        }

        expect(await connection.db.select().from(financialOperations).where(eq(financialOperations.playerId, playerId))).toHaveLength(0);
        expect(await service.getBalance(playerId)).toEqual({ playerId, balanceCents: 0n });
        const logs = capturedLogs.join('\n');
        for (const sensitive of [webhookSecret, invalidSignature, rawBody, playerId, 'authorization', '"amount"']) {
          expect(logs).not.toContain(sensitive);
        }
      } finally {
        await cleanWallet(playerId);
      }
    });

    test('authenticates raw bytes before parsing JSON and rejects invalid payloads and media types', async () => {
      const validMalformedJson = '{"amount":';
      const invalidSignature = await app.inject({
        method: 'POST', url: '/wallet/credit',
        headers: { ...signedHeaders(validMalformedJson), 'x-signature': 'f'.repeat(64) }, payload: validMalformedJson,
      });
      expect(invalidSignature.statusCode).toBe(401);

      const malformed = await app.inject({
        method: 'POST', url: '/wallet/credit', headers: signedHeaders(validMalformedJson), payload: validMalformedJson,
      });
      expect(malformed.statusCode).toBe(400);
      const invalidShape = JSON.stringify({ txId: 'bad', playerId: 'bad', amount: 1, betId: 'b', roundId: 'r', player: 'extra' });
      const invalidPayload = await app.inject({
        method: 'POST', url: '/wallet/debit', headers: signedHeaders(invalidShape), payload: invalidShape,
      });
      expect(invalidPayload.statusCode).toBe(400);

      const unsupported = await app.inject({ method: 'POST', url: '/wallet/debit', payload: '{}' });
      expect(unsupported.statusCode).toBe(415);
    });

    test('rejects oversized bodies and unsafe cashout amounts without wallet mutation or sensitive logs', async () => {
      const playerId = randomUUID();
      const txId = randomUUID();
      const betId = randomUUID();
      const signatureMarker = 'unlogged-signature-marker';
      try {
        await service.ensureWallet(playerId);
        const oversized = await app.inject({
          method: 'POST', url: '/wallet/credit',
          headers: { 'content-type': 'application/json', 'x-timestamp': String(Math.floor(Date.now() / 1_000)), 'x-signature': signatureMarker },
          payload: JSON.stringify({ body: 'x'.repeat(16 * 1024) }),
        });
        expect(oversized.statusCode).toBe(413);

        const unsafeAmount = Number.MAX_SAFE_INTEGER + 1;
        const body = JSON.stringify({ txId, playerId, amount: unsafeAmount, betId, roundId: randomUUID() });
        const response = await app.inject({ method: 'POST', url: '/wallet/credit', headers: signedHeaders(body), payload: body });
        expect(response.statusCode).toBe(422);
        expect(await service.getBalance(playerId)).toEqual({ playerId, balanceCents: 0n });
        expect(await connection.db.select().from(financialOperations).where(eq(financialOperations.playerId, playerId))).toHaveLength(0);
        expect(await connection.db.select().from(walletLedgerEntries).where(eq(walletLedgerEntries.playerId, playerId))).toHaveLength(0);

        const logs = capturedLogs.join('\n');
        expect(logs).toContain('wallet.cashout.precision_incident');
        for (const sensitive of [webhookSecret, signatureMarker, String(unsafeAmount), playerId, '"balance"']) {
          expect(logs).not.toContain(sensitive);
        }
      } finally {
        await cleanWallet(playerId);
      }
    });
  });
}

describe('financial webhook controller error mapping', () => {
  test('returns 503 when the financial service cannot confirm persistence', async () => {
    const app = Fastify({ logger: false });
    const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
    const failingService = {
      debit: async () => { throw new FinancialServiceError('STORAGE_UNAVAILABLE'); },
      creditCashoutOnce: async () => { throw new FinancialServiceError('STORAGE_UNAVAILABLE'); },
    } as unknown as FinancialService;
    registerFinancialController({
      app,
      service: failingService,
      webhookSecret,
      walletTestTopupEnabled: false,
      payoutMockEnabled: false,
      requireUser: async () => { throw new UnauthenticatedError(); },
      logger,
    });
    await app.ready();
    try {
      const request = { txId: randomUUID(), playerId: randomUUID(), amount: 1, betId: randomUUID(), roundId: randomUUID() };
      const rawBody = JSON.stringify(request);
      const response = await app.inject({ method: 'POST', url: '/wallet/debit', headers: signedHeaders(rawBody), payload: rawBody });
      expect(response.statusCode).toBe(503);
    } finally {
      await app.close();
    }
  });

  test('returns a generic 503 when an authenticated payout request cannot confirm storage', async () => {
    const app = Fastify({ logger: false });
    const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
    const unavailableService = {
      ensureWallet: async () => { throw new FinancialServiceError('STORAGE_UNAVAILABLE'); },
    } as unknown as FinancialService;
    registerFinancialController({
      app,
      service: unavailableService,
      webhookSecret,
      walletTestTopupEnabled: false,
      payoutMockEnabled: true,
      requireUser: async () => ({ id: randomUUID(), name: 'Test', email: 'test@test.invalid' }),
      logger,
    });
    await app.ready();
    try {
      const response = await app.inject({
        method: 'POST', url: '/payouts',
        headers: { 'idempotency-key': randomUUID() }, payload: { amount: 100 },
      });
      expect(response.statusCode).toBe(503);
      expect(responseJson(response)).toEqual({
        error: { code: 'SERVICE_UNAVAILABLE', message: 'Financial service is unavailable' },
      });
    } finally {
      await app.close();
    }
  });
});
