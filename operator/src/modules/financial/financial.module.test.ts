import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq, inArray, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadConfig, type Logger } from '../../config';
import { createDatabase } from '../../db';
import { UnauthenticatedError, type AuthModule } from '../auth/auth.module';
import { financialOperations, payouts, walletLedgerEntries, wallets } from './financial.schema';
import { createFinancialModule } from './financial.module';
import type { FinancialService } from './financial.service';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

function isDedicatedTestDatabase(databaseUrl: string): boolean {
  try {
    const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
    return /(^|[_-])test([_-]|$)/i.test(databaseName);
  } catch {
    return false;
  }
}

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

if (!testDatabaseUrl) {
  test.skip('financial module lifecycle checks require TEST_DATABASE_URL', () => {});
} else if (!isDedicatedTestDatabase(testDatabaseUrl)) {
  test('TEST_DATABASE_URL must point to a dedicated database whose name contains "test"', () => {
    throw new Error('Refusing to run financial module checks against a database not marked as test-only');
  });
} else {
  const connection = createDatabase(testDatabaseUrl);
  const migrationsFolder = fileURLToPath(new URL('../../../drizzle', import.meta.url));
  const config = loadConfig({
    DATABASE_URL: testDatabaseUrl,
    APP_ENV: 'local',
    ENGINE_WEBHOOK_SECRET: 'module-test-webhook-secret',
  });
  const loggerLines: string[] = [];
  const logger: Logger = {
    debug: (message, fields) => loggerLines.push(`${message} ${JSON.stringify(fields ?? {})}`),
    info: (message, fields) => loggerLines.push(`${message} ${JSON.stringify(fields ?? {})}`),
    warn: (message, fields) => loggerLines.push(`${message} ${JSON.stringify(fields ?? {})}`),
    error: (message, fields) => loggerLines.push(`${message} ${JSON.stringify(fields ?? {})}`),
  };
  const auth: Pick<AuthModule, 'requireUser'> = {
    async requireUser() { throw new UnauthenticatedError(); },
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

  function moduleApp(payoutMockEnabled: boolean): { app: FastifyInstance; service: FinancialService } {
    const app = Fastify({ logger: false });
    const service = createFinancialModule({
      app, db: connection.db, config, logger, auth, payoutMockEnabled,
    });
    return { app, service };
  }

  beforeAll(async () => {
    await connection.check();
    await migrate(connection.db, { migrationsFolder });
    await connection.checkSchema();
  });

  afterAll(async () => {
    await connection.close();
  });

  describe('financial payout processor lifecycle', () => {
    test('processes persisted due payouts immediately on startup after a restart', async () => {
      const playerId = randomUUID();
      let app: FastifyInstance | undefined;
      try {
        const seed = moduleApp(false);
        await seed.service.ensureWallet(playerId);
        await seed.service.topUp({ playerId, amount: 500, idempotencyKey: randomUUID() });
        const payout = await seed.service.requestPayout({
          playerId, amount: 200, idempotencyKey: randomUUID(),
        });
        await connection.db.update(payouts)
          .set({ completeAfter: sql`now() - interval '1 second'` })
          .where(eq(payouts.id, payout.operationId));

        const restarted = moduleApp(true);
        app = restarted.app;
        await app.ready();

        expect(await restarted.service.getPayout({ playerId, payoutId: payout.operationId }))
          .toMatchObject({ status: 'done', completedAt: expect.any(String) });
        expect(loggerLines.some((line) => line.includes('financial.payout.completed'))).toBe(true);
      } finally {
        await app?.close();
        await cleanWallet(playerId);
      }
    });

    test('retries a failed database sweep on a later interval', async () => {
      const playerId = randomUUID();
      let app: FastifyInstance | undefined;
      let triggerInstalled = false;
      try {
        const seed = moduleApp(false);
        await seed.service.ensureWallet(playerId);
        await seed.service.topUp({ playerId, amount: 500, idempotencyKey: randomUUID() });
        const payout = await seed.service.requestPayout({
          playerId, amount: 200, idempotencyKey: randomUUID(),
        });
        await connection.db.update(payouts)
          .set({ completeAfter: sql`now() - interval '1 second'` })
          .where(eq(payouts.id, payout.operationId));
        await connection.db.execute(sql.raw(`
          CREATE OR REPLACE FUNCTION financial_test_reject_payout_completion()
          RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            IF NEW.status = 'done' THEN RAISE EXCEPTION 'temporary payout completion failure'; END IF;
            RETURN NEW;
          END $$
        `));
        await connection.db.execute(sql.raw(`
          CREATE TRIGGER financial_test_reject_payout_completion
          BEFORE UPDATE ON payouts FOR EACH ROW
          EXECUTE FUNCTION financial_test_reject_payout_completion()
        `));
        triggerInstalled = true;

        const worker = moduleApp(true);
        app = worker.app;
        await app.ready();
        expect(await worker.service.getPayout({ playerId, payoutId: payout.operationId }))
          .toMatchObject({ status: 'processing', completedAt: null });
        expect(loggerLines.some((line) => line.includes('financial.payout.processing_failed'))).toBe(true);

        await connection.db.execute(sql.raw('DROP TRIGGER financial_test_reject_payout_completion ON payouts'));
        triggerInstalled = false;
        await connection.db.execute(sql.raw('DROP FUNCTION financial_test_reject_payout_completion()'));

        let current = await worker.service.getPayout({ playerId, payoutId: payout.operationId });
        for (let attempt = 0; current?.status !== 'done' && attempt < 20; attempt += 1) {
          await wait(100);
          current = await worker.service.getPayout({ playerId, payoutId: payout.operationId });
        }
        expect(current).toMatchObject({ status: 'done', completedAt: expect.any(String) });
      } finally {
        await app?.close();
        if (triggerInstalled) {
          await connection.db.execute(sql.raw('DROP TRIGGER IF EXISTS financial_test_reject_payout_completion ON payouts'));
          await connection.db.execute(sql.raw('DROP FUNCTION IF EXISTS financial_test_reject_payout_completion()'));
        }
        await cleanWallet(playerId);
      }
    });

    test('leaves due payouts untouched when disabled and clears the worker on close', async () => {
      const playerId = randomUUID();
      let app: FastifyInstance | undefined;
      try {
        const seed = moduleApp(false);
        await seed.service.ensureWallet(playerId);
        await seed.service.topUp({ playerId, amount: 500, idempotencyKey: randomUUID() });
        const payout = await seed.service.requestPayout({
          playerId, amount: 200, idempotencyKey: randomUUID(),
        });
        await connection.db.update(payouts)
          .set({ completeAfter: sql`now() - interval '1 second'` })
          .where(eq(payouts.id, payout.operationId));

        const disabled = moduleApp(false);
        app = disabled.app;
        await app.ready();
        await wait(600);
        expect(await disabled.service.getPayout({ playerId, payoutId: payout.operationId }))
          .toMatchObject({ status: 'processing', completedAt: null });
        await app.close();
        app = undefined;

        const worker = moduleApp(true);
        app = worker.app;
        await app.ready();
        await app.close();
        app = undefined;
        await connection.db.update(payouts)
          .set({ status: 'processing', completedAt: null })
          .where(eq(payouts.id, payout.operationId));
        await wait(600);
        expect(await worker.service.getPayout({ playerId, payoutId: payout.operationId }))
          .toMatchObject({ status: 'processing', completedAt: null });
      } finally {
        await app?.close();
        await cleanWallet(playerId);
      }
    });
  });
}
