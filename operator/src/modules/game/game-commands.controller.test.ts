import { afterEach, describe, expect, test } from 'bun:test';
import Fastify from 'fastify';
import type { Logger } from '../../config';
import { UnauthenticatedError, type AuthModule, type AuthenticatedPlayer } from '../auth/auth.module';
import { registerGameCommandsController } from './game-commands.controller';
import {
  GameCommandError,
  type BetCommandResult,
  type GameCommandService,
} from './game-command.service';

const player: AuthenticatedPlayer = {
  id: '0e3c026b-2b1b-4229-96c8-10cd01cdf35a',
  name: 'Test Player',
  email: 'player@test.invalid',
};
const commandId = '1f716761-e619-4c56-a356-267032ed4e0f';
const betId = 'cashout-bet_01';

function result(overrides: Partial<BetCommandResult> = {}): BetCommandResult {
  return {
    commandId,
    roundId: 'round-current',
    amountCents: 100,
    autoCashoutHundredths: null,
    betCommandStatus: 'accepted',
    resultCode: null,
    betId,
    bet: {
      betId,
      engineStatus: 'active',
      multiplierHundredths: null,
      payoutCents: null,
      settlementStatus: 'not_applicable',
    },
    ...overrides,
  };
}

function createHarness(options: {
  authorized?: boolean;
  authUnavailable?: boolean;
  service?: Partial<GameCommandService>;
} = {}) {
  const calls: Record<string, unknown[]> = {
    createSession: [], placeBet: [], cashout: [], listBets: [], getCommand: [], getBet: [],
    reconcileBetsForRound: [], reconcileClosedBets: [], recordCashoutCredit: [],
  };
  const logs: Array<{ message: string; fields?: Record<string, unknown> }> = [];
  const logger: Pick<Logger, 'warn'> = {
    warn(message, fields) { logs.push({ message, fields }); },
  };
  const defaults: GameCommandService = {
    async createSession(playerId) {
      calls.createSession!.push({ playerId });
      if (options.service?.createSession) return options.service.createSession(playerId);
      return { status: 'ready' };
    },
    async placeBet(input) {
      calls.placeBet!.push(input);
      if (options.service?.placeBet) return options.service.placeBet(input);
      return result();
    },
    async cashout(input) {
      calls.cashout!.push(input);
      if (options.service?.cashout) return options.service.cashout(input);
      return result({ bet: { ...result().bet!, engineStatus: 'cashed_out', multiplierHundredths: 200, payoutCents: 200, settlementStatus: 'pending' } });
    },
    async listBets(input) {
      calls.listBets!.push(input);
      if (options.service?.listBets) return options.service.listBets(input);
      return [result()];
    },
    async getCommand(input) {
      calls.getCommand!.push(input);
      if (options.service?.getCommand) return options.service.getCommand(input);
      return result();
    },
    async getBet(input) {
      calls.getBet!.push(input);
      if (options.service?.getBet) return options.service.getBet(input);
      return result();
    },
    async reconcileBetsForRound(roundId) {
      calls.reconcileBetsForRound!.push({ roundId });
      if (options.service?.reconcileBetsForRound) return options.service.reconcileBetsForRound(roundId);
    },
    async reconcileClosedBets(input) {
      calls.reconcileClosedBets!.push(input);
      if (options.service?.reconcileClosedBets) return options.service.reconcileClosedBets(input);
    },
    async recordCashoutCredit(input) {
      calls.recordCashoutCredit!.push(input);
      if (options.service?.recordCashoutCredit) return options.service.recordCashoutCredit(input);
      return 'applied';
    },
  };
  const requireUser: AuthModule['requireUser'] = async () => {
    if (options.authUnavailable) throw new Error('database-secret-must-not-leak');
    if (options.authorized === false) throw new UnauthenticatedError();
    return player;
  };
  const app = Fastify({ logger: false });
  registerGameCommandsController({ app, service: defaults, requireUser, logger });
  return { app, calls, logs };
}

const idempotencyKey = 'd0f9f7b4-e0bf-4f2a-bfd6-7bde872f2d89';

describe('game commands REST controller', () => {
  const apps: ReturnType<typeof createHarness>[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map(({ app }) => app.close()));
  });

  test('authenticates every route and uses only the request identity as playerId', async () => {
    const unauthenticated = createHarness({ authorized: false });
    apps.push(unauthenticated);
    const responses = await Promise.all([
      unauthenticated.app.inject({ method: 'POST', url: '/game/session' }),
      unauthenticated.app.inject({ method: 'POST', url: '/game/bets', headers: { 'idempotency-key': idempotencyKey }, payload: { roundId: 'round-current', amount: 100 } }),
      unauthenticated.app.inject({ method: 'GET', url: '/game/bets' }),
      unauthenticated.app.inject({ method: 'GET', url: `/game/commands/${commandId}` }),
      unauthenticated.app.inject({ method: 'GET', url: `/game/bets/${betId}` }),
      unauthenticated.app.inject({ method: 'POST', url: `/game/bets/${betId}/cashout`, headers: { 'idempotency-key': idempotencyKey } }),
    ]);
    expect(responses.map((response) => response.statusCode)).toEqual([401, 401, 401, 401, 401, 401]);
    expect(unauthenticated.calls.placeBet).toHaveLength(0);
    expect(unauthenticated.calls.cashout).toHaveLength(0);

    const authenticated = createHarness();
    apps.push(authenticated);
    const response = await authenticated.app.inject({
      method: 'POST',
      url: '/game/bets',
      headers: { 'idempotency-key': idempotencyKey },
      payload: { roundId: 'round-current', amount: 100 },
    });
    expect(response.statusCode).toBe(201);
    expect(authenticated.calls.placeBet).toEqual([{
      playerId: player.id,
      idempotencyKey,
      roundId: 'round-current',
      amount: 100,
    }]);
  });

  test('validates strict request bodies, idempotency keys, route IDs, and list limits', async () => {
    const harness = createHarness();
    apps.push(harness);
    const malformed = await harness.app.inject({
      method: 'POST', url: '/game/bets', headers: { 'idempotency-key': idempotencyKey },
      payload: { roundId: 'round-current', amount: 100, playerId: 'attacker-player' },
    });
    const missingKey = await harness.app.inject({
      method: 'POST', url: '/game/bets', payload: { roundId: 'round-current', amount: 100 },
    });
    const invalidKey = await harness.app.inject({
      method: 'POST', url: '/game/bets', headers: { 'idempotency-key': 'invalid' },
      payload: { roundId: 'round-current', amount: 100 },
    });
    const invalidLimit = await harness.app.inject({ method: 'GET', url: '/game/bets?limit=21' });
    const extraQuery = await harness.app.inject({ method: 'GET', url: '/game/bets?playerId=other' });
    const invalidCommandId = await harness.app.inject({ method: 'GET', url: '/game/commands/not-a-uuid' });
    const bodyOnCashout = await harness.app.inject({
      method: 'POST', url: `/game/bets/${betId}/cashout`,
      headers: { 'idempotency-key': idempotencyKey }, payload: { payoutCents: 999_999 },
    });

    expect([malformed, missingKey, invalidKey, invalidLimit, extraQuery, invalidCommandId, bodyOnCashout]
      .map((response) => response.statusCode)).toEqual([400, 400, 400, 400, 400, 400, 400]);
    expect(harness.calls.placeBet).toHaveLength(0);
    expect(harness.calls.cashout).toHaveLength(0);
    expect(harness.calls.listBets).toHaveLength(0);
  });

  test('maps accepted, rejected, and unknown mutation outcomes to REST statuses', async () => {
    const accepted = createHarness();
    apps.push(accepted);
    const cashout = await accepted.app.inject({
      method: 'POST', url: `/game/bets/${betId}/cashout`, headers: { 'idempotency-key': idempotencyKey },
    });
    expect(cashout.statusCode).toBe(200);
    expect(JSON.parse(cashout.body)).toMatchObject({
      betCommandStatus: 'accepted', bet: { engineStatus: 'cashed_out', settlementStatus: 'pending' },
    });

    const insufficient = createHarness({ service: {
      async placeBet() { return result({ betCommandStatus: 'rejected', resultCode: 'insufficient_funds' }); },
    } });
    apps.push(insufficient);
    const rejected = await insufficient.app.inject({
      method: 'POST', url: '/game/bets', headers: { 'idempotency-key': idempotencyKey },
      payload: { roundId: 'round-current', amount: 100 },
    });
    expect(rejected.statusCode).toBe(402);
    expect(JSON.parse(rejected.body)).toMatchObject({ error: { code: 'INSUFFICIENT_FUNDS' }, command: { resultCode: 'insufficient_funds' } });

    const unknown = createHarness({ service: {
      async cashout() { return result({ betCommandStatus: 'unknown', resultCode: 'engine_unavailable' }); },
    } });
    apps.push(unknown);
    const pending = await unknown.app.inject({
      method: 'POST', url: `/game/bets/${betId}/cashout`, headers: { 'idempotency-key': idempotencyKey },
    });
    expect(pending.statusCode).toBe(202);
    expect(JSON.parse(pending.body)).toMatchObject({
      error: { code: 'COMMAND_OUTCOME_UNKNOWN' }, command: { betCommandStatus: 'unknown' },
    });
  });

  test('returns uniform not-found responses for absent owned records and 200 for an unknown command state', async () => {
    const harness = createHarness({ service: {
      async getBet() { return null; },
      async getCommand() { return null; },
    } });
    apps.push(harness);
    const absentBet = await harness.app.inject({ method: 'GET', url: `/game/bets/${betId}` });
    const absentCommand = await harness.app.inject({ method: 'GET', url: `/game/commands/${commandId}` });
    expect(absentBet.statusCode).toBe(404);
    expect(absentCommand.statusCode).toBe(404);
    expect(JSON.parse(absentBet.body)).toEqual({ error: { code: 'BET_NOT_FOUND', message: 'Bet was not found' } });
    expect(JSON.parse(absentCommand.body)).toEqual({ error: { code: 'COMMAND_NOT_FOUND', message: 'Command was not found' } });
    expect(harness.calls.getBet).toEqual([{ playerId: player.id, betId }]);
    expect(harness.calls.getCommand).toEqual([{ playerId: player.id, commandId }]);

    const unknown = result({ betCommandStatus: 'unknown', resultCode: 'engine_unavailable' });
    const reader = createHarness({ service: { async getCommand() { return unknown; } } });
    apps.push(reader);
    const response = await reader.app.inject({ method: 'GET', url: `/game/commands/${commandId}` });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ betCommandStatus: 'unknown', resultCode: 'engine_unavailable' });
  });

  test('does not expose Crashsim session details or return internal authentication errors', async () => {
    const session = createHarness({ service: {
      async createSession() { return { status: 'ready' }; },
    } });
    apps.push(session);
    const response = await session.app.inject({ method: 'POST', url: '/game/session' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('{"status":"ready"}');
    expect(response.body).not.toContain('sessionId');

    const unavailable = createHarness({ authUnavailable: true });
    apps.push(unavailable);
    const failed = await unavailable.app.inject({ method: 'GET', url: '/game/bets' });
    expect(failed.statusCode).toBe(503);
    expect(failed.body).not.toContain('database-secret-must-not-leak');
    expect(JSON.parse(failed.body)).toEqual({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Game service is unavailable' } });
  });

  test('maps domain conflicts and unexpected failures without exposing internals', async () => {
    const conflict = createHarness({ service: {
      async cashout() { throw new GameCommandError('ROUND_NOT_RUNNING'); },
    } });
    apps.push(conflict);
    const rejected = await conflict.app.inject({
      method: 'POST', url: `/game/bets/${betId}/cashout`, headers: { 'idempotency-key': idempotencyKey },
    });
    expect(rejected.statusCode).toBe(409);
    expect(JSON.parse(rejected.body)).toMatchObject({ error: { code: 'ROUND_NOT_RUNNING' } });

    const failure = createHarness({ service: {
      async listBets() { throw new Error('postgres-secret-must-not-leak'); },
    } });
    apps.push(failure);
    const unavailable = await failure.app.inject({ method: 'GET', url: '/game/bets' });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.body).not.toContain('postgres-secret-must-not-leak');
  });
});
