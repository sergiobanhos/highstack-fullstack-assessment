import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as v from 'valibot';
import type { AuthModule } from '../../auth/auth.module';
import type { FinancialService } from '../financial.service';
import {
  errorBody,
  errorFromFastify,
  payoutDto,
  resolvePlayer,
  sendFinancialError,
  sendPayoutFailure,
  type FinancialControllerLogger,
} from './http.shared';

const MAX_PLAYER_BODY_BYTES = 16 * 1024;

export interface WalletControllerOptions {
  app: FastifyInstance;
  service: FinancialService;
  walletTestTopupEnabled: boolean;
  payoutMockEnabled?: boolean;
  requireUser: AuthModule['requireUser'];
  logger: FinancialControllerLogger;
}

const walletQuerySchema = v.strictObject({});
const walletHistoryQuerySchema = v.strictObject({
  limit: v.optional(v.pipe(v.string(), v.regex(/^[0-9]+$/), v.transform((value) => Number(value)), v.integer(), v.minValue(1), v.maxValue(100))),
  cursor: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(512), v.regex(/^[A-Za-z0-9_-]+$/))),
});
const walletTopUpBodySchema = v.strictObject({
  amount: v.pipe(v.number(), v.integer(), v.minValue(1), v.check((amount) => Number.isSafeInteger(amount), 'Amount must be a safe integer')),
});
const payoutRequestBodySchema = v.strictObject({
  amount: v.pipe(v.number(), v.integer(), v.minValue(1), v.check((amount) => Number.isSafeInteger(amount), 'Amount must be a safe integer')),
});
const payoutParamsSchema = v.strictObject({ payoutId: v.pipe(v.string(), v.uuid()) });
const payoutHistoryQuerySchema = v.strictObject({
  limit: v.optional(v.pipe(v.string(), v.regex(/^[0-9]+$/), v.transform((value) => Number(value)), v.integer(), v.minValue(1), v.maxValue(100))),
  cursor: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(512), v.regex(/^[A-Za-z0-9_-]+$/))),
});
const idempotencyKeySchema = v.pipe(v.string(), v.uuid());
const cursorTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const ledgerCursorSchema = v.strictObject({
  createdAt: v.pipe(v.string(), v.regex(cursorTimestampPattern), v.check(isCanonicalTimestamp)),
  id: v.pipe(v.string(), v.uuid()),
});
const payoutCursorSchema = v.strictObject({
  requestedAt: v.pipe(v.string(), v.regex(cursorTimestampPattern), v.check(isCanonicalTimestamp)),
  id: v.pipe(v.string(), v.uuid()),
});

function isCanonicalTimestamp(value: string): boolean {
  const milliseconds = value.replace(/(\.\d{3})\d{3}Z$/, '$1Z');
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === milliseconds;
}

function decodeCursor<TSchema extends v.GenericSchema>(value: string, schema: TSchema): v.InferOutput<TSchema> | undefined {
  try {
    const decoded = Buffer.from(value, 'base64url');
    if (decoded.toString('base64url') !== value) return undefined;
    const parsed: unknown = JSON.parse(decoded.toString('utf8'));
    const result = v.safeParse(schema, parsed);
    return result.success ? result.output : undefined;
  } catch {
    return undefined;
  }
}

function encodeCursor(cursor: object): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function registerErrorHandling(routes: FastifyInstance, logger: FinancialControllerLogger): void {
  routes.addHook('onRequest', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
  });
  routes.setErrorHandler((error, request, reply) => {
    const mapped = errorFromFastify(error);
    const operation = request.url.startsWith('/wallet/top-ups')
      ? 'top_up'
      : request.url.startsWith('/payouts')
        ? 'payout'
        : 'wallet_read';
    logger.warn('wallet request rejected', {
      event: 'wallet.request.rejected',
      operation,
      requestId: request.id,
      reason: mapped.status === 413 ? 'payload_too_large' : 'invalid_payload',
    });
    return reply.code(mapped.status).send(mapped.body);
  });
}

export function registerWalletController({ app, ...deps }: WalletControllerOptions): void {
  app.register(async (playerRoutes) => {
    registerErrorHandling(playerRoutes, deps.logger);

    playerRoutes.get('/wallet', async (request, reply) => {
      const player = await resolvePlayer(request, reply, deps.requireUser, deps.logger, 'balance');
      if (!player) return reply;
      if (!v.safeParse(walletQuerySchema, request.query).success) {
        return reply.code(400).send(errorBody('VALIDATION_ERROR', 'Request is invalid'));
      }
      try {
        const wallet = await deps.service.ensureWallet(player.id);
        return reply.code(200).send({ balance: Number(wallet.balanceCents), currency: 'USD' });
      } catch (error) {
        return sendFinancialError(error, 'balance', request, reply, deps.logger);
      }
    });

    playerRoutes.get('/wallet/transactions', async (request, reply) => {
      const player = await resolvePlayer(request, reply, deps.requireUser, deps.logger, 'transactions');
      if (!player) return reply;
      const parsed = v.safeParse(walletHistoryQuerySchema, request.query);
      if (!parsed.success) return reply.code(400).send(errorBody('VALIDATION_ERROR', 'Request is invalid'));
      const limit = parsed.output.limit ?? 50;
      const before = parsed.output.cursor
        ? decodeCursor(parsed.output.cursor, ledgerCursorSchema)
        : undefined;
      if (parsed.output.cursor && !before) {
        return reply.code(400).send(errorBody('INVALID_CURSOR', 'Transaction cursor is invalid'));
      }
      try {
        const page = await deps.service.listEntries(player.id, { limit, before });
        const lastEntry = page.items.at(-1);
        return reply.code(200).send({
          items: page.items.map((entry) => ({
            id: entry.id,
            operationId: entry.operationId,
            direction: entry.direction,
            source: entry.source,
            amountCents: Number(entry.amountCents),
            balanceAfterCents: Number(entry.balanceAfterCents),
            betId: entry.betId,
            roundId: entry.roundId,
            createdAt: entry.createdAt,
            currency: 'USD',
          })),
          nextCursor: page.hasMore && lastEntry
            ? encodeCursor({ createdAt: lastEntry.createdAt, id: lastEntry.id })
            : null,
        });
      } catch (error) {
        return sendFinancialError(error, 'transactions', request, reply, deps.logger);
      }
    });

    if (deps.walletTestTopupEnabled) {
      playerRoutes.post('/wallet/top-ups', { bodyLimit: MAX_PLAYER_BODY_BYTES }, async (request, reply) => {
        const player = await resolvePlayer(request, reply, deps.requireUser, deps.logger, 'top_up');
        if (!player) return reply;
        const key = v.safeParse(idempotencyKeySchema, request.headers['idempotency-key']);
        const body = v.safeParse(walletTopUpBodySchema, request.body);
        if (!key.success || !body.success) return reply.code(400).send(errorBody('VALIDATION_ERROR', 'Request is invalid'));
        try {
          await deps.service.ensureWallet(player.id);
          const result = await deps.service.topUp({ playerId: player.id, amount: body.output.amount, idempotencyKey: key.output });
          if (result.outcome === 'balance_limit') {
            deps.logger.warn('wallet test top-up declined', {
              event: 'wallet.balance_limit.declined', operation: 'top_up', requestId: request.id,
              reason: 'balance_limit', replayed: result.replayed,
            });
            return reply.code(422).send(errorBody('BALANCE_LIMIT', 'Wallet balance exceeds the supported range'));
          }
          deps.logger.info('wallet test top-up applied', {
            event: 'wallet.test_top_up.applied', requestId: request.id, replayed: result.replayed,
          });
          return reply.code(201).send({ transactionId: result.operationId, balance: Number(result.balanceCents), currency: 'USD' });
        } catch (error) {
          return sendFinancialError(error, 'top_up', request, reply, deps.logger);
        }
      });
    }

    if (deps.payoutMockEnabled) registerPayoutRoutes(playerRoutes, deps);
  });
}

function registerPayoutRoutes(
  playerRoutes: FastifyInstance,
  deps: Omit<WalletControllerOptions, 'app'>,
): void {
  playerRoutes.post('/payouts', { bodyLimit: MAX_PLAYER_BODY_BYTES }, async (request, reply) => {
    const player = await resolvePlayer(request, reply, deps.requireUser, deps.logger, 'payout_request');
    if (!player) return reply;
    const key = v.safeParse(idempotencyKeySchema, request.headers['idempotency-key']);
    const body = v.safeParse(payoutRequestBodySchema, request.body);
    if (!key.success || !body.success) return reply.code(400).send(errorBody('VALIDATION_ERROR', 'Request is invalid'));
    try {
      await deps.service.ensureWallet(player.id);
      const result = await deps.service.requestPayout({ playerId: player.id, amount: body.output.amount, idempotencyKey: key.output });
      if (result.outcome === 'insufficient_funds') {
        deps.logger.info('financial payout declined', { event: 'financial.payout.declined', requestId: request.id, reason: 'insufficient_funds', replayed: result.replayed });
        return reply.code(402).send(errorBody('INSUFFICIENT_FUNDS', 'Wallet balance is insufficient'));
      }
      if (result.outcome === 'balance_limit') {
        deps.logger.warn('financial payout declined', { event: 'financial.payout.declined', requestId: request.id, reason: 'balance_limit', replayed: result.replayed });
        return reply.code(422).send(errorBody('BALANCE_LIMIT', 'Wallet balance exceeds the supported range'));
      }
      if (!result.payout) return reply.code(503).send(errorBody('SERVICE_UNAVAILABLE', 'Financial service is unavailable'));
      deps.logger.info(result.replayed ? 'financial payout replayed' : 'financial payout requested', {
        event: result.replayed ? 'financial.payout.replayed' : 'financial.payout.requested',
        requestId: request.id,
        payoutId: result.payout.id,
      });
      return reply.code(201).send(payoutDto(result.payout));
    } catch (error) {
      return sendPayoutFailure(error, 'request', request, reply, deps.logger);
    }
  });

  playerRoutes.get('/payouts/:payoutId', async (request, reply) => {
    const player = await resolvePlayer(request, reply, deps.requireUser, deps.logger, 'payout_status');
    if (!player) return reply;
    const params = v.safeParse(payoutParamsSchema, request.params);
    if (!params.success) return reply.code(400).send(errorBody('VALIDATION_ERROR', 'Request is invalid'));
    try {
      const payout = await deps.service.getPayout({ playerId: player.id, payoutId: params.output.payoutId });
      if (!payout) return reply.code(404).send(errorBody('PAYOUT_NOT_FOUND', 'Payout was not found'));
      return reply.code(200).send(payoutDto(payout));
    } catch (error) {
      return sendPayoutFailure(error, 'status', request, reply, deps.logger);
    }
  });

  playerRoutes.get('/payouts', async (request, reply) => {
    const player = await resolvePlayer(request, reply, deps.requireUser, deps.logger, 'payout_history');
    if (!player) return reply;
    const parsed = v.safeParse(payoutHistoryQuerySchema, request.query);
    if (!parsed.success) return reply.code(400).send(errorBody('VALIDATION_ERROR', 'Request is invalid'));
    const limit = parsed.output.limit ?? 50;
    const before = parsed.output.cursor ? decodeCursor(parsed.output.cursor, payoutCursorSchema) : undefined;
    if (parsed.output.cursor && !before) return reply.code(400).send(errorBody('INVALID_CURSOR', 'Payout cursor is invalid'));
    try {
      const page = await deps.service.listPayouts(player.id, { limit, before });
      const lastPayout = page.items.at(-1);
      return reply.code(200).send({
        items: page.items.map(payoutDto),
        nextCursor: page.hasMore && lastPayout
          ? encodeCursor({ requestedAt: lastPayout.requestedAt, id: lastPayout.id })
          : null,
      });
    } catch (error) {
      return sendPayoutFailure(error, 'history', request, reply, deps.logger);
    }
  });
}
