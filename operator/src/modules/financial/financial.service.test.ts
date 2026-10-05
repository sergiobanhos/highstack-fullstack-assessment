import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq, inArray, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createDatabase } from '../../db';
import {
  financialOperations,
  payouts,
  walletLedgerEntries,
  wallets,
} from './financial.schema';
import { createFinancialService } from './financial.service';

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
  test.skip('financial service integration checks require TEST_DATABASE_URL', () => {});
} else if (!isDedicatedTestDatabase(testDatabaseUrl)) {
  test('TEST_DATABASE_URL must point to a dedicated database whose name contains "test"', () => {
    throw new Error('Refusing to run financial integration checks against a database not marked as test-only');
  });
} else {
  const connection = createDatabase(testDatabaseUrl);
  const service = createFinancialService({ db: connection.db });
  const migrationsFolder = fileURLToPath(new URL('../../../drizzle', import.meta.url));

  async function cleanWallet(playerId: string): Promise<void> {
    const operations = await connection.db
      .select({ id: financialOperations.id })
      .from(financialOperations)
      .where(eq(financialOperations.playerId, playerId));
    if (operations.length > 0) {
      await connection.db.delete(payouts).where(inArray(payouts.id, operations.map(({ id }) => id)));
    }
    await connection.db.delete(walletLedgerEntries).where(eq(walletLedgerEntries.playerId, playerId));
    await connection.db.delete(financialOperations).where(eq(financialOperations.playerId, playerId));
    await connection.db.delete(wallets).where(eq(wallets.playerId, playerId));
  }

  async function ledgerFor(playerId: string) {
    return connection.db
      .select()
      .from(walletLedgerEntries)
      .where(eq(walletLedgerEntries.playerId, playerId));
  }

  async function payoutsFor(playerId: string) {
    return connection.db
      .select({ id: payouts.id })
      .from(payouts)
      .innerJoin(financialOperations, eq(payouts.id, financialOperations.id))
      .where(eq(financialOperations.playerId, playerId));
  }

  async function ledgerNet(playerId: string): Promise<bigint> {
    const entries = await ledgerFor(playerId);
    return entries.reduce(
      (balance, entry) => balance + (entry.direction === 'credit' ? entry.amountCents : -entry.amountCents),
      0n,
    );
  }

  beforeAll(async () => {
    await connection.check();
    await migrate(connection.db, { migrationsFolder });
    await connection.checkSchema();
  });

  afterAll(async () => {
    await connection.close();
  });

  describe('financial service', () => {
    test('ensures a zero wallet idempotently and rejects unsafe amounts before persistence', async () => {
      const playerId = randomUUID();
      const txId = randomUUID();
      try {
        const first = await service.ensureWallet(playerId);
        const second = await service.ensureWallet(playerId);
        expect(first).toEqual({ playerId, balanceCents: 0n });
        expect(second).toEqual(first);
        await expect(service.debit({ txId, playerId, amount: Number.MAX_SAFE_INTEGER + 1 }))
          .rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
        await expect(service.topUp({ playerId, amount: 1.5, idempotencyKey: randomUUID() }))
          .rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
        const [operation] = await connection.db
          .select({ id: financialOperations.id })
          .from(financialOperations)
          .where(eq(financialOperations.engineTxId, txId));
        expect(operation).toBeUndefined();
        expect(await ledgerFor(playerId)).toHaveLength(0);
        expect(await ledgerNet(playerId)).toBe(0n);
      } finally {
        await cleanWallet(playerId);
      }
    });

    test('persists covered and insufficient debits with stable txId replay results', async () => {
      const playerId = randomUUID();
      const otherPlayerId = randomUUID();
      const debitTxId = randomUUID();
      const declineTxId = randomUUID();
      try {
        await service.ensureWallet(playerId);
        await service.ensureWallet(otherPlayerId);
        await service.topUp({ playerId, amount: 1_000, idempotencyKey: randomUUID() });

        const debit = await service.debit({
          txId: debitTxId,
          playerId,
          amount: 700,
          betId: 'bet-covered',
          roundId: 'round-covered',
        });
        const debitReplay = await service.debit({
          txId: debitTxId,
          playerId,
          amount: 700,
          betId: 'bet-covered',
          roundId: 'round-covered',
        });
        expect(debit).toMatchObject({ outcome: 'applied', balanceCents: 300n, replayed: false });
        expect(debitReplay).toMatchObject({
          operationId: debit.operationId,
          outcome: 'applied',
          balanceCents: 300n,
          replayed: true,
        });
        await expect(service.debit({
          txId: debitTxId,
          playerId,
          amount: 701,
          betId: 'bet-covered',
          roundId: 'round-covered',
        })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
        await expect(service.debit({
          txId: debitTxId,
          playerId: otherPlayerId,
          amount: 700,
          betId: 'bet-covered',
          roundId: 'round-covered',
        })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
        await expect(service.debit({
          txId: debitTxId,
          playerId,
          amount: 700,
          betId: 'different-bet',
          roundId: 'round-covered',
        })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
        await expect(service.creditCashoutOnce({
          txId: debitTxId,
          playerId,
          amount: 700,
          betId: 'bet-covered',
          roundId: 'round-covered',
          source: 'engine',
        })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

        const declined = await service.debit({ txId: declineTxId, playerId, amount: 500 });
        expect(declined).toMatchObject({ outcome: 'insufficient_funds', balanceCents: 300n });
        await service.topUp({ playerId, amount: 1_000, idempotencyKey: randomUUID() });
        const declinedReplay = await service.debit({ txId: declineTxId, playerId, amount: 500 });
        expect(declinedReplay).toMatchObject({
          operationId: declined.operationId,
          outcome: 'insufficient_funds',
          balanceCents: 300n,
          replayed: true,
        });

        const newAttempt = await service.debit({ txId: randomUUID(), playerId, amount: 500 });
        expect(newAttempt).toMatchObject({ outcome: 'applied', balanceCents: 800n });
        expect(await service.getBalance(playerId)).toEqual({ playerId, balanceCents: 800n });
        expect(await ledgerFor(playerId)).toHaveLength(4);
        expect(await ledgerNet(playerId)).toBe(800n);
      } finally {
        await cleanWallet(playerId);
        await cleanWallet(otherPlayerId);
      }
    });

    test('serializes concurrent debits and applies a duplicate txId only once', async () => {
      const playerId = randomUUID();
      try {
        await service.ensureWallet(playerId);
        await service.topUp({ playerId, amount: 1_000, idempotencyKey: randomUUID() });
        const differentTxResults = await Promise.all([
          service.debit({ txId: randomUUID(), playerId, amount: 700 }),
          service.debit({ txId: randomUUID(), playerId, amount: 700 }),
        ]);
        expect(differentTxResults.map((result) => result.outcome).sort()).toEqual([
          'applied',
          'insufficient_funds',
        ]);
        expect(await service.getBalance(playerId)).toEqual({ playerId, balanceCents: 300n });

        await service.topUp({ playerId, amount: 500, idempotencyKey: randomUUID() });
        const duplicateTxId = randomUUID();
        const duplicateResults = await Promise.all([
          service.debit({ txId: duplicateTxId, playerId, amount: 200, betId: 'parallel-bet' }),
          service.debit({ txId: duplicateTxId, playerId, amount: 200, betId: 'parallel-bet' }),
        ]);
        expect(duplicateResults.map((result) => result.balanceCents)).toEqual([600n, 600n]);
        expect(duplicateResults.filter((result) => result.replayed)).toHaveLength(1);
        expect(await service.getBalance(playerId)).toEqual({ playerId, balanceCents: 600n });
        expect(await ledgerFor(playerId)).toHaveLength(4);
        expect(await ledgerNet(playerId)).toBe(600n);
      } finally {
        await cleanWallet(playerId);
      }
    });

    test('reuses one cashout credit when webhook and reconciliation race or arrive out of order', async () => {
      const playerId = randomUUID();
      const otherPlayerId = randomUUID();
      const betId = randomUUID();
      const txId = randomUUID();
      try {
        await service.ensureWallet(playerId);
        await service.topUp({ playerId, amount: 50, idempotencyKey: randomUUID() });

        const [webhook, reconciliation] = await Promise.all([
          service.creditCashoutOnce({
            playerId,
            amount: 200,
            betId,
            roundId: 'cashout-round',
            source: 'engine',
            txId,
          }),
          service.creditCashoutOnce({
            playerId,
            amount: 200,
            betId,
            roundId: 'cashout-round',
            source: 'reconciliation',
          }),
        ]);
        expect(webhook).toMatchObject({ outcome: 'applied', balanceCents: 250n });
        expect(reconciliation).toMatchObject({
          operationId: webhook.operationId,
          outcome: 'applied',
          balanceCents: 250n,
        });
        expect([webhook.replayed, reconciliation.replayed].filter(Boolean)).toHaveLength(1);

        const [stored] = await connection.db
          .select()
          .from(financialOperations)
          .where(eq(financialOperations.businessKey, `cashout:${betId}`));
        expect(stored?.engineTxId).toBe(txId);
        expect(await ledgerFor(playerId)).toHaveLength(2);

        await expect(service.creditCashoutOnce({
          playerId,
          amount: 201,
          betId,
          roundId: 'cashout-round',
          source: 'engine',
          txId: randomUUID(),
        })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
        await service.ensureWallet(otherPlayerId);
        await expect(service.creditCashoutOnce({
          playerId: otherPlayerId,
          amount: 200,
          betId,
          roundId: 'cashout-round',
          source: 'engine',
          txId: randomUUID(),
        })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
        expect(await service.getBalance(playerId)).toEqual({ playerId, balanceCents: 250n });
        expect(await ledgerFor(playerId)).toHaveLength(2);
        expect(await ledgerNet(playerId)).toBe(250n);
      } finally {
        await cleanWallet(playerId);
        await cleanWallet(otherPlayerId);
      }
    });

    test('associates the webhook txId when reconciliation credits first and replays reconciliation after webhook', async () => {
      const playerId = randomUUID();
      const recoveryFirstBetId = randomUUID();
      const recoveryFirstTxId = randomUUID();
      const webhookFirstBetId = randomUUID();
      try {
        await service.ensureWallet(playerId);
        await service.topUp({ playerId, amount: 10, idempotencyKey: randomUUID() });

        const recoveredFirst = await service.creditCashoutOnce({
          playerId,
          amount: 20,
          betId: recoveryFirstBetId,
          source: 'reconciliation',
        });
        const lateWebhook = await service.creditCashoutOnce({
          playerId,
          amount: 20,
          betId: recoveryFirstBetId,
          source: 'engine',
          txId: recoveryFirstTxId,
        });
        expect(lateWebhook).toMatchObject({
          operationId: recoveredFirst.operationId,
          outcome: 'applied',
          balanceCents: 30n,
          replayed: true,
        });

        const webhookFirst = await service.creditCashoutOnce({
          playerId,
          amount: 40,
          betId: webhookFirstBetId,
          source: 'engine',
          txId: randomUUID(),
        });
        const reconciledAfterWebhook = await service.creditCashoutOnce({
          playerId,
          amount: 40,
          betId: webhookFirstBetId,
          source: 'reconciliation',
        });
        expect(reconciledAfterWebhook).toMatchObject({
          operationId: webhookFirst.operationId,
          outcome: 'applied',
          balanceCents: 70n,
          replayed: true,
        });

        const [storedRecovery] = await connection.db
          .select({ engineTxId: financialOperations.engineTxId })
          .from(financialOperations)
          .where(eq(financialOperations.businessKey, `cashout:${recoveryFirstBetId}`));
        expect(storedRecovery?.engineTxId).toBe(recoveryFirstTxId);
        expect(await ledgerFor(playerId)).toHaveLength(3);
        expect(await ledgerNet(playerId)).toBe(70n);
      } finally {
        await cleanWallet(playerId);
      }
    });

    test('finds all exact bet debits after the reservation timestamp without crossing player boundaries', async () => {
      const playerId = randomUUID();
      const otherPlayerId = randomUUID();
      const targetRound = 'lookup-target-round';
      const operationIds: Array<{ id: string; createdAt: string }> = [];
      try {
        await service.ensureWallet(playerId);
        await service.ensureWallet(otherPlayerId);
        await service.topUp({ playerId, amount: 40, idempotencyKey: randomUUID() });
        const earlier = await service.debit({
          txId: randomUUID(), playerId, amount: 20, betId: 'lookup-before', roundId: targetRound,
        });
        const boundary = await service.debit({
          txId: randomUUID(), playerId, amount: 20, betId: 'lookup-boundary', roundId: targetRound,
        });
        const insufficient = await service.debit({
          txId: randomUUID(), playerId, amount: 20, betId: 'lookup-insufficient', roundId: targetRound,
        });
        await service.topUp({ playerId, amount: 20, idempotencyKey: randomUUID() });
        const applied = await service.debit({
          txId: randomUUID(), playerId, amount: 20, betId: 'lookup-applied', roundId: targetRound,
        });
        await service.topUp({ playerId, amount: 100, idempotencyKey: randomUUID() });
        const wrongRound = await service.debit({
          txId: randomUUID(), playerId, amount: 20, betId: 'lookup-wrong-round', roundId: 'another-round',
        });
        const wrongAmount = await service.debit({
          txId: randomUUID(), playerId, amount: 19, betId: 'lookup-wrong-amount', roundId: targetRound,
        });
        const single = await service.debit({
          txId: randomUUID(), playerId, amount: 7, betId: 'lookup-single', roundId: 'single-candidate-round',
        });
        await service.topUp({ playerId: otherPlayerId, amount: 20, idempotencyKey: randomUUID() });
        const otherPlayer = await service.debit({
          txId: randomUUID(), playerId: otherPlayerId, amount: 20, betId: 'lookup-other-player', roundId: targetRound,
        });

        operationIds.push(
          { id: earlier.operationId, createdAt: '2026-01-01T00:00:00.000001Z' },
          { id: boundary.operationId, createdAt: '2026-01-01T00:00:00.000002Z' },
          { id: insufficient.operationId, createdAt: '2026-01-01T00:00:00.000003Z' },
          { id: applied.operationId, createdAt: '2026-01-01T00:00:00.000004Z' },
          { id: otherPlayer.operationId, createdAt: '2026-01-01T00:00:00.000005Z' },
          { id: wrongRound.operationId, createdAt: '2026-01-01T00:00:00.000006Z' },
          { id: wrongAmount.operationId, createdAt: '2026-01-01T00:00:00.000007Z' },
          { id: single.operationId, createdAt: '2026-01-01T00:00:00.000008Z' },
        );
        for (const operation of operationIds) {
          await connection.db.execute(sql`
            UPDATE financial_operations
            SET created_at = ${operation.createdAt}::timestamptz
            WHERE id = ${operation.id}::uuid
          `);
        }

        const afterReservation = await service.findBetDebitForCommand({
          playerId,
          roundId: targetRound,
          amount: 20,
          createdAt: '2026-01-01T00:00:00.000002Z',
        });
        expect(afterReservation).toEqual([
          { betId: 'lookup-insufficient', outcome: 'insufficient_funds' },
          { betId: 'lookup-applied', outcome: 'applied' },
        ]);

        const oneCandidate = await service.findBetDebitForCommand({
          playerId,
          roundId: 'single-candidate-round',
          amount: 7,
          createdAt: '2026-01-01T00:00:00.000007Z',
        });
        expect(oneCandidate).toEqual([{ betId: 'lookup-single', outcome: 'applied' }]);

        const noCandidates = await service.findBetDebitForCommand({
          playerId,
          roundId: 'missing-round',
          amount: 20,
          createdAt: '2026-01-01T00:00:00.000000Z',
        });
        expect(noCandidates).toEqual([]);

        const otherPlayerCandidates = await service.findBetDebitForCommand({
          playerId: otherPlayerId,
          roundId: targetRound,
          amount: 20,
          createdAt: '2026-01-01T00:00:00.000004Z',
        });
        expect(otherPlayerCandidates).toEqual([
          { betId: 'lookup-other-player', outcome: 'applied' },
        ]);
        await expect(service.findBetDebitForCommand({
          playerId,
          roundId: targetRound,
          amount: 20,
          createdAt: 'not-a-database-timestamp',
        })).rejects.toMatchObject({ code: 'INVALID_LOOKUP' });
      } finally {
        await cleanWallet(playerId);
        await cleanWallet(otherPlayerId);
      }
    });

    test('reports cashout credit only when the matching player ledger entry is persisted', async () => {
      const playerId = randomUUID();
      const otherPlayerId = randomUUID();
      const limitPlayerId = randomUUID();
      const betId = `cashout-status-${randomUUID()}`;
      const limitBetId = `cashout-limit-${randomUUID()}`;
      try {
        await service.ensureWallet(playerId);
        await service.ensureWallet(otherPlayerId);
        await service.ensureWallet(limitPlayerId);

        expect(await service.getCashoutCreditStatus({ playerId, betId })).toEqual({ status: 'pending' });
        await service.topUp({ playerId, amount: 100, idempotencyKey: randomUUID() });
        const credit = await service.creditCashoutOnce({
          playerId,
          amount: 50,
          betId,
          source: 'engine',
          txId: randomUUID(),
        });
        expect(await service.getCashoutCreditStatus({ playerId, betId })).toEqual({ status: 'credited' });
        expect(await service.getCashoutCreditStatus({ playerId: otherPlayerId, betId })).toEqual({ status: 'pending' });

        await connection.db.delete(walletLedgerEntries)
          .where(eq(walletLedgerEntries.operationId, credit.operationId));
        expect(await service.getCashoutCreditStatus({ playerId, betId })).toEqual({
          status: 'incident',
          reason: 'ledger_missing',
        });

        await service.topUp({
          playerId: limitPlayerId,
          amount: Number.MAX_SAFE_INTEGER,
          idempotencyKey: randomUUID(),
        });
        const limited = await service.creditCashoutOnce({
          playerId: limitPlayerId,
          amount: 1,
          betId: limitBetId,
          source: 'reconciliation',
        });
        expect(limited.outcome).toBe('balance_limit');
        expect(await service.getCashoutCreditStatus({ playerId: limitPlayerId, betId: limitBetId })).toEqual({
          status: 'incident',
          reason: 'balance_limit',
        });
      } finally {
        await cleanWallet(playerId);
        await cleanWallet(otherPlayerId);
        await cleanWallet(limitPlayerId);
      }
    });

    test('persists top-up idempotency and stable balance-limit refusals', async () => {
      const playerId = randomUUID();
      const topupKey = randomUUID();
      const limitKey = randomUUID();
      try {
        await service.ensureWallet(playerId);
        const [firstTopup, replayTopup] = await Promise.all([
          service.topUp({ playerId, amount: 100, idempotencyKey: topupKey }),
          service.topUp({ playerId, amount: 100, idempotencyKey: topupKey }),
        ]);
        expect([firstTopup.replayed, replayTopup.replayed].filter(Boolean)).toHaveLength(1);
        expect(firstTopup).toMatchObject({
          operationId: firstTopup.operationId,
          outcome: 'applied',
          balanceCents: 100n,
        });
        expect(replayTopup.operationId).toBe(firstTopup.operationId);
        expect(replayTopup.balanceCents).toBe(100n);
        await expect(service.topUp({ playerId, amount: 101, idempotencyKey: topupKey }))
          .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

        await service.topUp({
          playerId,
          amount: Number.MAX_SAFE_INTEGER - 100,
          idempotencyKey: randomUUID(),
        });
        const limited = await service.topUp({ playerId, amount: 1, idempotencyKey: limitKey });
        const limitedReplay = await service.topUp({ playerId, amount: 1, idempotencyKey: limitKey });
        expect(limited).toMatchObject({ outcome: 'balance_limit', balanceCents: BigInt(Number.MAX_SAFE_INTEGER) });
        expect(limitedReplay).toMatchObject({
          operationId: limited.operationId,
          outcome: 'balance_limit',
          balanceCents: BigInt(Number.MAX_SAFE_INTEGER),
          replayed: true,
        });
        expect(await service.getBalance(playerId)).toEqual({
          playerId,
          balanceCents: BigInt(Number.MAX_SAFE_INTEGER),
        });
        expect(await ledgerFor(playerId)).toHaveLength(2);
        expect(await ledgerNet(playerId)).toBe(BigInt(Number.MAX_SAFE_INTEGER));
      } finally {
        await cleanWallet(playerId);
      }
    });

    test('requests a payout once and keeps accepted and insufficient-funds retries stable', async () => {
      const playerId = randomUUID();
      const acceptedKey = randomUUID();
      const insufficientKey = randomUUID();
      try {
        await service.ensureWallet(playerId);
        await service.topUp({ playerId, amount: 1_000, idempotencyKey: randomUUID() });

        const first = await service.requestPayout({
          playerId, amount: 400, idempotencyKey: acceptedKey,
        });
        const replay = await service.requestPayout({
          playerId, amount: 400, idempotencyKey: acceptedKey,
        });
        await expect(service.requestPayout({
          playerId, amount: 401, idempotencyKey: acceptedKey,
        })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

        expect(first).toMatchObject({ outcome: 'applied', balanceCents: 600n, replayed: false });
        expect(first.payout).toMatchObject({
          id: first.operationId,
          amountCents: 400n,
          status: 'processing',
          completedAt: null,
        });
        expect(replay).toMatchObject({
          operationId: first.operationId,
          outcome: 'applied',
          replayed: true,
          payout: first.payout,
        });

        const insufficient = await service.requestPayout({
          playerId, amount: 601, idempotencyKey: insufficientKey,
        });
        const insufficientReplay = await service.requestPayout({
          playerId, amount: 601, idempotencyKey: insufficientKey,
        });
        expect(insufficient).toMatchObject({
          outcome: 'insufficient_funds', balanceCents: 600n, replayed: false, payout: null,
        });
        expect(insufficientReplay).toMatchObject({
          operationId: insufficient.operationId,
          outcome: 'insufficient_funds', balanceCents: 600n, replayed: true, payout: null,
        });
        expect(await service.getBalance(playerId)).toEqual({ playerId, balanceCents: 600n });
        expect(await payoutsFor(playerId)).toHaveLength(1);
        expect(await ledgerFor(playerId)).toHaveLength(2);
        expect(await ledgerNet(playerId)).toBe(600n);
      } finally {
        await cleanWallet(playerId);
      }
    });

    test('serializes concurrent payouts for a wallet and deduplicates a repeated key', async () => {
      const playerId = randomUUID();
      try {
        await service.ensureWallet(playerId);
        await service.topUp({ playerId, amount: 1_000, idempotencyKey: randomUUID() });
        const results = await Promise.all([
          service.requestPayout({ playerId, amount: 700, idempotencyKey: randomUUID() }),
          service.requestPayout({ playerId, amount: 700, idempotencyKey: randomUUID() }),
        ]);

        expect(results.map(({ outcome }) => outcome).sort()).toEqual(['applied', 'insufficient_funds']);
        const accepted = results.find(({ outcome }) => outcome === 'applied')!;
        expect(accepted.payout?.status).toBe('processing');
        expect(await service.getBalance(playerId)).toEqual({ playerId, balanceCents: 300n });
        expect(await payoutsFor(playerId)).toHaveLength(1);
        expect(await ledgerFor(playerId)).toHaveLength(2);
        expect(await ledgerNet(playerId)).toBe(300n);

        const key = randomUUID();
        await service.topUp({ playerId, amount: 500, idempotencyKey: randomUUID() });
        const repeated = await Promise.all([
          service.requestPayout({ playerId, amount: 200, idempotencyKey: key }),
          service.requestPayout({ playerId, amount: 200, idempotencyKey: key }),
        ]);
        expect(repeated.map(({ replayed }) => replayed).sort()).toEqual([false, true]);
        expect(repeated[0]?.operationId).toBe(repeated[1]?.operationId);
        expect(await service.getBalance(playerId)).toEqual({ playerId, balanceCents: 600n });
        expect(await payoutsFor(playerId)).toHaveLength(2);
        expect(await ledgerFor(playerId)).toHaveLength(4);
      } finally {
        await cleanWallet(playerId);
      }
    });

    test('rolls back wallet, operation, and ledger if payout persistence fails', async () => {
      const playerId = randomUUID();
      const idempotencyKey = randomUUID();
      const businessKey = `payout:${playerId}:${idempotencyKey}`;
      try {
        await service.ensureWallet(playerId);
        await service.topUp({ playerId, amount: 1_000, idempotencyKey: randomUUID() });
        await connection.db.execute(sql.raw(`
          CREATE OR REPLACE FUNCTION financial_test_reject_payout_insert()
          RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            RAISE EXCEPTION 'test-only payout rejection';
          END;
          $$
        `));
        await connection.db.execute(sql.raw(`
          CREATE TRIGGER financial_test_reject_payout_insert
          BEFORE INSERT ON payouts
          FOR EACH ROW EXECUTE FUNCTION financial_test_reject_payout_insert()
        `));

        await expect(service.requestPayout({
          playerId, amount: 400, idempotencyKey,
        })).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });

        expect(await service.getBalance(playerId)).toEqual({ playerId, balanceCents: 1_000n });
        expect(await connection.db.select().from(financialOperations)
          .where(eq(financialOperations.businessKey, businessKey))).toHaveLength(0);
        expect(await ledgerFor(playerId)).toHaveLength(1);
        expect(await payoutsFor(playerId)).toHaveLength(0);
      } finally {
        await connection.db.execute(sql.raw('DROP TRIGGER IF EXISTS financial_test_reject_payout_insert ON payouts'));
        await connection.db.execute(sql.raw('DROP FUNCTION IF EXISTS financial_test_reject_payout_insert()'));
        await cleanWallet(playerId);
      }
    });

    test('reads only owned payouts and pages history with a stable timestamp/id cursor', async () => {
      const playerId = randomUUID();
      const otherPlayerId = randomUUID();
      const ownPayouts = [] as Awaited<ReturnType<typeof service.requestPayout>>[];
      let otherPayout: Awaited<ReturnType<typeof service.requestPayout>> | undefined;
      try {
        await service.ensureWallet(playerId);
        await service.ensureWallet(otherPlayerId);
        await service.topUp({ playerId, amount: 700, idempotencyKey: randomUUID() });
        await service.topUp({ playerId: otherPlayerId, amount: 200, idempotencyKey: randomUUID() });
        for (const amount of [100, 200, 300]) {
          ownPayouts.push(await service.requestPayout({
            playerId, amount, idempotencyKey: randomUUID(),
          }));
        }
        otherPayout = await service.requestPayout({
          playerId: otherPlayerId, amount: 150, idempotencyKey: randomUUID(),
        });

        for (const [index, result] of ownPayouts.entries()) {
          await connection.db.update(financialOperations)
            .set({ createdAt: new Date(Date.UTC(2025, 0, 1, 0, 0, index)) })
            .where(eq(financialOperations.id, result.operationId));
        }

        const firstPage = await service.listPayouts(playerId, { limit: 2 });
        expect(firstPage.items).toHaveLength(2);
        expect(firstPage.hasMore).toBe(true);
        expect(firstPage.items.every(({ status }) => status === 'processing')).toBe(true);
        expect(firstPage.items.every(({ requestedAt }) => /\.\d{6}Z$/.test(requestedAt))).toBe(true);

        const cursorRecord = firstPage.items.at(-1)!;
        const insertedAfterPage = await service.requestPayout({
          playerId, amount: 50, idempotencyKey: randomUUID(),
        });
        const secondPage = await service.listPayouts(playerId, {
          limit: 2,
          before: { requestedAt: cursorRecord.requestedAt, id: cursorRecord.id },
        });
        expect(secondPage.items.map(({ id }) => id)).toEqual([ownPayouts[0]?.operationId]);
        expect(secondPage.items.some(({ id }) => id === insertedAfterPage.payout?.id)).toBe(false);
        expect(secondPage.hasMore).toBe(false);
        expect(firstPage.items.some(({ id }) => id === otherPayout?.payout?.id)).toBe(false);

        const ownStatus = await service.getPayout({
          playerId, payoutId: ownPayouts[0]!.operationId,
        });
        const foreignStatus = await service.getPayout({
          playerId, payoutId: otherPayout.payout!.id,
        });
        expect(ownStatus).toMatchObject({
          id: ownPayouts[0]!.operationId,
          amountCents: 100n,
          status: 'processing',
          completedAt: null,
        });
        expect(foreignStatus).toBeNull();
        expect(await service.getPayout({ playerId, payoutId: randomUUID() })).toBeNull();
        await expect(service.listPayouts(playerId, { limit: 101 })).rejects
          .toMatchObject({ code: 'INVALID_PAGE' });
        await expect(service.listPayouts(playerId, {
          limit: 10,
          before: { requestedAt: 'invalid', id: randomUUID() },
        })).rejects.toMatchObject({ code: 'INVALID_PAGE' });
      } finally {
        await cleanWallet(playerId);
        await cleanWallet(otherPlayerId);
      }
    });

    test('does not create a wallet or operation for an unknown engine player', async () => {
      const playerId = randomUUID();
      const txId = randomUUID();
      await expect(service.debit({ txId, playerId, amount: 1 }))
        .rejects.toMatchObject({ code: 'WALLET_NOT_FOUND' });
      const [wallet] = await connection.db
        .select({ playerId: wallets.playerId })
        .from(wallets)
        .where(eq(wallets.playerId, playerId));
      const [operation] = await connection.db
        .select({ id: financialOperations.id })
        .from(financialOperations)
        .where(eq(financialOperations.engineTxId, txId));
      expect(wallet).toBeUndefined();
      expect(operation).toBeUndefined();
    });

    test('paginates the player ledger by an exact stable timestamp and id cursor', async () => {
      const playerId = randomUUID();
      try {
        await service.ensureWallet(playerId);
        for (const amount of [10, 20, 30]) {
          await service.topUp({ playerId, amount, idempotencyKey: randomUUID() });
        }

        const seen: string[] = [];
        let before: { createdAt: string; id: string } | undefined;
        let hasMore = true;
        while (hasMore) {
          const page = await service.listEntries(playerId, { limit: 1, before });
          expect(page.items).toHaveLength(1);
          const item = page.items[0]!;
          seen.push(item.id);
          before = { createdAt: item.createdAt, id: item.id };
          hasMore = page.hasMore;
        }

        expect(new Set(seen).size).toBe(3);
        expect(seen).toHaveLength(3);
        await expect(service.listEntries(playerId, { limit: 101 })).rejects
          .toMatchObject({ code: 'INVALID_PAGE' });
      } finally {
        await cleanWallet(playerId);
      }
    });

    test('rolls back wallet, operation, and ledger together if ledger insertion fails', async () => {
      const playerId = randomUUID();
      const txId = randomUUID();
      const rollbackBetId = 'rollback-trigger-test';
      try {
        await service.ensureWallet(playerId);
        await service.topUp({ playerId, amount: 500, idempotencyKey: randomUUID() });
        await connection.db.execute(sql.raw(`
          CREATE OR REPLACE FUNCTION financial_test_reject_ledger_insert()
          RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            IF NEW.bet_id = '${rollbackBetId}' THEN
              RAISE EXCEPTION 'test-only ledger rejection';
            END IF;
            RETURN NEW;
          END;
          $$
        `));
        await connection.db.execute(sql.raw(`
          CREATE TRIGGER financial_test_reject_ledger_insert
          BEFORE INSERT ON wallet_ledger_entries
          FOR EACH ROW EXECUTE FUNCTION financial_test_reject_ledger_insert()
        `));

        await expect(service.debit({
          txId,
          playerId,
          amount: 200,
          betId: rollbackBetId,
        })).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });

        expect(await service.getBalance(playerId)).toEqual({ playerId, balanceCents: 500n });
        const [operation] = await connection.db
          .select({ id: financialOperations.id })
          .from(financialOperations)
          .where(eq(financialOperations.engineTxId, txId));
        expect(operation).toBeUndefined();
        expect(await ledgerFor(playerId)).toHaveLength(1);
        expect(await ledgerNet(playerId)).toBe(500n);
      } finally {
        await connection.db.execute(sql.raw(
          'DROP TRIGGER IF EXISTS financial_test_reject_ledger_insert ON wallet_ledger_entries',
        ));
        await connection.db.execute(sql.raw(
          'DROP FUNCTION IF EXISTS financial_test_reject_ledger_insert()',
        ));
        await cleanWallet(playerId);
      }
    });

    test('resolves a lost success response by replaying the same txId', async () => {
      const playerId = randomUUID();
      const txId = randomUUID();
      try {
        await service.ensureWallet(playerId);
        await service.topUp({ playerId, amount: 1_000, idempotencyKey: randomUUID() });

        await service.debit({ txId, playerId, amount: 300 }); // commit succeeds; caller loses the response
        const retry = await service.debit({ txId, playerId, amount: 300 });

        expect(retry).toMatchObject({ outcome: 'applied', balanceCents: 700n, replayed: true });
        expect(await service.getBalance(playerId)).toEqual({ playerId, balanceCents: 700n });
        expect(await ledgerFor(playerId)).toHaveLength(2);
        expect(await ledgerNet(playerId)).toBe(700n);
      } finally {
        await cleanWallet(playerId);
      }
    });
  });
}
