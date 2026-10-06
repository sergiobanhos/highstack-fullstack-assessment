import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as v from 'valibot';
import { verifyCrashsimWebhook } from '../../../integrations/crashsim/webhook-auth';
import type { CashoutCreditListener } from '../financial.module';
import type { FinancialService } from '../financial.service';
import {
  errorBody,
  errorFromFastify,
  logRejected,
  mapServiceError,
  type FinancialControllerLogger,
} from './http.shared';

const MAX_WEBHOOK_BODY_BYTES = 16 * 1024;
type WebhookOperation = 'debit' | 'credit';

const webhookPayloadSchema = v.strictObject({
  txId: v.pipe(v.string(), v.uuid()),
  playerId: v.pipe(v.string(), v.uuid()),
  amount: v.pipe(v.number(), v.integer(), v.minValue(1)),
  betId: v.pipe(v.string(), v.minLength(1), v.maxLength(255)),
  roundId: v.pipe(v.string(), v.minLength(1), v.maxLength(255)),
});

export interface EngineWebhookControllerOptions {
  app: FastifyInstance;
  service: FinancialService;
  webhookSecret: string;
  onCashoutCredited?: CashoutCreditListener;
  logger: FinancialControllerLogger;
}

export function registerEngineWebhookController({ app, ...deps }: EngineWebhookControllerOptions): void {
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

    webhookRoutes.post('/wallet/debit', (request, reply) => processWebhook(request, reply, deps, 'debit'));
    webhookRoutes.post('/wallet/credit', (request, reply) => processWebhook(request, reply, deps, 'credit'));
  });
}

async function processWebhook(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: Omit<EngineWebhookControllerOptions, 'app'>,
  operation: WebhookOperation,
) {
  const rawBody = request.body;
  if (!Buffer.isBuffer(rawBody)) {
    logRejected(deps.logger, operation, request.id, 'invalid_payload');
    return reply.code(400).send(errorBody('INVALID_PAYLOAD', 'Request body must be valid JSON'));
  }

  const auth = verifyCrashsimWebhook({
    headers: {
      timestamp: request.headers['x-timestamp'],
      signature: request.headers['x-signature'],
    },
    rawBody,
    secret: deps.webhookSecret,
  });
  if (!auth.ok) {
    logRejected(deps.logger, operation, request.id, auth.reason);
    return reply.code(401).send(errorBody('UNAUTHORIZED_WEBHOOK', 'Webhook authentication failed'));
  }

  let candidate: unknown;
  try {
    candidate = JSON.parse(rawBody.toString('utf8')) as unknown;
  } catch {
    logRejected(deps.logger, operation, request.id, 'invalid_payload');
    return reply.code(400).send(errorBody('INVALID_PAYLOAD', 'Request body must be valid JSON'));
  }
  const parsed = v.safeParse(webhookPayloadSchema, candidate);
  if (!parsed.success) {
    logRejected(deps.logger, operation, request.id, 'invalid_payload');
    return reply.code(400).send(errorBody('INVALID_PAYLOAD', 'Request payload is invalid'));
  }

  const { txId, playerId, amount, betId, roundId } = parsed.output;
  const references = { txId, betId };
  if (!Number.isSafeInteger(amount)) {
    if (operation === 'credit') {
      deps.logger.error('wallet.cashout.precision_incident', {
        event: 'wallet.cashout.precision_incident', requestId: request.id, txId, betId,
      });
    }
    logRejected(deps.logger, operation, request.id, 'invalid_amount', references);
    return reply.code(422).send(errorBody('INVALID_AMOUNT', 'Amount is outside the supported range'));
  }

  try {
    const result = operation === 'debit'
      ? await deps.service.debit({ txId, playerId, amount, betId, roundId })
      : await deps.service.creditCashoutOnce({ txId, playerId, amount, betId, roundId, source: 'engine' });

    if (result.outcome === 'insufficient_funds') {
      deps.logger.info('wallet.debit.declined', {
        event: 'wallet.debit.declined', requestId: request.id, ...references,
        reason: 'insufficient_funds', replayed: result.replayed,
      });
      return reply.code(402).send(errorBody('INSUFFICIENT_FUNDS', 'Wallet balance is insufficient'));
    }
    if (result.outcome === 'balance_limit') {
      deps.logger.warn('wallet.balance_limit.declined', {
        event: 'wallet.balance_limit.declined', operation, requestId: request.id,
        ...references, reason: 'balance_limit', replayed: result.replayed,
      });
      return reply.code(422).send(errorBody('BALANCE_LIMIT', 'Wallet balance exceeds the supported range'));
    }

    const event = operation === 'debit' ? 'wallet.debit.applied' : 'wallet.credit.applied';
    deps.logger.info(event, { event, requestId: request.id, ...references, replayed: result.replayed });
    if (result.replayed) {
      deps.logger.info('wallet.operation.replayed', {
        event: 'wallet.operation.replayed', operation, requestId: request.id, ...references,
      });
    }

    if (operation === 'credit') {
      // The committed wallet credit is idempotent; a retry also retries recording the bet result.
      await deps.onCashoutCredited?.({ betId, playerId, payoutCents: amount, roundId });
    }
    return reply.code(200).send({ balance: Number(result.balanceCents) });
  } catch (error) {
    const mapped = mapServiceError(error);
    logRejected(deps.logger, operation, request.id, mapped.reason, references);
    if (mapped.status === 503) {
      deps.logger.error('wallet operation unavailable', { event: 'wallet.operation.failed', operation, requestId: request.id });
    }
    if (mapped.reason === 'idempotency_conflict') {
      deps.logger.warn('wallet.operation.conflict', { event: 'wallet.operation.conflict', operation, requestId: request.id, ...references });
    }
    return reply.code(mapped.status).send(errorBody(mapped.code, mapped.message));
  }
}
