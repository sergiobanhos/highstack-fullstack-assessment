import { and, eq, isNull } from 'drizzle-orm';
import type { OperatorDatabase } from '../../../db';
import { authSessions } from '../auth.schema';
import { hashSessionToken } from './session-token';

export function createLogoutPlayer({ db }: { db: OperatorDatabase }): (token: string) => Promise<void> {
  return async (token) => {
    await db
      .update(authSessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(authSessions.tokenHash, hashSessionToken(token)), isNull(authSessions.revokedAt)));
  };
}
