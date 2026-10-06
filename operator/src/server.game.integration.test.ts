import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHmac, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config';
import { createDatabase } from './db';
import { authSessions, players } from './modules/auth/auth.schema';
import { financialOperations, walletLedgerEntries, wallets } from './modules/financial/financial.schema';
import { gameBets, gameCommands } from './modules/game/game.schema';
import type { UpstreamSocket, UpstreamSocketCloseInfo } from './integrations/crashsim/stream.client';
import { buildOperatorApp, checkOperatorReadiness, type OperatorApp } from './server';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const webhookSecret = 'operator-game-integration-webhook-secret';
const engineOperatorKey = 'operator-game-integration-key';

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

class IntegrationSocket implements UpstreamSocket {
  private openListener: (() => void) | undefined;
  private messageListener: ((raw: string) => void) | undefined;
  private closeListener: ((info: UpstreamSocketCloseInfo) => void) | undefined;
  private errorListener: ((error: Error) => void) | undefined;

  close(): void {}
  onOpen(listener: () => void): void { this.openListener = listener; }
  onMessage(listener: (raw: string) => void): void { this.messageListener = listener; }
  onClose(listener: (info: UpstreamSocketCloseInfo) => void): void { this.closeListener = listener; }
  onError(listener: (error: Error) => void): void { this.errorListener = listener; }

  emitOpen(): void { this.openListener?.(); }
  emitMessage(event: unknown): void { this.messageListener?.(JSON.stringify(event)); }
}

if (!testDatabaseUrl) {
  test.skip('composed game flow requires TEST_DATABASE_URL', () => {});
} else if (!isDedicatedTestDatabase(testDatabaseUrl)) {
  test('TEST_DATABASE_URL must point to a dedicated database whose name contains "test"', () => {
    throw new Error('Refusing to run server game integration against a database not marked as test-only');
  });
} else {
  const connection = createDatabase(testDatabaseUrl);
  const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url));
  const config = loadConfig({
    DATABASE_URL: testDatabaseUrl,
    APP_ENV: 'local',
    WALLET_TEST_TOPUP_ENABLED: 'true',
    ENGINE_WEBHOOK_SECRET: webhookSecret,
    ENGINE_OPERATOR_KEY: engineOperatorKey,
    ENGINE_HTTP_URL: 'http://crashsim.test',
    ENGINE_STREAM_URL: 'ws://crashsim.test/stream',
    LOG_LEVEL: 'error',
    AUTH_SESSION_TTL_SECONDS: '3600',
  });

  describe('composed operator game flow', () => {
    beforeAll(async () => {
      await connection.check();
      await migrate(connection.db, { migrationsFolder });
      await connection.checkSchema();
    });

    afterAll(async () => {
      await connection.close();
    });

    test('authenticates, reserves a bet, reconciles a timed-out cashout, and refreshes delayed settlement', async () => {
      const email = `game-e2e-${randomUUID()}@test.invalid`;
      const roundId = 'game-integration-round';
      let playerId: string | undefined;
      let operator: OperatorApp | undefined;
      let releaseSnapshotRead: (() => void) | undefined;
      const snapshotRead = new Promise<void>((resolve) => { releaseSnapshotRead = resolve; });
      const socket = new IntegrationSocket();
      const sessionOwners = new Map<string, string>();
      const engineBets = new Map<string, {
        betId: string;
        playerId: string;
        roundId: string;
        amount: number;
        status: 'active' | 'cashed_out';
        autoCashout?: number;
        multiplier?: number;
        payout?: number;
      }>();
      const upstreamCalls = { session: 0, bet: 0, cashout: 0, getBet: 0 };
      const jsonResponse = (payload: unknown, status = 200): Response => new Response(JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json' },
      });

      const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
        const headers = new Headers(init?.headers);
        expect(headers.get('x-operator-key')).toBe(engineOperatorKey);
        const method = init?.method ?? 'GET';

        if (url.pathname === '/rounds/current' && method === 'GET') {
          releaseSnapshotRead?.();
          releaseSnapshotRead = undefined;
          return jsonResponse({
            roundId,
            state: 'betting',
            seq: 0,
            serverSeedHash: 'e2e-seed-hash',
            bettingEndsAt: Date.now() + 60_000,
          });
        }
        const sessionMatch = url.pathname.match(/^\/players\/([^/]+)\/session$/);
        if (sessionMatch && method === 'POST') {
          upstreamCalls.session += 1;
          const owner = decodeURIComponent(sessionMatch[1]!);
          const sessionId = `private-session-${upstreamCalls.session}`;
          sessionOwners.set(sessionId, owner);
          return jsonResponse({ sessionId });
        }
        if (url.pathname === '/bets' && method === 'POST') {
          upstreamCalls.bet += 1;
          const body = JSON.parse(String(init?.body)) as {
            sessionId: string; roundId: string; amount: number; autoCashout?: number;
          };
          const owner = sessionOwners.get(body.sessionId);
          if (!owner) return jsonResponse({ error: 'session_not_found' }, 404);
          const betId = 'game-integration-bet';
          const debitBody = JSON.stringify({ txId: randomUUID(), playerId: owner, amount: body.amount, betId, roundId: body.roundId });
          const debit = await operator!.app.inject({
            method: 'POST', url: '/wallet/debit', headers: signWebhook(debitBody), payload: debitBody,
          });
          if (debit.statusCode !== 200) {
            return jsonResponse({ error: debit.statusCode === 402 ? 'insufficient_funds' : 'wallet_unavailable', status: 'rejected', betId }, debit.statusCode);
          }
          engineBets.set(betId, {
            betId, playerId: owner, roundId: body.roundId, amount: body.amount,
            status: 'active', autoCashout: body.autoCashout,
          });
          return jsonResponse({ betId, playerId: owner, roundId: body.roundId, amount: body.amount, status: 'active', autoCashout: body.autoCashout }, 201);
        }
        const cashoutMatch = url.pathname.match(/^\/bets\/([^/]+)\/cashout$/);
        if (cashoutMatch && method === 'POST') {
          upstreamCalls.cashout += 1;
          const bet = engineBets.get(decodeURIComponent(cashoutMatch[1]!));
          if (!bet) return jsonResponse({ error: 'bet_not_found' }, 404);
          bet.status = 'cashed_out';
          bet.multiplier = 2;
          bet.payout = bet.amount * 2;
          // Simulate the engine committing the cashout before the response is lost.
          throw new Error('simulated cashout response timeout');
        }
        const betMatch = url.pathname.match(/^\/bets\/([^/]+)$/);
        if (betMatch && method === 'GET') {
          upstreamCalls.getBet += 1;
          const bet = engineBets.get(decodeURIComponent(betMatch[1]!));
          if (!bet) return jsonResponse({ error: 'bet_not_found' }, 404);
          return jsonResponse(bet);
        }
        return jsonResponse({ error: 'not_found' }, 404);
      }) as typeof fetch;

      try {
        operator = buildOperatorApp(config, {
          databaseConnection: connection,
          fetchImpl,
          socketFactory: () => socket,
        });
        await operator.app.ready();
        await checkOperatorReadiness(operator);

        const registration = await operator.app.inject({
          method: 'POST', url: '/auth/register',
          payload: { name: 'Game E2E', email, password: 'local game e2e password' },
        });
        expect(registration.statusCode).toBe(201);
        playerId = responseJson(registration).user.id as string;
        const login = await operator.app.inject({
          method: 'POST', url: '/auth/login', payload: { email, password: 'local game e2e password' },
        });
        expect(login.statusCode).toBe(200);
        const token = responseJson(login).token as string;
        const authorization = { authorization: `Bearer ${token}` };

        const topUp = await operator.app.inject({
          method: 'POST', url: '/wallet/top-ups',
          headers: { ...authorization, 'idempotency-key': randomUUID() },
          payload: { amount: 5_000 },
        });
        expect(topUp.statusCode).toBe(201);

        const beforeSync = await operator.app.inject({
          method: 'POST', url: '/game/bets',
          headers: { ...authorization, 'idempotency-key': randomUUID() },
          payload: { roundId, amount: 1_250 },
        });
        expect(beforeSync.statusCode).toBe(409);
        expect(responseJson(beforeSync).error.code).toBe('GAME_NOT_SYNCHRONIZED');
        expect(upstreamCalls).toEqual({ session: 0, bet: 0, cashout: 0, getBet: 0 });

        operator.game.start();
        socket.emitOpen();
        await snapshotRead;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));

        const session = await operator.app.inject({ method: 'POST', url: '/game/session', headers: authorization });
        expect(session.statusCode).toBe(200);
        expect(session.body).toBe('{"status":"ready"}');
        expect(session.body).not.toContain('private-session');

        const betKey = randomUUID();
        const betResponse = await operator.app.inject({
          method: 'POST', url: '/game/bets',
          headers: { ...authorization, 'idempotency-key': betKey },
          payload: { roundId, amount: 1_250, autoCashout: 2.5 },
        });
        expect(betResponse.statusCode).toBe(201);
        const acceptedBet = responseJson(betResponse);
        expect(acceptedBet).toMatchObject({ betCommandStatus: 'accepted', bet: { engineStatus: 'active' } });
        expect(betResponse.body).not.toContain(engineOperatorKey);
        expect(betResponse.body).not.toContain('private-session');

        const replay = await operator.app.inject({
          method: 'POST', url: '/game/bets',
          headers: { ...authorization, 'idempotency-key': betKey },
          payload: { roundId, amount: 1_250, autoCashout: 2.5 },
        });
        expect(replay.statusCode).toBe(201);
        expect(upstreamCalls.bet).toBe(1);
        expect(responseJson(await operator.app.inject({ method: 'GET', url: '/wallet', headers: authorization })))
          .toEqual({ balance: 3_750, currency: 'USD' });

        socket.emitMessage({ type: 'round.started', seq: 1, data: { roundId, startedAt: Date.now() } });
        socket.emitMessage({ type: 'tick', seq: 2, data: { roundId, multiplier: 1.25, t: 100 } });
        const betId = acceptedBet.betId as string;
        const cashoutKey = randomUUID();
        const cashoutResponse = await operator.app.inject({
          method: 'POST', url: `/game/bets/${betId}/cashout`,
          headers: { ...authorization, 'idempotency-key': cashoutKey },
        });
        expect(cashoutResponse.statusCode).toBe(200);
        expect(responseJson(cashoutResponse)).toMatchObject({
          betCommandStatus: 'accepted', bet: { engineStatus: 'cashed_out', payoutCents: 2_500, settlementStatus: 'pending' },
        });
        expect(upstreamCalls).toMatchObject({ cashout: 1, getBet: 1 });
        expect(responseJson(await operator.app.inject({ method: 'GET', url: '/wallet', headers: authorization })))
          .toEqual({ balance: 3_750, currency: 'USD' });

        const cashoutReplay = await operator.app.inject({
          method: 'POST', url: `/game/bets/${betId}/cashout`,
          headers: { ...authorization, 'idempotency-key': cashoutKey },
        });
        expect(cashoutReplay.statusCode).toBe(200);
        expect(upstreamCalls.cashout).toBe(1);

        const creditBody = JSON.stringify({ txId: randomUUID(), playerId, amount: 2_500, betId, roundId });
        const credit = await operator.app.inject({
          method: 'POST', url: '/wallet/credit', headers: signWebhook(creditBody), payload: creditBody,
        });
        expect(credit.statusCode).toBe(200);

        // The credit webhook settles the bet by itself: the row must stop
        // looking active without any engine read or player request.
        const settledRows = await connection.db
          .select({
            engineStatus: gameBets.engineStatus,
            settlementStatus: gameBets.settlementStatus,
            payoutCents: gameBets.payoutCents,
          })
          .from(gameBets)
          .where(eq(gameBets.betId, betId));
        expect(settledRows).toHaveLength(1);
        expect(settledRows[0]?.engineStatus).toBe('cashed_out');
        expect(settledRows[0]?.settlementStatus).toBe('confirmed');
        expect(Number(settledRows[0]?.payoutCents)).toBe(2_500);

        // A retried webhook (same txId) must stay a no-op for both the wallet
        // and the bet.
        const creditReplay = await operator.app.inject({
          method: 'POST', url: '/wallet/credit', headers: signWebhook(creditBody), payload: creditBody,
        });
        expect(creditReplay.statusCode).toBe(200);
        const afterReplay = await connection.db
          .select({
            engineStatus: gameBets.engineStatus,
            settlementStatus: gameBets.settlementStatus,
            payoutCents: gameBets.payoutCents,
          })
          .from(gameBets)
          .where(eq(gameBets.betId, betId));
        expect(afterReplay[0]).toMatchObject({ engineStatus: 'cashed_out', settlementStatus: 'confirmed' });
        expect(Number(afterReplay[0]?.payoutCents)).toBe(2_500);

        const refreshedBet = await operator.app.inject({
          method: 'GET', url: `/game/bets/${betId}`, headers: authorization,
        });
        expect(refreshedBet.statusCode).toBe(200);
        expect(responseJson(refreshedBet)).toMatchObject({
          betCommandStatus: 'accepted', bet: { engineStatus: 'cashed_out', payoutCents: 2_500, settlementStatus: 'confirmed' },
        });
        const restored = await operator.app.inject({ method: 'GET', url: '/game/bets?limit=10', headers: authorization });
        expect(restored.statusCode).toBe(200);
        expect(responseJson(restored)[0]).toMatchObject({
          commandId: acceptedBet.commandId,
          betId,
          betCommandStatus: 'accepted',
          bet: { engineStatus: 'cashed_out', settlementStatus: 'confirmed' },
        });
        expect(responseJson(await operator.app.inject({ method: 'GET', url: '/wallet', headers: authorization })))
          .toEqual({ balance: 6_250, currency: 'USD' });
      } finally {
        if (playerId) {
          await connection.db.delete(gameBets).where(eq(gameBets.playerId, playerId));
          await connection.db.delete(gameCommands).where(eq(gameCommands.playerId, playerId));
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
