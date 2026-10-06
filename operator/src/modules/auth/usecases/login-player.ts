import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { OperatorDatabase } from '../../../db';
import { authSessions, players } from '../auth.schema';
import { AuthServiceError } from '../auth.errors';
import type { LoginPlayerInput, LoginResult } from '../auth.contracts';
import type { PasswordHasher } from './password-hasher';
import { normalizeEmail } from './normalize-email';
import { hashSessionToken } from './session-token';

export function createLoginPlayer({ db, passwordHasher, sessionTtlSeconds }: {
  db: OperatorDatabase;
  passwordHasher: PasswordHasher;
  sessionTtlSeconds: number;
}): (input: LoginPlayerInput) => Promise<LoginResult> {
  return async ({ email, password }) => {
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

    const passwordMatches = await passwordHasher.verify(password, player?.passwordHash);
    if (!player || !passwordMatches) throw new AuthServiceError('INVALID_CREDENTIALS');

    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + sessionTtlSeconds * 1_000);
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
  };
}
