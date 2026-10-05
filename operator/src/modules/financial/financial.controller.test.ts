import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { createHmac, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { fileURLToPath } from 'node:url';
import { loadConfig, type Logger } from '../../config';
import { createDatabase } from '../../db';
import { financialOperations, walletLedgerEntries, wallets } from './financial.schema';
import { createFinancialModule } from './financial.module';
import { FinancialServiceError, type FinancialService } from './financial.service';
import { registerFinancialController } from './financial.controller';

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
  const capturedLogs: string[] = [];
  const logger: Logger = {
    debug: (message, fields) => capturedLogs.push(`${message} ${JSON.stringify(fields ?? {})}`),
    info: (message, fields) => capturedLogs.push(`${message} ${JSON.stringify(fields ?? {})}`),
    warn: (message, fields) => capturedLogs.push(`${message} ${JSON.stringify(fields ?? {})}`),
    error: (message, fields) => capturedLogs.push(`${message} ${JSON.stringify(fields ?? {})}`),
  };

  async function cleanWallet(playerId: string): Promise<void> {
    await connection.db.delete(walletLedgerEntries).where(eq(walletLedgerEntries.playerId, playerId));
    await connection.db.delete(financialOperations).where(eq(financialOperations.playerId, playerId));
    await connection.db.delete(wallets).where(eq(wallets.playerId, playerId));
  }

  describe('financial webhook REST controller', () => {
    let app: FastifyInstance;
    let service: FinancialService;

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
      service = createFinancialModule({ app, db: connection.db, config, logger });
      await app.ready();
    });

    afterEach(() => {
      capturedLogs.length = 0;
    });

    afterAll(async () => {
      await app.close();
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
    registerFinancialController({ app, service: failingService, webhookSecret, logger });
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
});
