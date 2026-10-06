import { and, eq, isNull, sql } from 'drizzle-orm';
import type { OperatorDatabase } from '../../../db';
import { authSessions, players } from '../auth.schema';
import type { AuthenticatedPlayer } from '../auth.contracts';
import { hashSessionToken } from './session-token';

export function createResolveSession({ db }: {
  db: OperatorDatabase;
}): (token: string) => Promise<AuthenticatedPlayer | null> {
  return async (token) => {
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
  };
}
