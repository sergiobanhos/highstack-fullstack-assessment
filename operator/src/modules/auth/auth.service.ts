import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { OperatorDatabase } from '../../db';
import { authSessions, players } from './auth.schema';

const PASSWORD_OPTIONS = {
  algorithm: 'argon2id' as const,
  memoryCost: 65_536,
  timeCost: 2,
};

// A fixed, valid Argon2id hash keeps unknown-email login checks at the same cost.
const DUMMY_PASSWORD_HASH =
  '$argon2id$v=19$m=65536,t=2,p=1$YcyRAqI5I0Kz7gPRX8P2o3w/8ai+Hz1xXzZYyaSKh+U$mFwCFiOYFrAYmuzEfWsqksLnjRmnGhx7jdN7FWdyJ4A';

const MAX_CONCURRENT_HASH_OPERATIONS = 2;
const MIN_SESSION_TTL_SECONDS = 60;
const MAX_SESSION_TTL_SECONDS = 604_800;

export type AuthServiceErrorCode = 'EMAIL_IN_USE' | 'INVALID_CREDENTIALS' | 'RATE_LIMITED';

const ERROR_MESSAGES: Record<AuthServiceErrorCode, string> = {
  EMAIL_IN_USE: 'Email is already registered',
  INVALID_CREDENTIALS: 'Invalid email or password',
  RATE_LIMITED: 'Too many authentication operations',
};

export class AuthServiceError extends Error {
  constructor(readonly code: AuthServiceErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'AuthServiceError';
  }
}

export interface AuthenticatedPlayer {
  id: string;
  name: string;
  email: string;
}

export interface RegisterPlayerInput {
  name: string;
  email: string;
  password: string;
}

export interface LoginPlayerInput {
  email: string;
  password: string;
}

export interface LoginResult {
  token: string;
  expiresAt: Date;
  user: AuthenticatedPlayer;
}

export interface AuthService {
  register(input: RegisterPlayerInput): Promise<AuthenticatedPlayer>;
  login(input: LoginPlayerInput): Promise<LoginResult>;
  logout(token: string): Promise<void>;
  resolveSession(token: string): Promise<AuthenticatedPlayer | null>;
}

export interface CreateAuthServiceOptions {
  db: OperatorDatabase;
  sessionTtlSeconds: number;
}

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

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function findPostgresError(error: unknown): { code?: unknown; constraint_name?: unknown } | undefined {
  let current: unknown = error;
  while (current !== null && typeof current === 'object') {
    if ('code' in current || 'constraint_name' in current) {
      return current as { code?: unknown; constraint_name?: unknown };
    }
    if (!('cause' in current)) return undefined;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function isPlayerEmailConflict(error: unknown): boolean {
  const postgresError = findPostgresError(error);
  return postgresError?.code === '23505' && postgresError.constraint_name === 'players_email_unique';
}

export function createAuthService({ db, sessionTtlSeconds }: CreateAuthServiceOptions): AuthService {
  const ttlSeconds = validateSessionTtlSeconds(sessionTtlSeconds);
  let activeHashOperations = 0;

  async function withHashCapacity<T>(operation: () => Promise<T>): Promise<T> {
    if (activeHashOperations >= MAX_CONCURRENT_HASH_OPERATIONS) {
      throw new AuthServiceError('RATE_LIMITED');
    }

    activeHashOperations += 1;
    try {
      return await operation();
    } finally {
      activeHashOperations -= 1;
    }
  }

  return {
    async register({ name, email, password }) {
      const normalizedName = name.trim();
      const normalizedEmail = normalizeEmail(email);
      const passwordHash = await withHashCapacity(() => Bun.password.hash(password, PASSWORD_OPTIONS));

      try {
        const [player] = await db
          .insert(players)
          .values({ name: normalizedName, email: normalizedEmail, passwordHash })
          .returning({ id: players.id, name: players.name, email: players.email });

        if (!player) throw new Error('Player registration did not return a row');
        return player;
      } catch (error) {
        if (isPlayerEmailConflict(error)) throw new AuthServiceError('EMAIL_IN_USE');
        throw error;
      }
    },

    async login({ email, password }) {
      const normalizedEmail = normalizeEmail(email);
      const [player] = await db
        .select({
          id: players.id,
          name: players.name,
          email: players.email,
          passwordHash: players.passwordHash,
        })
        .from(players)
        .where(eq(players.email, normalizedEmail))
        .limit(1);

      const passwordMatches = await withHashCapacity(() =>
        Bun.password.verify(password, player?.passwordHash ?? DUMMY_PASSWORD_HASH),
      );
      if (!player || !passwordMatches) throw new AuthServiceError('INVALID_CREDENTIALS');

      const token = randomBytes(32).toString('base64url');
      const expiresAt = new Date(Date.now() + ttlSeconds * 1_000);
      await db.insert(authSessions).values({
        playerId: player.id,
        tokenHash: hashSessionToken(token),
        expiresAt,
      });

      return {
        token,
        expiresAt,
        user: { id: player.id, name: player.name, email: player.email },
      };
    },

    async logout(token) {
      await db
        .update(authSessions)
        .set({ revokedAt: new Date() })
        .where(and(eq(authSessions.tokenHash, hashSessionToken(token)), isNull(authSessions.revokedAt)));
    },

    async resolveSession(token) {
      if (!token) return null;

      const [player] = await db
        .select({ id: players.id, name: players.name, email: players.email })
        .from(authSessions)
        .innerJoin(players, eq(authSessions.playerId, players.id))
        .where(
          and(
            eq(authSessions.tokenHash, hashSessionToken(token)),
            isNull(authSessions.revokedAt),
            sql`${authSessions.expiresAt} > now()`,
          ),
        )
        .limit(1);

      return player ?? null;
    },
  };
}
