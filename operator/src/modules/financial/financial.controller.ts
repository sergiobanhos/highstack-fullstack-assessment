import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import * as v from "valibot";
import type { Logger } from "../../config";
import {
  UnauthenticatedError,
  type AuthModule,
  type AuthenticatedPlayer,
} from "../auth/auth.module";
import { verifyCrashsimWebhook } from "./crashsim-webhook-auth";
import type { CashoutCreditListener } from "./financial.module";
import {
  FinancialServiceError,
  type FinancialService,
} from "./financial.service";

const MAX_WEBHOOK_BODY_BYTES = 16 * 1024;
const MAX_PLAYER_BODY_BYTES = 16 * 1024;

const webhookPayloadSchema = v.strictObject({
  txId: v.pipe(v.string(), v.uuid()),
  playerId: v.pipe(v.string(), v.uuid()),
  amount: v.pipe(v.number(), v.integer(), v.minValue(1)),
  betId: v.pipe(v.string(), v.minLength(1), v.maxLength(255)),
  roundId: v.pipe(v.string(), v.minLength(1), v.maxLength(255)),
});

const walletQuerySchema = v.strictObject({});

const walletHistoryQuerySchema = v.strictObject({
  limit: v.optional(
    v.pipe(
      v.string(),
      v.regex(/^[0-9]+$/),
      v.transform((value) => Number(value)),
      v.integer(),
      v.minValue(1),
      v.maxValue(100),
    ),
  ),
  cursor: v.optional(
    v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(512),
      v.regex(/^[A-Za-z0-9_-]+$/),
    ),
  ),
});

const walletTopUpBodySchema = v.strictObject({
  amount: v.pipe(
    v.number(),
    v.integer(),
    v.minValue(1),
    v.check(
      (amount) => Number.isSafeInteger(amount),
      "Amount must be a safe integer",
    ),
  ),
});

const payoutRequestBodySchema = v.strictObject({
  amount: v.pipe(
    v.number(),
    v.integer(),
    v.minValue(1),
    v.check(
      (amount) => Number.isSafeInteger(amount),
      "Amount must be a safe integer",
    ),
  ),
});

const payoutParamsSchema = v.strictObject({
  payoutId: v.pipe(v.string(), v.uuid()),
});
const payoutHistoryQuerySchema = v.strictObject({
  limit: v.optional(
    v.pipe(
      v.string(),
      v.regex(/^[0-9]+$/),
      v.transform((value) => Number(value)),
      v.integer(),
      v.minValue(1),
      v.maxValue(100),
    ),
  ),
  cursor: v.optional(
    v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(512),
      v.regex(/^[A-Za-z0-9_-]+$/),
    ),
  ),
});

const idempotencyKeySchema = v.pipe(v.string(), v.uuid());
const cursorTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const ledgerCursorSchema = v.strictObject({
  createdAt: v.pipe(
    v.string(),
    v.regex(cursorTimestampPattern),
    v.check((value) => {
      const milliseconds = value.replace(/(\.\d{3})\d{3}Z$/, "$1Z");
      const parsed = Date.parse(value);
      return (
        Number.isFinite(parsed) &&
        new Date(parsed).toISOString() === milliseconds
      );
    }),
  ),
  id: v.pipe(v.string(), v.uuid()),
});
const payoutCursorSchema = v.strictObject({
  requestedAt: v.pipe(
    v.string(),
    v.regex(cursorTimestampPattern),
    v.check((value) => {
      const milliseconds = value.replace(/(\.\d{3})\d{3}Z$/, "$1Z");
      const parsed = Date.parse(value);
      return (
        Number.isFinite(parsed) &&
        new Date(parsed).toISOString() === milliseconds
      );
    }),
  ),
  id: v.pipe(v.string(), v.uuid()),
});

type WebhookOperation = "debit" | "credit";

export interface FinancialControllerOptions {
  app: FastifyInstance;
  service: FinancialService;
  webhookSecret: string;
  walletTestTopupEnabled: boolean;
  payoutMockEnabled?: boolean;
  /** Records the applied cashout credit on the bet (game module contract). */
  onCashoutCredited?: CashoutCreditListener;
  requireUser: AuthModule["requireUser"];
  logger: Pick<Logger, "info" | "warn" | "error">;
}

interface ErrorBody {
  error: { code: string; message: string };
}

function errorBody(code: string, message: string): ErrorBody {
  return { error: { code, message } };
}

function decodeLedgerCursor(
  value: string,
): { createdAt: string; id: string } | undefined {
  try {
    const decoded = Buffer.from(value, "base64url");
    if (decoded.toString("base64url") !== value) return undefined;
    const parsed: unknown = JSON.parse(decoded.toString("utf8"));
    const result = v.safeParse(ledgerCursorSchema, parsed);
    return result.success ? result.output : undefined;
  } catch {
    return undefined;
  }
}

function encodeLedgerCursor(cursor: { createdAt: string; id: string }): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodePayoutCursor(
  value: string,
): { requestedAt: string; id: string } | undefined {
  try {
    const decoded = Buffer.from(value, "base64url");
    if (decoded.toString("base64url") !== value) return undefined;
    const parsed: unknown = JSON.parse(decoded.toString("utf8"));
    const result = v.safeParse(payoutCursorSchema, parsed);
    return result.success ? result.output : undefined;
  } catch {
    return undefined;
  }
}

function encodePayoutCursor(cursor: {
  requestedAt: string;
  id: string;
}): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

async function resolvePlayer(
  request: FastifyRequest,
  reply: FastifyReply,
  requireUser: AuthModule["requireUser"],
  logger: FinancialControllerOptions["logger"],
  operation: string,
): Promise<AuthenticatedPlayer | null> {
  try {
    return await requireUser(request);
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      reply
        .code(401)
        .send(errorBody("UNAUTHENTICATED", "Authentication required"));
      return null;
    }
    logger.warn("wallet authentication unavailable", {
      event: "wallet.auth.unavailable",
      operation,
      requestId: request.id,
    });
    reply
      .code(503)
      .send(
        errorBody("SERVICE_UNAVAILABLE", "Financial service is unavailable"),
      );
    return null;
  }
}

function sendFinancialError(
  error: unknown,
  operation: string,
  request: FastifyRequest,
  reply: FastifyReply,
  logger: FinancialControllerOptions["logger"],
): FastifyReply {
  const mapped = mapServiceError(error);
  logger.warn("wallet operation failed", {
    event: "wallet.operation.failed",
    operation,
    requestId: request.id,
    reason: mapped.reason,
  });
  return reply.code(mapped.status).send(errorBody(mapped.code, mapped.message));
}

function fastifyErrorStatus(error: unknown): number | undefined {
  if (error === null || typeof error !== "object") return undefined;
  if ("statusCode" in error && typeof error.statusCode === "number")
    return error.statusCode;
  return undefined;
}

function errorFromFastify(error: unknown): { status: number; body: ErrorBody } {
  const status = fastifyErrorStatus(error);
  if (status === 413) {
    return {
      status,
      body: errorBody("PAYLOAD_TOO_LARGE", "Request body is too large"),
    };
  }
  if (status === 415) {
    return {
      status,
      body: errorBody(
        "UNSUPPORTED_MEDIA_TYPE",
        "Content-Type must be application/json",
      ),
    };
  }
  return {
    status: 400,
    body: errorBody("INVALID_PAYLOAD", "Request body must be valid JSON"),
  };
}

function logRejected(
  logger: FinancialControllerOptions["logger"],
  operation: WebhookOperation,
  requestId: string,
  reason: string,
  references?: { txId?: string; betId?: string },
): void {
  logger.warn("wallet.webhook.rejected", {
    event: "wallet.webhook.rejected",
    operation,
    requestId,
    reason,
    ...references,
  });
}

function mapServiceError(error: unknown): {
  status: number;
  code: string;
  message: string;
  reason: string;
} {
  if (!(error instanceof FinancialServiceError)) {
    return {
      status: 503,
      code: "SERVICE_UNAVAILABLE",
      message: "Financial service is unavailable",
      reason: "storage_unavailable",
    };
  }

  switch (error.code) {
    case "INVALID_AMOUNT":
      return {
        status: 422,
        code: "INVALID_AMOUNT",
        message: "Amount is outside the supported range",
        reason: "invalid_amount",
      };
    case "INVALID_IDEMPOTENCY_KEY":
      return {
        status: 400,
        code: "INVALID_PAYLOAD",
        message: "Request payload is invalid",
        reason: "invalid_idempotency_key",
      };
    case "WALLET_NOT_FOUND":
      return {
        status: 404,
        code: "WALLET_NOT_FOUND",
        message: "Wallet does not exist",
        reason: "unknown_wallet",
      };
    case "IDEMPOTENCY_CONFLICT":
      return {
        status: 409,
        code: "IDEMPOTENCY_CONFLICT",
        message: "Operation conflicts with an existing transaction",
        reason: "idempotency_conflict",
      };
    case "INVALID_PAGE":
      return {
        status: 400,
        code: "INVALID_PAYLOAD",
        message: "Request payload is invalid",
        reason: "invalid_page",
      };
    case "INVALID_LOOKUP":
      return {
        status: 400,
        code: "INVALID_PAYLOAD",
        message: "Request payload is invalid",
        reason: "invalid_lookup",
      };
    case "STORAGE_UNAVAILABLE":
      return {
        status: 503,
        code: "SERVICE_UNAVAILABLE",
        message: "Financial service is unavailable",
        reason: "storage_unavailable",
      };
  }
}

function sendPayoutFailure(
  error: unknown,
  operation: "request" | "status" | "history",
  request: FastifyRequest,
  reply: FastifyReply,
  logger: FinancialControllerOptions["logger"],
): FastifyReply {
  const mapped = mapServiceError(error);
  const event =
    operation === "request" && mapped.reason === "idempotency_conflict"
      ? "financial.payout.conflict"
      : `financial.payout.${operation}_failed`;
  logger.warn("financial payout request failed", {
    event,
    operation,
    requestId: request.id,
    reason: mapped.reason,
  });
  return reply.code(mapped.status).send(errorBody(mapped.code, mapped.message));
}

function payoutDto(payout: {
  id: string;
  amountCents: bigint;
  status: "processing" | "done";
  requestedAt: string;
  completedAt: string | null;
}) {
  return {
    id: payout.id,
    amountCents: Number(payout.amountCents),
    currency: "USD",
    status: payout.status,
    requestedAt: payout.requestedAt,
    completedAt: payout.completedAt,
    simulated: true,
  };
}

function createWebhookHandler(
  {
    service,
    webhookSecret,
    onCashoutCredited,
    logger,
  }: Omit<FinancialControllerOptions, "app">,
  operation: WebhookOperation,
) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const rawBody = request.body;
    if (!Buffer.isBuffer(rawBody)) {
      logRejected(logger, operation, request.id, "invalid_payload");
      return reply
        .code(400)
        .send(errorBody("INVALID_PAYLOAD", "Request body must be valid JSON"));
    }

    const auth = verifyCrashsimWebhook({
      headers: {
        timestamp: request.headers["x-timestamp"],
        signature: request.headers["x-signature"],
      },
      rawBody,
      secret: webhookSecret,
    });
    if (!auth.ok) {
      logRejected(logger, operation, request.id, auth.reason);
      return reply
        .code(401)
        .send(
          errorBody("UNAUTHORIZED_WEBHOOK", "Webhook authentication failed"),
        );
    }

    let candidate: unknown;
    try {
      candidate = JSON.parse(rawBody.toString("utf8")) as unknown;
    } catch {
      logRejected(logger, operation, request.id, "invalid_payload");
      return reply
        .code(400)
        .send(errorBody("INVALID_PAYLOAD", "Request body must be valid JSON"));
    }
    const parsed = v.safeParse(webhookPayloadSchema, candidate);
    if (!parsed.success) {
      logRejected(logger, operation, request.id, "invalid_payload");
      return reply
        .code(400)
        .send(errorBody("INVALID_PAYLOAD", "Request payload is invalid"));
    }

    const { txId, playerId, amount, betId, roundId } = parsed.output;
    const references = { txId, betId };
    if (!Number.isSafeInteger(amount)) {
      if (operation === "credit") {
        logger.error("wallet.cashout.precision_incident", {
          event: "wallet.cashout.precision_incident",
          requestId: request.id,
          txId,
          betId,
        });
      }
      logRejected(logger, operation, request.id, "invalid_amount", references);
      return reply
        .code(422)
        .send(
          errorBody("INVALID_AMOUNT", "Amount is outside the supported range"),
        );
    }

    try {
      const result =
        operation === "debit"
          ? await service.debit({ txId, playerId, amount, betId, roundId })
          : await service.creditCashoutOnce({
              txId,
              playerId,
              amount,
              betId,
              roundId,
              source: "engine",
            });

      if (result.outcome === "insufficient_funds") {
        logger.info("wallet.debit.declined", {
          event: "wallet.debit.declined",
          requestId: request.id,
          ...references,
          reason: "insufficient_funds",
          replayed: result.replayed,
        });
        return reply
          .code(402)
          .send(
            errorBody("INSUFFICIENT_FUNDS", "Wallet balance is insufficient"),
          );
      }
      if (result.outcome === "balance_limit") {
        logger.warn("wallet.balance_limit.declined", {
          event: "wallet.balance_limit.declined",
          operation,
          requestId: request.id,
          ...references,
          reason: "balance_limit",
          replayed: result.replayed,
        });
        return reply
          .code(422)
          .send(
            errorBody(
              "BALANCE_LIMIT",
              "Wallet balance exceeds the supported range",
            ),
          );
      }

      const event =
        operation === "debit"
          ? "wallet.debit.applied"
          : "wallet.credit.applied";
      logger.info(event, {
        event,
        requestId: request.id,
        ...references,
        replayed: result.replayed,
      });
      if (result.replayed) {
        logger.info("wallet.operation.replayed", {
          event: "wallet.operation.replayed",
          operation,
          requestId: request.id,
          ...references,
        });
      }

      if (operation === "credit") {
        // The wallet already holds the money, so the bet must not keep looking
        // active. A failure here answers 503 and the engine retries the same
        // idempotent webhook, which re-runs this recording.
        await onCashoutCredited?.({
          betId,
          playerId,
          payoutCents: amount,
          roundId,
        });
      }

      return reply.code(200).send({ balance: Number(result.balanceCents) });
    } catch (error) {
      const mapped = mapServiceError(error);
      logRejected(logger, operation, request.id, mapped.reason, references);
      if (mapped.status === 503) {
        logger.error("wallet operation unavailable", {
          event: "wallet.operation.failed",
          operation,
          requestId: request.id,
        });
      }
      if (mapped.reason === "idempotency_conflict") {
        logger.warn("wallet.operation.conflict", {
          event: "wallet.operation.conflict",
          operation,
          requestId: request.id,
          ...references,
        });
      }
      return reply
        .code(mapped.status)
        .send(errorBody(mapped.code, mapped.message));
    }
  };
}

/** Registers Crashsim callbacks in a child Fastify scope with a raw-byte JSON parser. */
export function registerFinancialController({
  app,
  ...deps
}: FinancialControllerOptions): void {
  app.register(async (playerRoutes) => {
    playerRoutes.addHook("onRequest", async (_request, reply) => {
      reply.header("Cache-Control", "no-store");
    });
    playerRoutes.setErrorHandler((error, request, reply) => {
      const mapped = errorFromFastify(error);
      const operation = request.url.startsWith("/wallet/top-ups")
        ? "top_up"
        : request.url.startsWith("/payouts")
          ? "payout"
          : "wallet_read";
      deps.logger.warn("wallet request rejected", {
        event: "wallet.request.rejected",
        operation,
        requestId: request.id,
        reason: mapped.status === 413 ? "payload_too_large" : "invalid_payload",
      });
      return reply.code(mapped.status).send(mapped.body);
    });

    playerRoutes.get("/wallet", async (request, reply) => {
      const player = await resolvePlayer(
        request,
        reply,
        deps.requireUser,
        deps.logger,
        "balance",
      );
      if (!player) return reply;
      if (!v.safeParse(walletQuerySchema, request.query).success) {
        return reply
          .code(400)
          .send(errorBody("VALIDATION_ERROR", "Request is invalid"));
      }
      try {
        const wallet = await deps.service.ensureWallet(player.id);
        return reply
          .code(200)
          .send({ balance: Number(wallet.balanceCents), currency: "USD" });
      } catch (error) {
        return sendFinancialError(
          error,
          "balance",
          request,
          reply,
          deps.logger,
        );
      }
    });

    playerRoutes.get("/wallet/transactions", async (request, reply) => {
      const player = await resolvePlayer(
        request,
        reply,
        deps.requireUser,
        deps.logger,
        "transactions",
      );
      if (!player) return reply;
      const parsed = v.safeParse(walletHistoryQuerySchema, request.query);
      if (!parsed.success) {
        return reply
          .code(400)
          .send(errorBody("VALIDATION_ERROR", "Request is invalid"));
      }
      const limit = parsed.output.limit ?? 50;
      const before = parsed.output.cursor
        ? decodeLedgerCursor(parsed.output.cursor)
        : undefined;
      if (parsed.output.cursor && !before) {
        return reply
          .code(400)
          .send(errorBody("INVALID_CURSOR", "Transaction cursor is invalid"));
      }
      try {
        const page = await deps.service.listEntries(player.id, {
          limit,
          before,
        });
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
            currency: "USD",
          })),
          nextCursor:
            page.hasMore && lastEntry
              ? encodeLedgerCursor({
                  createdAt: lastEntry.createdAt,
                  id: lastEntry.id,
                })
              : null,
        });
      } catch (error) {
        return sendFinancialError(
          error,
          "transactions",
          request,
          reply,
          deps.logger,
        );
      }
    });

    if (deps.walletTestTopupEnabled) {
      playerRoutes.post(
        "/wallet/top-ups",
        { bodyLimit: MAX_PLAYER_BODY_BYTES },
        async (request, reply) => {
          const player = await resolvePlayer(
            request,
            reply,
            deps.requireUser,
            deps.logger,
            "top_up",
          );
          if (!player) return reply;
          const key = v.safeParse(
            idempotencyKeySchema,
            request.headers["idempotency-key"],
          );
          const body = v.safeParse(walletTopUpBodySchema, request.body);
          if (!key.success || !body.success) {
            return reply
              .code(400)
              .send(errorBody("VALIDATION_ERROR", "Request is invalid"));
          }
          try {
            await deps.service.ensureWallet(player.id);
            const result = await deps.service.topUp({
              playerId: player.id,
              amount: body.output.amount,
              idempotencyKey: key.output,
            });
            if (result.outcome === "balance_limit") {
              deps.logger.warn("wallet test top-up declined", {
                event: "wallet.balance_limit.declined",
                operation: "top_up",
                requestId: request.id,
                reason: "balance_limit",
                replayed: result.replayed,
              });
              return reply
                .code(422)
                .send(
                  errorBody(
                    "BALANCE_LIMIT",
                    "Wallet balance exceeds the supported range",
                  ),
                );
            }
            deps.logger.info("wallet test top-up applied", {
              event: "wallet.test_top_up.applied",
              requestId: request.id,
              replayed: result.replayed,
            });
            return reply.code(201).send({
              transactionId: result.operationId,
              balance: Number(result.balanceCents),
              currency: "USD",
            });
          } catch (error) {
            return sendFinancialError(
              error,
              "top_up",
              request,
              reply,
              deps.logger,
            );
          }
        },
      );
    }

    if (deps.payoutMockEnabled) {
      playerRoutes.post(
        "/payouts",
        { bodyLimit: MAX_PLAYER_BODY_BYTES },
        async (request, reply) => {
          const player = await resolvePlayer(
            request,
            reply,
            deps.requireUser,
            deps.logger,
            "payout_request",
          );
          if (!player) return reply;
          const key = v.safeParse(
            idempotencyKeySchema,
            request.headers["idempotency-key"],
          );
          const body = v.safeParse(payoutRequestBodySchema, request.body);
          if (!key.success || !body.success) {
            return reply
              .code(400)
              .send(errorBody("VALIDATION_ERROR", "Request is invalid"));
          }
          try {
            await deps.service.ensureWallet(player.id);
            const result = await deps.service.requestPayout({
              playerId: player.id,
              amount: body.output.amount,
              idempotencyKey: key.output,
            });
            if (result.outcome === "insufficient_funds") {
              deps.logger.info("financial payout declined", {
                event: "financial.payout.declined",
                requestId: request.id,
                reason: "insufficient_funds",
                replayed: result.replayed,
              });
              return reply
                .code(402)
                .send(
                  errorBody(
                    "INSUFFICIENT_FUNDS",
                    "Wallet balance is insufficient",
                  ),
                );
            }
            if (result.outcome === "balance_limit") {
              deps.logger.warn("financial payout declined", {
                event: "financial.payout.declined",
                requestId: request.id,
                reason: "balance_limit",
                replayed: result.replayed,
              });
              return reply
                .code(422)
                .send(
                  errorBody(
                    "BALANCE_LIMIT",
                    "Wallet balance exceeds the supported range",
                  ),
                );
            }
            if (!result.payout) {
              return reply
                .code(503)
                .send(
                  errorBody(
                    "SERVICE_UNAVAILABLE",
                    "Financial service is unavailable",
                  ),
                );
            }
            deps.logger.info(
              result.replayed
                ? "financial payout replayed"
                : "financial payout requested",
              {
                event: result.replayed
                  ? "financial.payout.replayed"
                  : "financial.payout.requested",
                requestId: request.id,
                payoutId: result.payout.id,
              },
            );
            return reply.code(201).send(payoutDto(result.payout));
          } catch (error) {
            return sendPayoutFailure(
              error,
              "request",
              request,
              reply,
              deps.logger,
            );
          }
        },
      );

      playerRoutes.get("/payouts/:payoutId", async (request, reply) => {
        const player = await resolvePlayer(
          request,
          reply,
          deps.requireUser,
          deps.logger,
          "payout_status",
        );
        if (!player) return reply;
        const params = v.safeParse(payoutParamsSchema, request.params);
        if (!params.success)
          return reply
            .code(400)
            .send(errorBody("VALIDATION_ERROR", "Request is invalid"));
        try {
          const payout = await deps.service.getPayout({
            playerId: player.id,
            payoutId: params.output.payoutId,
          });
          if (!payout)
            return reply
              .code(404)
              .send(errorBody("PAYOUT_NOT_FOUND", "Payout was not found"));
          return reply.code(200).send(payoutDto(payout));
        } catch (error) {
          return sendPayoutFailure(
            error,
            "status",
            request,
            reply,
            deps.logger,
          );
        }
      });

      playerRoutes.get("/payouts", async (request, reply) => {
        const player = await resolvePlayer(
          request,
          reply,
          deps.requireUser,
          deps.logger,
          "payout_history",
        );
        if (!player) return reply;
        const parsed = v.safeParse(payoutHistoryQuerySchema, request.query);
        if (!parsed.success)
          return reply
            .code(400)
            .send(errorBody("VALIDATION_ERROR", "Request is invalid"));
        const limit = parsed.output.limit ?? 50;
        const before = parsed.output.cursor
          ? decodePayoutCursor(parsed.output.cursor)
          : undefined;
        if (parsed.output.cursor && !before) {
          return reply
            .code(400)
            .send(errorBody("INVALID_CURSOR", "Payout cursor is invalid"));
        }
        try {
          const page = await deps.service.listPayouts(player.id, {
            limit,
            before,
          });
          const lastPayout = page.items.at(-1);
          return reply.code(200).send({
            items: page.items.map(payoutDto),
            nextCursor:
              page.hasMore && lastPayout
                ? encodePayoutCursor({
                    requestedAt: lastPayout.requestedAt,
                    id: lastPayout.id,
                  })
                : null,
          });
        } catch (error) {
          return sendPayoutFailure(
            error,
            "history",
            request,
            reply,
            deps.logger,
          );
        }
      });
    }
  });

  app.register(async (webhookRoutes) => {
    webhookRoutes.removeContentTypeParser("application/json");
    webhookRoutes.addContentTypeParser(
      "application/json",
      { parseAs: "buffer", bodyLimit: MAX_WEBHOOK_BODY_BYTES },
      (_request, rawBody, done) => done(null, rawBody),
    );
    webhookRoutes.setErrorHandler((error, request, reply) => {
      const mapped = errorFromFastify(error);
      const operation = request.url.endsWith("/credit") ? "credit" : "debit";
      logRejected(
        deps.logger,
        operation,
        request.id,
        mapped.status === 413 ? "payload_too_large" : "invalid_payload",
      );
      return reply.code(mapped.status).send(mapped.body);
    });

    webhookRoutes.post("/wallet/debit", createWebhookHandler(deps, "debit"));
    webhookRoutes.post("/wallet/credit", createWebhookHandler(deps, "credit"));
  });
}
