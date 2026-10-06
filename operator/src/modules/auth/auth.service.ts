import type { OperatorDatabase } from '../../db';
import { AuthServiceError } from './auth.errors';
import type { AuthService } from './auth.contracts';
import { createLoginPlayer } from './usecases/login-player';
import { createLogoutPlayer } from './usecases/logout-player';
import { createPasswordHasher } from './usecases/password-hasher';
import { createRegisterPlayer } from './usecases/register-player';
import { createResolveSession } from './usecases/resolve-session';

export { AuthServiceError } from './auth.errors';
export type {
  AuthenticatedPlayer,
  AuthService,
  AuthServiceErrorCode,
  LoginPlayerInput,
  LoginResult,
  RegisterPlayerInput,
} from './auth.contracts';

export interface CreateAuthServiceOptions {
  db: OperatorDatabase;
  sessionTtlSeconds: number;
}

const MIN_SESSION_TTL_SECONDS = 60;
const MAX_SESSION_TTL_SECONDS = 604_800;

export function validateSessionTtlSeconds(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < MIN_SESSION_TTL_SECONDS ||
    value > MAX_SESSION_TTL_SECONDS
  ) {
    throw new Error('AUTH_SESSION_TTL_SECONDS must be an integer between 60 and 604800');
  }

  return value;
}

/** Public auth facade: compose the business flows and expose their stable contract. */
export function createAuthService({ db, sessionTtlSeconds }: CreateAuthServiceOptions): AuthService {
  const ttlSeconds = validateSessionTtlSeconds(sessionTtlSeconds);
  const passwordHasher = createPasswordHasher();

  return {
    register: createRegisterPlayer({ db, passwordHasher }),
    login: createLoginPlayer({ db, passwordHasher, sessionTtlSeconds: ttlSeconds }),
    logout: createLogoutPlayer({ db }),
    resolveSession: createResolveSession({ db }),
  };
}
