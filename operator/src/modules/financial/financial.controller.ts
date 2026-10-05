import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as v from 'valibot';
import type { Logger } from '../../config';
import { FinancialServiceError, type FinancialService } from './financial.service';
import { verifyCrashsimWebhook, type WebhookAuthFailure } from './crashsim-webhook-auth';

const MAX_WEBHOOK_BODY_BYTES = 16 * 1024;

const webhookPayloadSchema = v.strictObject({
  txId: v.pipe(v.string(), v.uuid()),
  playerId: v.pipe(v.string(), v.uuid()),
  amount: v.pipe(v.number(), v.integer(), v.minValue(1)),
  betId: v.pipe(v.string(), v.minLength(1), v.maxLength(255)),
  roundId: v.pipe(v.string(), v.minLength(1), v.maxLength(255)),
});

type WebhookOperation = 'debit' | 'credit';

export interface FinancialControllerOptions {
  app: FastifyInstance;
  service: FinancialService;
  webhookSecret: string;
  logger: Pick<Logger, 'info' | 'warn' | 'error'>;
}

interface ErrorBody {
  error: { code: string; message: string };
}

function errorBody(code: string, message: string): ErrorBody {
  return { error: { code, message } };
}

function fastifyErrorStatus(error: unknown): number | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  if ('statusCode' in error && typeof error.statusCode === 'number') return error.statusCode;
  return undefined;
}

function errorFromFastify(error: unknown): { status: number; body: ErrorBody } {
  const status = fastifyErrorStatus(error);
  if (status === 413) {
    return { status, body: errorBody('PAYLOAD_TOO_LARGE', 'Request body is too large') };
  }
  if (status === 415) {
    return { status, body: errorBody('UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json') };
  }
  return { status: 400, body: errorBody('INVALID_PAYLOAD', 'Request body must be valid JSON') };
}

function isWebhookAuthFailure(value: unknown): value is WebhookAuthFailure {
  return typeof value === 'string' && [
    'missing_timestamp', 'invalid_timestamp', 'stale_timestamp', 'missing_signature', 'invalid_signature',
  ].includes(value);
}

function logRejected(
  logger: FinancialControllerOptions['logger'],
  operation: WebhookOperation,
  requestId: string,
  reason: string,
  references?: { txId?: string; betId?: string },
): void {
  logger.warn('wallet.webhook.rejected', {
    event: 'wallet.webhook.rejected', operation, requestId, reason, ...references,
  });
}

function mapServiceError(error: unknown): { status: number; code: string; message: string; reason: string } {
  if (!(error instanceof FinancialServiceError)) {
    return { status: 503, code: 'SERVICE_UNAVAILABLE', message: 'Financial service is unavailable', reason: 'storage_unavailable' };
  }

  switch (error.code) {
    case 'INVALID_AMOUNT':
      return { status: 422, code: 'INVALID_AMOUNT', message: 'Amount is outside the supported range', reason: 'invalid_amount' };
    case 'INVALID_IDEMPOTENCY_KEY':
      return { status: 400, code: 'INVALID_PAYLOAD', message: 'Request payload is invalid', reason: 'invalid_idempotency_key' };
    case 'WALLET_NOT_FOUND':
      return { status: 404, code: 'WALLET_NOT_FOUND', message: 'Wallet does not exist', reason: 'unknown_wallet' };
    case 'IDEMPOTENCY_CONFLICT':
      return { status: 409, code: 'IDEMPOTENCY_CONFLICT', message: 'Operation conflicts with an existing transaction', reason: 'idempotency_conflict' };
    case 'INVALID_PAGE':
      return { status: 400, code: 'INVALID_PAYLOAD', message: 'Request payload is invalid', reason: 'invalid_page' };
    case 'STORAGE_UNAVAILABLE':
      return { status: 503, code: 'SERVICE_UNAVAILABLE', message: 'Financial service is unavailable', reason: 'storage_unavailable' };
  }
}

function createWebhookHandler(
  { service, webhookSecret, logger }: Omit<FinancialControllerOptions, 'app'>,
  operation: WebhookOperation,
) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const rawBody = request.body;
    if (!Buffer.isBuffer(rawBody)) {
      logRejected(logger, operation, request.id, 'invalid_payload');
      return reply.code(400).send(errorBody('INVALID_PAYLOAD', 'Request body must be valid JSON'));
    }

    const auth = verifyCrashsimWebhook({
      headers: {
        timestamp: request.headers['x-timestamp'],
        signature: request.headers['x-signature'],
      },
      rawBody,
      secret: webhookSecret,
    });
    if (!auth.ok) {
      logRejected(logger, operation, request.id, auth.reason);
      return reply.code(401).send(errorBody('UNAUTHORIZED_WEBHOOK', 'Webhook authentication failed'));
    }

    let candidate: unknown;
    try {
      candidate = JSON.parse(rawBody.toString('utf8')) as unknown;
    } catch {
      logRejected(logger, operation, request.id, 'invalid_payload');
      return reply.code(400).send(errorBody('INVALID_PAYLOAD', 'Request body must be valid JSON'));
    }
    const parsed = v.safeParse(webhookPayloadSchema, candidate);
    if (!parsed.success) {
      logRejected(logger, operation, request.id, 'invalid_payload');
      return reply.code(400).send(errorBody('INVALID_PAYLOAD', 'Request payload is invalid'));
    }

    const { txId, playerId, amount, betId, roundId } = parsed.output;
    const references = { txId, betId };
    if (!Number.isSafeInteger(amount)) {
      if (operation === 'credit') {
        logger.error('wallet.cashout.precision_incident', {
          event: 'wallet.cashout.precision_incident', requestId: request.id, txId, betId,
        });
      }
      logRejected(logger, operation, request.id, 'invalid_amount', references);
      return reply.code(422).send(errorBody('INVALID_AMOUNT', 'Amount is outside the supported range'));
    }

    try {
      const result = operation === 'debit'
        ? await service.debit({ txId, playerId, amount, betId, roundId })
        : await service.creditCashoutOnce({ txId, playerId, amount, betId, roundId, source: 'engine' });

      if (result.outcome === 'insufficient_funds') {
        logger.info('wallet.debit.declined', {
          event: 'wallet.debit.declined', requestId: request.id, ...references,
          reason: 'insufficient_funds', replayed: result.replayed,
        });
        return reply.code(402).send(errorBody('INSUFFICIENT_FUNDS', 'Wallet balance is insufficient'));
      }
      if (result.outcome === 'balance_limit') {
        logger.warn('wallet.balance_limit.declined', {
          event: 'wallet.balance_limit.declined', operation, requestId: request.id, ...references,
          reason: 'balance_limit', replayed: result.replayed,
        });
        return reply.code(422).send(errorBody('BALANCE_LIMIT', 'Wallet balance exceeds the supported range'));
      }

      const event = operation === 'debit' ? 'wallet.debit.applied' : 'wallet.credit.applied';
      logger.info(event, { event, requestId: request.id, ...references, replayed: result.replayed });
      if (result.replayed) {
        logger.info('wallet.operation.replayed', {
          event: 'wallet.operation.replayed', operation, requestId: request.id, ...references,
        });
      }
      return reply.code(200).send({ balance: Number(result.balanceCents) });
    } catch (error) {
      const mapped = mapServiceError(error);
      logRejected(logger, operation, request.id, mapped.reason, references);
      if (mapped.status === 503) {
        logger.error('wallet operation unavailable', { event: 'wallet.operation.failed', operation, requestId: request.id });
      }
      if (mapped.reason === 'idempotency_conflict') {
        logger.warn('wallet.operation.conflict', {
          event: 'wallet.operation.conflict', operation, requestId: request.id, ...references,
        });
      }
      return reply.code(mapped.status).send(errorBody(mapped.code, mapped.message));
    }
  };
}

/** Registers Crashsim callbacks in a child Fastify scope with a raw-byte JSON parser. */
export function registerFinancialController({ app, ...deps }: FinancialControllerOptions): void {
  app.register(async (webhookRoutes) => {
    webhookRoutes.removeContentTypeParser('application/json');
    webhookRoutes.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer', bodyLimit: MAX_WEBHOOK_BODY_BYTES },
      (_request, rawBody, done) => done(null, rawBody),
    );
    webhookRoutes.setErrorHandler((error, request, reply) => {
      const mapped = errorFromFastify(error);
      const operation = request.url.endsWith('/credit') ? 'credit' : 'debit';
      logRejected(deps.logger, operation, request.id, mapped.status === 413 ? 'payload_too_large' : 'invalid_payload');
      return reply.code(mapped.status).send(mapped.body);
    });

    webhookRoutes.post('/wallet/debit', createWebhookHandler(deps, 'debit'));
    webhookRoutes.post('/wallet/credit', createWebhookHandler(deps, 'credit'));
  });
}
