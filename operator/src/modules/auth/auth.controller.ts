import type { FastifyInstance, FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import * as v from 'valibot';
import {
  AuthServiceError,
  type AuthService,
  type AuthenticatedPlayer,
} from './auth.service';
import { UnauthenticatedError } from './auth.module';
import { readBearerToken } from './auth.validation';

const MAX_AUTH_BODY_BYTES = 16 * 1024;

const registerBodySchema = v.strictObject({
  name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(100)),
  email: v.pipe(v.string(), v.trim(), v.maxLength(254), v.email()),
  password: v.pipe(
    v.string(),
    v.minLength(12),
    v.maxLength(128),
    v.check((password) => Buffer.byteLength(password, 'utf8') <= 512),
  ),
});

const loginBodySchema = v.strictObject({
  email: v.pipe(v.string(), v.trim(), v.maxLength(254), v.email()),
  password: v.pipe(
    v.string(),
    v.minLength(12),
    v.maxLength(128),
    v.check((password) => Buffer.byteLength(password, 'utf8') <= 512),
  ),
});

export interface AuthRouteLogger {
  warn(message: string, fields?: Record<string, unknown>): void;
}

export interface AuthControllerOptions {
  app: FastifyInstance;
  service: AuthService;
  requireUser(request: FastifyRequest): Promise<AuthenticatedPlayer>;
  logger: AuthRouteLogger;
}

interface ErrorBody {
  error: { code: string; message: string };
}

const messages = {
  validation: 'Request is invalid',
  unauthorized: 'Authentication required',
  invalidAuthorization: 'Authorization header must contain a valid Bearer token',
  emailInUse: 'Email is already registered',
  invalidCredentials: 'Invalid email or password',
  rateLimited: 'Too many requests',
  unavailable: 'Authentication service is unavailable',
  requestTooLarge: 'Request body is too large',
  unsupportedMediaType: 'Content-Type must be application/json',
  malformedJson: 'Request body must be valid JSON',
} as const;

function errorBody(code: string, message: string): ErrorBody {
  return { error: { code, message } };
}

function getBearerToken(request: FastifyRequest): string | null {
  return readBearerToken(request.headers.authorization);
}

function statusForFastifyError(error: unknown): { status: number; body: ErrorBody } {
  const code =
    error !== null && typeof error === 'object' && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined;
  const statusCode =
    error !== null && typeof error === 'object' && 'statusCode' in error
      ? (error as { statusCode?: unknown }).statusCode
      : undefined;

  if (code === 'FST_ERR_CTP_BODY_TOO_LARGE' || statusCode === 413) {
    return { status: 413, body: errorBody('PAYLOAD_TOO_LARGE', messages.requestTooLarge) };
  }
  if (code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' || statusCode === 415) {
    return { status: 415, body: errorBody('UNSUPPORTED_MEDIA_TYPE', messages.unsupportedMediaType) };
  }
  if (statusCode === 429) {
    return { status: 429, body: errorBody('RATE_LIMITED', messages.rateLimited) };
  }
  return { status: 400, body: errorBody('VALIDATION_ERROR', messages.malformedJson) };
}

export function registerAuthController({ app, service, requireUser, logger }: AuthControllerOptions): void {
  app.register(async (authRoutes) => {
    authRoutes.addHook('onRequest', async (_request, reply) => {
      reply.header('Cache-Control', 'no-store');
    });

    authRoutes.setErrorHandler((error, request, reply) => {
      const mapped = statusForFastifyError(error);
      return reply.code(mapped.status).send(mapped.body);
    });

    await authRoutes.register(rateLimit, {
      global: false,
      hook: 'onRequest',
      errorResponseBuilder: () => Object.assign(new Error(messages.rateLimited), { statusCode: 429 }),
    });

    authRoutes.post(
      '/auth/register',
      {
        bodyLimit: MAX_AUTH_BODY_BYTES,
        config: { rateLimit: { max: 5, timeWindow: 60_000 } },
      },
      async (request, reply) => {
        const parsed = v.safeParse(registerBodySchema, request.body);
        if (!parsed.success) return reply.code(400).send(errorBody('VALIDATION_ERROR', messages.validation));

        try {
          const user = await service.register(parsed.output);
          return reply.code(201).send({ user });
        } catch (error) {
          if (error instanceof AuthServiceError) {
            if (error.code === 'EMAIL_IN_USE') {
              return reply.code(409).send(errorBody('EMAIL_IN_USE', messages.emailInUse));
            }
            if (error.code === 'RATE_LIMITED') {
              return reply.code(429).send(errorBody('RATE_LIMITED', messages.rateLimited));
            }
          }
          logger.warn('auth operation unavailable', { operation: 'register', requestId: request.id });
          return reply.code(503).send(errorBody('SERVICE_UNAVAILABLE', messages.unavailable));
        }
      },
    );

    authRoutes.post(
      '/auth/login',
      {
        bodyLimit: MAX_AUTH_BODY_BYTES,
        config: { rateLimit: { max: 10, timeWindow: 60_000 } },
      },
      async (request, reply) => {
        const parsed = v.safeParse(loginBodySchema, request.body);
        if (!parsed.success) return reply.code(400).send(errorBody('VALIDATION_ERROR', messages.validation));

        try {
          const result = await service.login(parsed.output);
          return reply.code(200).send({
            token: result.token,
            expiresAt: result.expiresAt.toISOString(),
            user: result.user,
          });
        } catch (error) {
          if (error instanceof AuthServiceError) {
            if (error.code === 'INVALID_CREDENTIALS') {
              return reply.code(401).send(errorBody('INVALID_CREDENTIALS', messages.invalidCredentials));
            }
            if (error.code === 'RATE_LIMITED') {
              return reply.code(429).send(errorBody('RATE_LIMITED', messages.rateLimited));
            }
          }
          logger.warn('auth operation unavailable', { operation: 'login', requestId: request.id });
          return reply.code(503).send(errorBody('SERVICE_UNAVAILABLE', messages.unavailable));
        }
      },
    );

    authRoutes.get('/auth/me', async (request, reply) => {
      try {
        return reply.code(200).send({ user: await requireUser(request) });
      } catch (error) {
        if (error instanceof UnauthenticatedError) {
          return reply.code(401).send(errorBody('UNAUTHENTICATED', messages.unauthorized));
        }
        logger.warn('auth operation unavailable', { operation: 'me', requestId: request.id });
        return reply.code(503).send(errorBody('SERVICE_UNAVAILABLE', messages.unavailable));
      }
    });

    authRoutes.post('/auth/logout', async (request, reply) => {
      const token = getBearerToken(request);
      if (!token) {
        return reply.code(400).send(errorBody('INVALID_AUTHORIZATION', messages.invalidAuthorization));
      }

      try {
        await service.logout(token);
        return reply.code(204).send();
      } catch {
        logger.warn('auth operation unavailable', { operation: 'logout', requestId: request.id });
        return reply.code(503).send(errorBody('SERVICE_UNAVAILABLE', messages.unavailable));
      }
    });
  });
}
