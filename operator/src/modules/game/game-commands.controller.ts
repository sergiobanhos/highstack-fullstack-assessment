import type { FastifyInstance, FastifyRequest } from 'fastify';
import * as v from 'valibot';
import type { Logger } from '../../config';
import { UnauthenticatedError, type AuthModule, type AuthenticatedPlayer } from '../auth/auth.module';
import { GameCommandError, type BetCommandResult, type GameCommandService } from './game-command.service';

const MAX_COMMAND_BODY_BYTES = 16 * 1024;
const MAX_BET_CENTS = 1_000_000_000;
const MAX_AUTO_CASHOUT = 1_000_000;
const ENGINE_ID_PATTERN = /^[A-Za-z0-9_-]{1,255}$/;

const betBodySchema = v.strictObject({
  roundId: v.pipe(v.string(), v.minLength(1), v.maxLength(255), v.regex(ENGINE_ID_PATTERN)),
  amount: v.pipe(
    v.number(),
    v.integer(),
    v.minValue(1),
    v.maxValue(MAX_BET_CENTS),
    v.check((amount: number) => Number.isSafeInteger(amount)),
  ),
  autoCashout: v.optional(v.pipe(
    v.number(),
    v.check((value: number) => Number.isFinite(value)),
    v.minValue(1.01),
    v.maxValue(MAX_AUTO_CASHOUT),
    v.check((value) => Number.isSafeInteger(Math.round(value * 100)) && Math.abs(value * 100 - Math.round(value * 100)) < 1e-7),
  )),
});

const betsQuerySchema = v.strictObject({
  limit: v.optional(v.pipe(
    v.string(),
    v.regex(/^[0-9]+$/),
    v.transform(Number),
    v.integer(),
    v.minValue(1),
    v.maxValue(20),
  )),
});

const idempotencyKeySchema = v.pipe(v.string(), v.uuid());
const betIdSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(255), v.regex(ENGINE_ID_PATTERN));
const commandIdSchema = v.pipe(v.string(), v.uuid());

interface ErrorBody {
  error: { code: string; message: string };
}

export interface GameCommandsControllerOptions {
  app: FastifyInstance;
  service: GameCommandService;
  requireUser: AuthModule['requireUser'];
  logger: Pick<Logger, 'warn'>;
}

function errorBody(code: string, message: string): ErrorBody {
  return { error: { code, message } };
}

function statusForFastifyError(error: unknown): { status: number; body: ErrorBody } {
  const code = error !== null && typeof error === 'object' && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined;
  const statusCode = error !== null && typeof error === 'object' && 'statusCode' in error
    ? (error as { statusCode?: unknown }).statusCode
    : undefined;
  if (code === 'FST_ERR_CTP_BODY_TOO_LARGE' || statusCode === 413) {
    return { status: 413, body: errorBody('PAYLOAD_TOO_LARGE', 'Request body is too large') };
  }
  if (code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' || statusCode === 415) {
    return { status: 415, body: errorBody('UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json') };
  }
  return { status: 400, body: errorBody('INVALID_PAYLOAD', 'Request body must be valid JSON') };
}

async function resolvePlayer(
  request: FastifyRequest,
  reply: { code(statusCode: number): { send(payload: unknown): unknown } },
  requireUser: AuthModule['requireUser'],
  logger: GameCommandsControllerOptions['logger'],
  operation: string,
): Promise<AuthenticatedPlayer | null> {
  try {
    return await requireUser(request);
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      reply.code(401).send(errorBody('UNAUTHENTICATED', 'Authentication required'));
      return null;
    }
    logger.warn('game authentication unavailable', { operation, requestId: request.id });
    reply.code(503).send(errorBody('SERVICE_UNAVAILABLE', 'Game service is unavailable'));
    return null;
  }
}

function mapCommandError(error: GameCommandError): { status: number; code: string; message: string } {
  switch (error.code) {
    case 'INVALID_BET':
    case 'INVALID_IDEMPOTENCY_KEY':
    case 'INVALID_QUERY':
      return { status: 400, code: error.code, message: 'Request is invalid' };
    case 'IDEMPOTENCY_KEY_REUSED':
      return { status: 409, code: error.code, message: 'Idempotency key conflicts with another command' };
    case 'SERVICE_UNAVAILABLE':
      return { status: 503, code: error.code, message: 'Game service is unavailable' };
    case 'BET_ALREADY_EXISTS':
    case 'BET_OUTCOME_UNKNOWN':
    case 'BET_NOT_ACTIVE':
    case 'CASHOUT_OUTCOME_UNKNOWN':
    case 'GAME_NOT_SYNCHRONIZED':
    case 'ROUND_NOT_ACCEPTING_BETS':
    case 'ROUND_NOT_RUNNING':
      return { status: 409, code: error.code, message: error.message };
  }
}

function commandOutcome(result: BetCommandResult, acceptedStatus: number): {
  status: number;
  body: unknown;
} {
  if (result.betCommandStatus === 'accepted') return { status: acceptedStatus, body: result };
  if (result.betCommandStatus === 'unknown') {
    return {
      status: 202,
      body: {
        error: { code: 'COMMAND_OUTCOME_UNKNOWN', message: 'Command outcome is still being reconciled' },
        command: result,
      },
    };
  }

  const outcome = result.resultCode === 'insufficient_funds'
    ? { status: 402, code: 'INSUFFICIENT_FUNDS', message: 'Wallet balance is insufficient' }
    : result.resultCode === 'betting_closed'
      ? { status: 409, code: 'ROUND_NOT_ACCEPTING_BETS', message: 'The round is no longer accepting bets' }
      : result.resultCode === 'round_not_running'
        ? { status: 409, code: 'ROUND_NOT_RUNNING', message: 'The round is no longer running' }
        : result.resultCode === 'bet_not_active'
          ? { status: 409, code: 'BET_NOT_ACTIVE', message: 'Bet is no longer active' }
          : result.resultCode === 'bet_not_found'
            ? { status: 404, code: 'BET_NOT_FOUND', message: 'Bet was not found' }
            : { status: 409, code: 'GAME_COMMAND_REJECTED', message: 'Game command was rejected' };
  return {
    status: outcome.status,
    body: { error: { code: outcome.code, message: outcome.message }, command: result },
  };
}

function sendCommandOutcome(
  result: BetCommandResult,
  reply: { code(statusCode: number): { send(payload: unknown): unknown } },
  acceptedStatus: number,
): unknown {
  const outcome = commandOutcome(result, acceptedStatus);
  return reply.code(outcome.status).send(outcome.body);
}

function sendServiceError(
  error: unknown,
  request: FastifyRequest,
  reply: { code(statusCode: number): { send(payload: unknown): unknown } },
  logger: GameCommandsControllerOptions['logger'],
  operation: string,
): unknown {
  if (error instanceof GameCommandError) {
    const mapped = mapCommandError(error);
    logger.warn('game command failed', { operation, requestId: request.id, reason: error.code });
    return reply.code(mapped.status).send(errorBody(mapped.code, mapped.message));
  }
  logger.warn('game command unavailable', { operation, requestId: request.id, reason: 'service_unavailable' });
  return reply.code(503).send(errorBody('SERVICE_UNAVAILABLE', 'Game service is unavailable'));
}

/** Authenticated REST boundary for session, bet, and cashout commands. */
export function registerGameCommandsController({ app, service, requireUser, logger }: GameCommandsControllerOptions): void {
  app.register(async (routes) => {
    routes.addHook('onRequest', async (_request, reply) => {
      reply.header('Cache-Control', 'no-store');
    });
    routes.setErrorHandler((error, _request, reply) => {
      const mapped = statusForFastifyError(error);
      return reply.code(mapped.status).send(mapped.body);
    });

    routes.post('/game/session', { bodyLimit: MAX_COMMAND_BODY_BYTES }, async (request, reply) => {
      const player = await resolvePlayer(request, reply, requireUser, logger, 'session');
      if (!player) return;
      if (request.body !== undefined) return reply.code(400).send(errorBody('VALIDATION_ERROR', 'Request is invalid'));
      try {
        return reply.code(200).send(await service.createSession(player.id));
      } catch (error) {
        return sendServiceError(error, request, reply, logger, 'session');
      }
    });

    routes.post('/game/bets', { bodyLimit: MAX_COMMAND_BODY_BYTES }, async (request, reply) => {
      const player = await resolvePlayer(request, reply, requireUser, logger, 'place_bet');
      if (!player) return;
      const key = v.safeParse(idempotencyKeySchema, request.headers['idempotency-key']);
      const body = v.safeParse(betBodySchema, request.body);
      if (!key.success || !body.success) {
        return reply.code(400).send(errorBody('VALIDATION_ERROR', 'Request is invalid'));
      }
      try {
        const result = await service.placeBet({ playerId: player.id, idempotencyKey: key.output, ...body.output });
        return sendCommandOutcome(result, reply, 201);
      } catch (error) {
        return sendServiceError(error, request, reply, logger, 'place_bet');
      }
    });

    routes.get('/game/bets', async (request, reply) => {
      const player = await resolvePlayer(request, reply, requireUser, logger, 'list_bets');
      if (!player) return;
      const query = v.safeParse(betsQuerySchema, request.query);
      if (!query.success) return reply.code(400).send(errorBody('VALIDATION_ERROR', 'Query is invalid'));
      try {
        return reply.code(200).send(await service.listBets({ playerId: player.id, limit: query.output.limit }));
      } catch (error) {
        return sendServiceError(error, request, reply, logger, 'list_bets');
      }
    });

    routes.get('/game/commands/:commandId', async (request, reply) => {
      const player = await resolvePlayer(request, reply, requireUser, logger, 'get_command');
      if (!player) return;
      const params = v.safeParse(v.strictObject({ commandId: commandIdSchema }), request.params);
      if (!params.success) return reply.code(400).send(errorBody('VALIDATION_ERROR', 'Command ID is invalid'));
      try {
        const result = await service.getCommand({ playerId: player.id, commandId: params.output.commandId });
        if (!result) return reply.code(404).send(errorBody('COMMAND_NOT_FOUND', 'Command was not found'));
        return reply.code(200).send(result);
      } catch (error) {
        return sendServiceError(error, request, reply, logger, 'get_command');
      }
    });

    routes.get('/game/bets/:betId', async (request, reply) => {
      const player = await resolvePlayer(request, reply, requireUser, logger, 'get_bet');
      if (!player) return;
      const params = v.safeParse(v.strictObject({ betId: betIdSchema }), request.params);
      if (!params.success) return reply.code(400).send(errorBody('VALIDATION_ERROR', 'Bet ID is invalid'));
      try {
        const result = await service.getBet({ playerId: player.id, betId: params.output.betId });
        if (!result) return reply.code(404).send(errorBody('BET_NOT_FOUND', 'Bet was not found'));
        return reply.code(200).send(result);
      } catch (error) {
        return sendServiceError(error, request, reply, logger, 'get_bet');
      }
    });

    routes.post('/game/bets/:betId/cashout', { bodyLimit: MAX_COMMAND_BODY_BYTES }, async (request, reply) => {
      const player = await resolvePlayer(request, reply, requireUser, logger, 'cashout');
      if (!player) return;
      const params = v.safeParse(v.strictObject({ betId: betIdSchema }), request.params);
      const key = v.safeParse(idempotencyKeySchema, request.headers['idempotency-key']);
      if (!params.success || !key.success || request.body !== undefined) {
        return reply.code(400).send(errorBody('VALIDATION_ERROR', 'Request is invalid'));
      }
      try {
        const result = await service.cashout({
          playerId: player.id,
          betId: params.output.betId,
          idempotencyKey: key.output,
        });
        if (!result) return reply.code(404).send(errorBody('BET_NOT_FOUND', 'Bet was not found'));
        return sendCommandOutcome(result, reply, 200);
      } catch (error) {
        return sendServiceError(error, request, reply, logger, 'cashout');
      }
    });
  });
}
