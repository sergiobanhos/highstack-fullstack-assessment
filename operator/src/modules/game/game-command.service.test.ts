import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createDatabase } from '../../db';
import { createFinancialService } from '../financial/financial.service';
import type { PlaceBetInput, PlaceBetResult, CrashsimBet } from './crashsim-http.client';
import { CrashsimHttpError } from './crashsim-http.client';
import { gameBets, gameCommands } from './game.schema';
import { createGameCommandService } from './game-command.service';
import type { Logger } from '../../config';
import type { OperatorSnapshot } from './round-state';
import { financialOperations, walletLedgerEntries, wallets } from '../financial/financial.schema';

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
  test.skip('game command integration checks require TEST_DATABASE_URL', () => {});
} else if (!isDedicatedTestDatabase(testDatabaseUrl)) {
  test('TEST_DATABASE_URL must point to a dedicated database whose name contains "test"', () => {
    throw new Error('Refusing to run game command integration checks against a database not marked as test-only');
  });
} else {
  const connection = createDatabase(testDatabaseUrl);
  const financial = createFinancialService({ db: connection.db });
  const migrationsFolder = fileURLToPath(new URL('../../../drizzle', import.meta.url));
  const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

  type EngineOverrides = {
    createSession?: (playerId: string) => Promise<{ sessionId: string }>;
    placeBet?: (input: PlaceBetInput) => Promise<PlaceBetResult>;
    getBet?: (input: { betId: string; playerId?: string; roundId?: string }) => Promise<CrashsimBet>;
  };

  function connectedSnapshot(roundId = 'round-current'): OperatorSnapshot {
    return {
      connection: 'connected',
      state: {
        roundId,
        state: 'betting',
        seq: 12,
        serverSeedHash: null,
        bettingEndsAt: Date.now() + 10_000,
        startedAt: null,
        multiplier: null,
        crashPoint: null,
        serverSeed: null,
      },
    };
  }

  function createHarness(overrides: EngineOverrides = {}, snapshot = connectedSnapshot()) {
    let createSessionCalls = 0;
    let placeBetCalls = 0;
    let getBetCalls = 0;
    const postedInputs: PlaceBetInput[] = [];
    const engine = {
      async createSession(playerId: string) {
        createSessionCalls += 1;
        if (overrides.createSession) return overrides.createSession(playerId);
        return { sessionId: 'server-session-' + String(createSessionCalls) };
      },
      async placeBet(input: PlaceBetInput) {
        placeBetCalls += 1;
        postedInputs.push(input);
        if (overrides.placeBet) return overrides.placeBet(input);
        return { betId: 'bet-' + String(placeBetCalls), status: 'active' as const };
      },
      async getBet(input: { betId: string; playerId?: string; roundId?: string }) {
        getBetCalls += 1;
        if (overrides.getBet) return overrides.getBet(input);
        return {
          betId: input.betId,
          playerId: input.playerId ?? randomUUID(),
          roundId: input.roundId ?? 'round-current',
          amount: 100,
          status: 'active' as const,
          multiplierHundredths: null,
          payoutCents: null,
          payoutPrecision: 'not_provided' as const,
        };
      },
    };
    const service = createGameCommandService({
      db: connection.db,
      financial,
      engine,
      stream: { getSnapshot: () => snapshot },
      logger,
    });
    return {
      service,
      engineStats: () => ({ createSessionCalls, placeBetCalls, getBetCalls, postedInputs }),
    };
  }

  async function cleanPlayer(playerId: string): Promise<void> {
    await connection.db.delete(gameBets).where(eq(gameBets.playerId, playerId));
    await connection.db.delete(gameCommands).where(eq(gameCommands.playerId, playerId));
    await connection.db.delete(walletLedgerEntries).where(eq(walletLedgerEntries.playerId, playerId));
    await connection.db.delete(financialOperations).where(eq(financialOperations.playerId, playerId));
    await connection.db.delete(wallets).where(eq(wallets.playerId, playerId));
  }

  async function withPlayer(run: (playerId: string) => Promise<void>): Promise<void> {
    const playerId = randomUUID();
    try {
      await run(playerId);
    } finally {
      await cleanPlayer(playerId);
    }
  }

  async function fund(playerId: string, amount = 10_000): Promise<void> {
    await financial.ensureWallet(playerId);
    await financial.topUp({ playerId, amount, idempotencyKey: randomUUID() });
  }

  async function seedRejectedCommands(playerId: string, count: number): Promise<void> {
    const start = Date.now() - count * 1_000;
    await connection.db.insert(gameCommands).values(Array.from({ length: count }, (_, index) => ({
      playerId,
      commandType: 'bet' as const,
      idempotencyKey: randomUUID(),
      requestHash: 'a'.repeat(64),
      roundId: 'history-round-' + String(index),
      amountCents: 100n,
      status: 'rejected' as const,
      resultCode: 'insufficient_funds',
      createdAt: new Date(start + index * 1_000),
      resolvedAt: new Date(start + index * 1_000),
    })));
  }

  function activeBet(input: PlaceBetInput, betId: string, status: CrashsimBet['status'] = 'active'): CrashsimBet {
    return {
      betId,
      playerId: input.playerId,
      roundId: input.roundId,
      amount: input.amount,
      status,
      autoCashout: input.autoCashout,
      multiplierHundredths: null,
      payoutCents: null,
      payoutPrecision: 'not_provided',
    };
  }

  beforeAll(async () => {
    await connection.check();
    await migrate(connection.db, { migrationsFolder });
    await connection.checkSchema();
  });

  afterAll(async () => {
    await connection.close();
  });

  describe('game command service', () => {
    test('ensures the wallet before creating and reuses a server-side session', async () => {
      await withPlayer(async (playerId) => {
        const createdFor: string[] = [];
        const harness = createHarness({
          async createSession(id) {
            createdFor.push(id);
            expect(await financial.getBalance(id)).toEqual({ playerId: id, balanceCents: 0n });
            return { sessionId: 'private-session-value' };
          },
        });

        expect(await harness.service.createSession(playerId)).toEqual({ status: 'ready' });
        expect(await harness.service.createSession(playerId)).toEqual({ status: 'ready' });
        expect(createdFor).toEqual([playerId]);
        expect(harness.engineStats().createSessionCalls).toBe(1);
      });
    });

    test('blocks bets while disconnected or outside the current betting round', async () => {
      await withPlayer(async (playerId) => {
        const snapshot = connectedSnapshot();
        snapshot.connection = 'reconnecting';
        const harness = createHarness({}, snapshot);
        await expect(harness.service.placeBet({
          playerId,
          idempotencyKey: randomUUID(),
          roundId: 'round-current',
          amount: 100,
        })).rejects.toMatchObject({ code: 'GAME_NOT_SYNCHRONIZED' });
        expect(harness.engineStats()).toMatchObject({ createSessionCalls: 0, placeBetCalls: 0 });
      });

      await withPlayer(async (playerId) => {
        const harness = createHarness({}, connectedSnapshot('round-other'));
        await expect(harness.service.placeBet({
          playerId,
          idempotencyKey: randomUUID(),
          roundId: 'round-current',
          amount: 100,
        })).rejects.toMatchObject({ code: 'ROUND_NOT_ACCEPTING_BETS' });
        expect(harness.engineStats()).toMatchObject({ createSessionCalls: 0, placeBetCalls: 0 });
      });
    });

    test('validates money and auto cashout before external effects', async () => {
      await withPlayer(async (playerId) => {
        const harness = createHarness();
        for (const amount of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, 1_000_000_001]) {
          await expect(harness.service.placeBet({
            playerId,
            idempotencyKey: randomUUID(),
            roundId: 'round-current',
            amount,
          })).rejects.toMatchObject({ code: 'INVALID_BET' });
        }
        for (const autoCashout of [1, 1.009, 1.011, 1_000_000.01]) {
          await expect(harness.service.placeBet({
            playerId,
            idempotencyKey: randomUUID(),
            roundId: 'round-current',
            amount: 100,
            autoCashout,
          })).rejects.toMatchObject({ code: 'INVALID_BET' });
        }
        expect(harness.engineStats()).toMatchObject({ createSessionCalls: 0, placeBetCalls: 0 });
      });
    });

    test('replays the same idempotency key and rejects a changed fingerprint', async () => {
      await withPlayer(async (playerId) => {
        const harness = createHarness();
        const input = {
          playerId,
          idempotencyKey: randomUUID(),
          roundId: 'round-current',
          amount: 350,
          autoCashout: 2.15,
        };
        const first = await harness.service.placeBet(input);
        const replay = await harness.service.placeBet(input);
        expect(replay).toEqual(first);
        expect(first.betCommandStatus).toBe('accepted');
        expect(harness.engineStats().placeBetCalls).toBe(1);
        await expect(harness.service.placeBet({ ...input, amount: 351 }))
          .rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
        expect(harness.engineStats().placeBetCalls).toBe(1);
        expect(harness.engineStats().postedInputs[0]).toMatchObject({ amount: 350, autoCashout: 2.15 });

        const crossTypeKey = randomUUID();
        await connection.db.insert(gameCommands).values({
          playerId,
          commandType: 'cashout',
          idempotencyKey: crossTypeKey,
          requestHash: '0'.repeat(64),
          betId: 'another-owned-bet',
          status: 'rejected',
        });
        await expect(harness.service.placeBet({ ...input, idempotencyKey: crossTypeKey }))
          .rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
        expect(harness.engineStats().placeBetCalls).toBe(1);
      });
    });

    test('serializes concurrent bets for the same player and round', async () => {
      await withPlayer(async (playerId) => {
        let signalEntered: () => void = () => {};
        let releasePost: () => void = () => {};
        const entered = new Promise<void>((resolve) => { signalEntered = resolve; });
        const postGate = new Promise<void>((resolve) => { releasePost = resolve; });
        const harness = createHarness({
          async placeBet() {
            signalEntered();
            await postGate;
            return { betId: 'concurrent-bet', status: 'active' };
          },
        });
        const first = harness.service.placeBet({
          playerId,
          idempotencyKey: randomUUID(),
          roundId: 'round-current',
          amount: 100,
        });
        await entered;
        await expect(harness.service.placeBet({
          playerId,
          idempotencyKey: randomUUID(),
          roundId: 'round-current',
          amount: 200,
        })).rejects.toMatchObject({ code: 'BET_OUTCOME_UNKNOWN' });
        releasePost();
        expect((await first).betCommandStatus).toBe('accepted');
        expect(harness.engineStats().placeBetCalls).toBe(1);
      });
    });

    test('persists a definitive insufficient funds response and allows a new key after top up', async () => {
      await withPlayer(async (playerId) => {
        let attempts = 0;
        const harness = createHarness({
          async placeBet() {
            attempts += 1;
            if (attempts === 1) throw new CrashsimHttpError('rejected', 402, 'insufficient_funds');
            return { betId: 'funded-bet', status: 'active' };
          },
        });
        const firstKey = randomUUID();
        const rejected = await harness.service.placeBet({
          playerId,
          idempotencyKey: firstKey,
          roundId: 'round-current',
          amount: 100,
        });
        expect(rejected).toMatchObject({ betCommandStatus: 'rejected', resultCode: 'insufficient_funds' });
        expect((await harness.service.placeBet({
          playerId,
          idempotencyKey: firstKey,
          roundId: 'round-current',
          amount: 100,
        })).betCommandStatus).toBe('rejected');
        await fund(playerId, 500);
        const accepted = await harness.service.placeBet({
          playerId,
          idempotencyKey: randomUUID(),
          roundId: 'round-current',
          amount: 100,
        });
        expect(accepted.betCommandStatus).toBe('accepted');
        expect(harness.engineStats().placeBetCalls).toBe(2);
      });
    });

    test('renews a definitely missing session and retries the bet once', async () => {
      await withPlayer(async (playerId) => {
        let attempts = 0;
        const harness = createHarness({
          async placeBet() {
            attempts += 1;
            if (attempts === 1) throw new CrashsimHttpError('session_not_found', 404, 'session_not_found');
            return { betId: 'after-refresh', status: 'active' };
          },
        });
        const result = await harness.service.placeBet({
          playerId,
          idempotencyKey: randomUUID(),
          roundId: 'round-current',
          amount: 100,
        });
        expect(result).toMatchObject({ betCommandStatus: 'accepted', betId: 'after-refresh' });
        expect(harness.engineStats()).toMatchObject({ createSessionCalls: 2, placeBetCalls: 2 });
      });
    });

    test('reconciles an ambiguous response only through one exact financial candidate and GET', async () => {
      await withPlayer(async (playerId) => {
        await fund(playerId);
        let postedBet: CrashsimBet | undefined;
        const harness = createHarness({
          async placeBet(input) {
            const betId = 'timed-out-bet';
            await financial.debit({ txId: randomUUID(), playerId, amount: input.amount, betId, roundId: input.roundId });
            postedBet = activeBet(input, betId);
            throw new CrashsimHttpError('unknown');
          },
          async getBet({ betId }) {
            expect(betId).toBe('timed-out-bet');
            return postedBet!;
          },
        });

        const result = await harness.service.placeBet({
          playerId,
          idempotencyKey: randomUUID(),
          roundId: 'round-current',
          amount: 250,
        });
        expect(result).toMatchObject({ betCommandStatus: 'accepted', betId: 'timed-out-bet' });
        expect(harness.engineStats()).toMatchObject({ placeBetCalls: 1, getBetCalls: 1 });
      });
    });

    test('keeps an ambiguous command unknown, blocks another key, and never repeats POST', async () => {
      await withPlayer(async (playerId) => {
        const harness = createHarness({
          async placeBet() { throw new CrashsimHttpError('unknown'); },
        });
        const input = {
          playerId,
          idempotencyKey: randomUUID(),
          roundId: 'round-current',
          amount: 100,
        };
        expect((await harness.service.placeBet(input)).betCommandStatus).toBe('unknown');
        expect((await harness.service.placeBet(input)).betCommandStatus).toBe('unknown');
        await expect(harness.service.placeBet({ ...input, idempotencyKey: randomUUID() }))
          .rejects.toMatchObject({ code: 'BET_OUTCOME_UNKNOWN' });
        expect(harness.engineStats()).toMatchObject({ placeBetCalls: 1, getBetCalls: 0 });
      });
    });

    test('does not guess between multiple debits and does not compensate an applied debit for a rejected bet', async () => {
      await withPlayer(async (playerId) => {
        await fund(playerId);
        const harness = createHarness({
          async placeBet(input) {
            await Promise.all(['candidate-one', 'candidate-two'].map((betId) => financial.debit({
              txId: randomUUID(), playerId, amount: input.amount, betId, roundId: input.roundId,
            })));
            throw new CrashsimHttpError('unknown');
          },
        });
        const result = await harness.service.placeBet({
          playerId,
          idempotencyKey: randomUUID(),
          roundId: 'round-current',
          amount: 100,
        });
        expect(result).toMatchObject({ betCommandStatus: 'unknown', resultCode: 'debit_ambiguous' });
        expect(harness.engineStats()).toMatchObject({ placeBetCalls: 1, getBetCalls: 0 });
      });

      await withPlayer(async (playerId) => {
        await fund(playerId, 1_000);
        let betInput: PlaceBetInput | undefined;
        const harness = createHarness({
          async placeBet(input) {
            betInput = input;
            await financial.debit({
              txId: randomUUID(), playerId, amount: input.amount, betId: 'rejected-after-debit', roundId: input.roundId,
            });
            throw new CrashsimHttpError('unknown');
          },
          async getBet() {
            return activeBet(betInput!, 'rejected-after-debit', 'rejected');
          },
        });
        const before = await financial.getBalance(playerId);
        const result = await harness.service.placeBet({
          playerId,
          idempotencyKey: randomUUID(),
          roundId: 'round-current',
          amount: 100,
        });
        const after = await financial.getBalance(playerId);
        expect(result).toMatchObject({ betCommandStatus: 'rejected', resultCode: 'debit_applied_engine_rejected' });
        expect(after.balanceCents).toBe(before.balanceCents - 100n);
        expect(harness.engineStats()).toMatchObject({ placeBetCalls: 1, getBetCalls: 1 });
      });
    });

    test('restores accepted bets after a service restart and lists only the player’s latest commands', async () => {
      await withPlayer(async (playerId) => {
        const original = createHarness();
        const accepted = await original.service.placeBet({
          playerId,
          idempotencyKey: randomUUID(),
          roundId: 'round-current',
          amount: 250,
        });
        await seedRejectedCommands(playerId, 22);

        const restarted = createHarness();
        const defaults = await restarted.service.listBets({ playerId });
        const maxPage = await restarted.service.listBets({ playerId, limit: 20 });
        expect(defaults).toHaveLength(10);
        expect(defaults[0]).toMatchObject({ commandId: accepted.commandId, betCommandStatus: 'accepted' });
        expect(maxPage).toHaveLength(20);
        expect(maxPage[0]).toMatchObject({ commandId: accepted.commandId, betId: accepted.betId });
        expect(maxPage.filter((item) => item.commandId === accepted.commandId)).toHaveLength(1);
        await expect(restarted.service.listBets({ playerId, limit: 21 }))
          .rejects.toMatchObject({ code: 'INVALID_QUERY' });

        const otherPlayerId = randomUUID();
        try {
          expect(await restarted.service.listBets({ playerId: otherPlayerId })).toEqual([]);
        } finally {
          await cleanPlayer(otherPlayerId);
        }
      });
    });

    test('recovers an unknown command by read-only reconciliation after restart', async () => {
      await withPlayer(async (playerId) => {
        await fund(playerId);
        const firstProcess = createHarness({
          async placeBet() { throw new CrashsimHttpError('unknown'); },
        });
        const unknown = await firstProcess.service.placeBet({
          playerId,
          idempotencyKey: randomUUID(),
          roundId: 'round-current',
          amount: 300,
        });
        expect(unknown.betCommandStatus).toBe('unknown');
        const balanceBeforeReconciliation = await financial.getBalance(playerId);
        const betId = 'late-financial-debit';
        await financial.debit({
          txId: randomUUID(),
          playerId,
          amount: 300,
          betId,
          roundId: 'round-current',
        });
        const balanceAfterDebit = await financial.getBalance(playerId);
        expect(balanceAfterDebit.balanceCents).toBe(balanceBeforeReconciliation.balanceCents - 300n);

        const restarted = createHarness({
          async getBet() {
            return {
              betId,
              playerId,
              roundId: 'round-current',
              amount: 300,
              status: 'active',
              multiplierHundredths: null,
              payoutCents: null,
              payoutPrecision: 'not_provided',
            };
          },
        });
        const fromList = await restarted.service.listBets({ playerId });
        expect(fromList[0]?.betCommandStatus).toBe('unknown');
        expect(restarted.engineStats().getBetCalls).toBe(0);

        const reconciled = await restarted.service.getCommand({ playerId, commandId: unknown.commandId });
        expect(reconciled).toMatchObject({ betCommandStatus: 'accepted', betId });
        expect(restarted.engineStats()).toMatchObject({ placeBetCalls: 0, getBetCalls: 1 });
        expect(await financial.getBalance(playerId)).toEqual(balanceAfterDebit);

        const otherPlayerId = randomUUID();
        try {
          expect(await restarted.service.getCommand({ playerId: otherPlayerId, commandId: unknown.commandId }))
            .toBeNull();
          expect(restarted.engineStats().getBetCalls).toBe(1);
        } finally {
          await cleanPlayer(otherPlayerId);
        }
      });
    });

    test('checks bet ownership before engine reads and refreshes game and settlement state separately', async () => {
      await withPlayer(async (playerId) => {
        await fund(playerId);
        const created = createHarness();
        const accepted = await created.service.placeBet({
          playerId,
          idempotencyKey: randomUUID(),
          roundId: 'round-current',
          amount: 400,
        });
        const betId = accepted.betId!;
        let currentBet: CrashsimBet = {
          betId,
          playerId,
          roundId: 'round-current',
          amount: 400,
          status: 'cashed_out',
          multiplierHundredths: 180,
          payoutCents: 720,
          payoutPrecision: 'safe',
        };
        const reader = createHarness({ getBet: async () => currentBet });

        const otherPlayerId = randomUUID();
        try {
          expect(await reader.service.getBet({ playerId: otherPlayerId, betId })).toBeNull();
          expect(reader.engineStats().getBetCalls).toBe(0);
        } finally {
          await cleanPlayer(otherPlayerId);
        }

        const pending = await reader.service.getBet({ playerId, betId });
        expect(pending).toMatchObject({
          betCommandStatus: 'accepted',
          bet: { engineStatus: 'cashed_out', payoutCents: 720, settlementStatus: 'pending' },
        });

        await financial.creditCashoutOnce({
          txId: randomUUID(),
          playerId,
          amount: 720,
          betId,
          roundId: 'round-current',
          source: 'engine',
        });
        const confirmed = await reader.service.getBet({ playerId, betId });
        expect(confirmed?.bet).toMatchObject({ engineStatus: 'cashed_out', payoutCents: 720, settlementStatus: 'confirmed' });
        expect(reader.engineStats().getBetCalls).toBe(2);

        currentBet = { ...currentBet, status: 'active', multiplierHundredths: null, payoutCents: null };
        const staleRead = await reader.service.getBet({ playerId, betId });
        expect(staleRead?.bet).toMatchObject({
          engineStatus: 'cashed_out',
          payoutCents: 720,
          settlementStatus: 'confirmed',
        });
      });
    });

    test('returns the same not-found result for an absent bet or command without contacting Crashsim', async () => {
      await withPlayer(async (playerId) => {
        const harness = createHarness();
        expect(await harness.service.getBet({ playerId, betId: 'missing-bet' })).toBeNull();
        expect(await harness.service.getCommand({ playerId, commandId: randomUUID() })).toBeNull();
        expect(harness.engineStats()).toMatchObject({ placeBetCalls: 0, getBetCalls: 0 });
      });
    });

    test('returns the last persisted bet state when Crashsim restarted and lost its in-memory bet', async () => {
      await withPlayer(async (playerId) => {
        const created = createHarness();
        const accepted = await created.service.placeBet({
          playerId,
          idempotencyKey: randomUUID(),
          roundId: 'round-current',
          amount: 100,
        });
        const afterEngineRestart = createHarness({
          async getBet() { throw new CrashsimHttpError('not_found', 404, 'bet_not_found'); },
        });
        const recovered = await afterEngineRestart.service.getBet({
          playerId,
          betId: accepted.betId!,
        });
        expect(recovered).toMatchObject({
          commandId: accepted.commandId,
          betId: accepted.betId,
          betCommandStatus: 'accepted',
          bet: { engineStatus: 'active', settlementStatus: 'not_applicable' },
        });
        expect(afterEngineRestart.engineStats()).toMatchObject({ placeBetCalls: 0, getBetCalls: 1 });
      });
    });
  });
}
