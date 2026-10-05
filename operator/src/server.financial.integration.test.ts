import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHmac, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config';
import { createDatabase } from './db';
import { authSessions, players } from './modules/auth/auth.schema';
import { financialOperations, walletLedgerEntries, wallets } from './modules/financial/financial.schema';
import { buildOperatorApp, checkOperatorReadiness, type OperatorApp } from './server';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const webhookSecret = 'operator-server-integration-webhook-secret';

function isDedicatedTestDatabase(databaseUrl: string): boolean {
  try {
    const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
    return /(^|[_-])test([_-]|$)/i.test(databaseName);
  } catch {
    return false;
  }
}

function signWebhook(rawBody: string): Record<string, string> {
  const timestamp = String(Math.floor(Date.now() / 1_000));
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
  test.skip('composed financial flow requires TEST_DATABASE_URL', () => {});
} else if (!isDedicatedTestDatabase(testDatabaseUrl)) {
  test('TEST_DATABASE_URL must point to a dedicated database whose name contains "test"', () => {
    throw new Error('Refusing to run server financial integration against a database not marked as test-only');
  });
} else {
  const connection = createDatabase(testDatabaseUrl);
  const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url));
  const config = loadConfig({
    DATABASE_URL: testDatabaseUrl,
    APP_ENV: 'local',
    WALLET_TEST_TOPUP_ENABLED: 'true',
    ENGINE_WEBHOOK_SECRET: webhookSecret,
    LOG_LEVEL: 'error',
    AUTH_SESSION_TTL_SECONDS: '3600',
  });

  describe('composed operator financial flow', () => {
    beforeAll(async () => {
      await connection.check();
      await migrate(connection.db, { migrationsFolder });
      await connection.checkSchema();
    });

    afterAll(async () => {
      await connection.close();
    });

    test('composes auth, wallet, HMAC callbacks, health, readiness, and game routes', async () => {
      const email = `financial-e2e-${randomUUID()}@test.invalid`;
      let playerId: string | undefined;
      let operator: OperatorApp | undefined;
      try {
        operator = buildOperatorApp(config, { databaseConnection: connection });
        await operator.app.ready();
        await checkOperatorReadiness(operator);

        const registration = await operator.app.inject({
          method: 'POST',
          url: '/auth/register',
          payload: { name: 'Financial E2E', email, password: 'local financial e2e password' },
        });
        expect(registration.statusCode).toBe(201);
        playerId = responseJson(registration).user.id as string;

        const login = await operator.app.inject({
          method: 'POST',
          url: '/auth/login',
          payload: { email, password: 'local financial e2e password' },
        });
        expect(login.statusCode).toBe(200);
        const token = responseJson(login).token as string;
        const authorization = { authorization: `Bearer ${token}` };

        const health = await operator.app.inject({ method: 'GET', url: '/health' });
        const ready = await operator.app.inject({ method: 'GET', url: '/ready' });
        expect(health.statusCode).toBe(200);
        expect(ready.statusCode).toBe(200);
        expect(operator.app.hasRoute({ method: 'GET', url: '/game/events' })).toBe(true);
        expect(operator.app.hasRoute({ method: 'POST', url: '/wallet/top-ups' })).toBe(true);

        const initialWallet = await operator.app.inject({ method: 'GET', url: '/wallet', headers: authorization });
        expect(initialWallet.statusCode).toBe(200);
        expect(responseJson(initialWallet)).toEqual({ balance: 0, currency: 'USD' });

        const topUp = await operator.app.inject({
          method: 'POST',
          url: '/wallet/top-ups',
          headers: { ...authorization, 'idempotency-key': randomUUID() },
          payload: { amount: 5_000 },
        });
        expect(topUp.statusCode).toBe(201);
        expect(responseJson(topUp)).toMatchObject({ balance: 5_000, currency: 'USD' });

        const betId = randomUUID();
        const roundId = randomUUID();
        const debitBody = JSON.stringify({ txId: randomUUID(), playerId, amount: 1_250, betId, roundId });
        const debit = await operator.app.inject({
          method: 'POST', url: '/wallet/debit', headers: signWebhook(debitBody), payload: debitBody,
        });
        expect(debit.statusCode).toBe(200);
        expect(responseJson(debit)).toEqual({ balance: 3_750 });

        const creditBody = JSON.stringify({ txId: randomUUID(), playerId, amount: 750, betId, roundId });
        const creditHeaders = signWebhook(creditBody);
        const credit = await operator.app.inject({
          method: 'POST', url: '/wallet/credit', headers: creditHeaders, payload: creditBody,
        });
        const duplicateCredit = await operator.app.inject({
          method: 'POST', url: '/wallet/credit', headers: creditHeaders, payload: creditBody,
        });
        expect(credit.statusCode).toBe(200);
        expect(duplicateCredit.statusCode).toBe(200);
        expect(responseJson(credit)).toEqual({ balance: 4_500 });
        expect(responseJson(duplicateCredit)).toEqual(responseJson(credit));

        const balance = await operator.app.inject({ method: 'GET', url: '/wallet', headers: authorization });
        const history = await operator.app.inject({ method: 'GET', url: '/wallet/transactions', headers: authorization });
        const historyItems = responseJson(history).items as Array<{
          direction: 'credit' | 'debit';
          amountCents: number;
          betId: string | null;
        }>;
        expect(balance.statusCode).toBe(200);
        expect(responseJson(balance)).toEqual({ balance: 4_500, currency: 'USD' });
        expect(history.statusCode).toBe(200);
        expect(historyItems).toHaveLength(3);
        expect(historyItems.filter((entry) => entry.betId === betId)).toHaveLength(2);
        const ledgerNet = historyItems.reduce(
          (amount, entry) => amount + (entry.direction === 'credit' ? entry.amountCents : -entry.amountCents),
          0,
        );
        expect(ledgerNet).toBe(4_500);
        expect(login.body).not.toContain(webhookSecret);
        expect(history.body).not.toContain(token);
      } finally {
        if (playerId) {
          await connection.db.delete(walletLedgerEntries).where(eq(walletLedgerEntries.playerId, playerId));
          await connection.db.delete(financialOperations).where(eq(financialOperations.playerId, playerId));
          await connection.db.delete(wallets).where(eq(wallets.playerId, playerId));
          await connection.db.delete(authSessions).where(eq(authSessions.playerId, playerId));
          await connection.db.delete(players).where(eq(players.id, playerId));
        }
        await operator?.app.close();
      }
    });
  });
}
