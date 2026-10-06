import type { OperatorDatabase } from '../../../db';
import { players } from '../auth.schema';
import { AuthServiceError } from '../auth.errors';
import type { AuthenticatedPlayer, RegisterPlayerInput } from '../auth.contracts';
import type { PasswordHasher } from './password-hasher';
import { normalizeEmail } from './normalize-email';

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

export function createRegisterPlayer({ db, passwordHasher }: {
  db: OperatorDatabase;
  passwordHasher: PasswordHasher;
}): (input: RegisterPlayerInput) => Promise<AuthenticatedPlayer> {
  return async ({ name, email, password }) => {
    const normalizedName = name.trim();
    const normalizedEmail = normalizeEmail(email);
    const passwordHash = await passwordHasher.hash(password);

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
  };
}
