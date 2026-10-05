import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { OperatorDatabase } from '../../db';
import { registerAuthController, type AuthRouteLogger } from './auth.controller';
import { createAuthService, type AuthenticatedPlayer } from './auth.service';
import { readBearerToken } from './auth.validation';

export { type AuthenticatedPlayer } from './auth.service';

/** Raised when a request has no valid player session. Other failures remain operational errors. */
export class UnauthenticatedError extends Error {
  constructor() {
    super('Authentication required');
    this.name = 'UnauthenticatedError';
  }
}

export interface AuthModuleOptions {
  app: FastifyInstance;
  db: OperatorDatabase;
  sessionTtlSeconds: number;
  logger: AuthRouteLogger;
}

export interface AuthModule {
  requireUser(request: FastifyRequest): Promise<AuthenticatedPlayer>;
}

function bearerToken(request: FastifyRequest): string | null {
  return readBearerToken(request.headers.authorization);
}

/** Composes the REST controller and exports request-scoped authenticated identity. */
export function createAuthModule({ app, db, sessionTtlSeconds, logger }: AuthModuleOptions): AuthModule {
  const service = createAuthService({ db, sessionTtlSeconds });
  const identityByRequest = new WeakMap<FastifyRequest, Promise<AuthenticatedPlayer>>();

  const requireUser = (request: FastifyRequest): Promise<AuthenticatedPlayer> => {
    const existing = identityByRequest.get(request);
    if (existing) return existing;

    const identity = (async () => {
      const token = bearerToken(request);
      if (!token) throw new UnauthenticatedError();
      const player = await service.resolveSession(token);
      if (!player) throw new UnauthenticatedError();
      return player;
    })();

    identityByRequest.set(request, identity);
    return identity;
  };

  registerAuthController({ app, service, requireUser, logger });
  return { requireUser };
}
