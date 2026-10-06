import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from '../../../config';
import {
  UnauthenticatedError,
  type AuthModule,
  type AuthenticatedPlayer,
} from '../../auth/auth.module';
import { FinancialServiceError } from '../financial.service';

export type FinancialControllerLogger = Pick<Logger, 'info' | 'warn' | 'error'>;

export interface ErrorBody {
  error: { code: string; message: string };
}

export function errorBody(code: string, message: string): ErrorBody {
  return { error: { code, message } };
}

export async function resolvePlayer(
  request: FastifyRequest,
  reply: FastifyReply,
  requireUser: AuthModule['requireUser'],
  logger: FinancialControllerLogger,
  operation: string,
): Promise<AuthenticatedPlayer | null> {
  try {
    return await requireUser(request);
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      reply.code(401).send(errorBody('UNAUTHENTICATED', 'Authentication required'));
      return null;
    }
    logger.warn('wallet authentication unavailable', {
      event: 'wallet.auth.unavailable',
      operation,
      requestId: request.id,
    });
    reply.code(503).send(errorBody('SERVICE_UNAVAILABLE', 'Financial service is unavailable'));
    return null;
  }
}

export function sendFinancialError(
  error: unknown,
  operation: string,
  request: FastifyRequest,
  reply: FastifyReply,
  logger: FinancialControllerLogger,
): FastifyReply {
  const mapped = mapServiceError(error);
  logger.warn('wallet operation failed', {
    event: 'wallet.operation.failed',
    operation,
    requestId: request.id,
    reason: mapped.reason,
  });
  return reply.code(mapped.status).send(errorBody(mapped.code, mapped.message));
}

function fastifyErrorStatus(error: unknown): number | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  if ('statusCode' in error && typeof error.statusCode === 'number') return error.statusCode;
  return undefined;
}

export function errorFromFastify(error: unknown): { status: number; body: ErrorBody } {
  const status = fastifyErrorStatus(error);
  if (status === 413) {
    return { status, body: errorBody('PAYLOAD_TOO_LARGE', 'Request body is too large') };
  }
  if (status === 415) {
    return { status, body: errorBody('UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json') };
  }
  return { status: 400, body: errorBody('INVALID_PAYLOAD', 'Request body must be valid JSON') };
}

export function mapServiceError(error: unknown): {
  status: number;
  code: string;
  message: string;
  reason: string;
} {
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
    case 'INVALID_LOOKUP':
      return { status: 400, code: 'INVALID_PAYLOAD', message: 'Request payload is invalid', reason: 'invalid_lookup' };
    case 'STORAGE_UNAVAILABLE':
      return { status: 503, code: 'SERVICE_UNAVAILABLE', message: 'Financial service is unavailable', reason: 'storage_unavailable' };
  }
}

export function logRejected(
  logger: FinancialControllerLogger,
  operation: 'debit' | 'credit',
  requestId: string,
  reason: string,
  references?: { txId?: string; betId?: string },
): void {
  logger.warn('wallet.webhook.rejected', {
    event: 'wallet.webhook.rejected',
    operation,
    requestId,
    reason,
    ...references,
  });
}

export function sendPayoutFailure(
  error: unknown,
  operation: 'request' | 'status' | 'history',
  request: FastifyRequest,
  reply: FastifyReply,
  logger: FinancialControllerLogger,
): FastifyReply {
  const mapped = mapServiceError(error);
  const event = operation === 'request' && mapped.reason === 'idempotency_conflict'
    ? 'financial.payout.conflict'
    : `financial.payout.${operation}_failed`;
  logger.warn('financial payout request failed', {
    event,
    operation,
    requestId: request.id,
    reason: mapped.reason,
  });
  return reply.code(mapped.status).send(errorBody(mapped.code, mapped.message));
}

export function payoutDto(payout: {
  id: string;
  amountCents: bigint;
  status: 'processing' | 'done';
  requestedAt: string;
  completedAt: string | null;
}) {
  return {
    id: payout.id,
    amountCents: Number(payout.amountCents),
    currency: 'USD',
    status: payout.status,
    requestedAt: payout.requestedAt,
    completedAt: payout.completedAt,
    simulated: true,
  };
}
