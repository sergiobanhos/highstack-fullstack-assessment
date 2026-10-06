import type { FinancialModule } from '../../financial/financial.module';
import type { CrashsimHttpClient } from '../../../integrations/crashsim/http.client';

export interface EnsurePlayerSessionDeps {
  financial: Pick<FinancialModule, 'ensureWallet'>;
  engine: Pick<CrashsimHttpClient, 'createSession'>;
  sessions: Map<string, string>;
  sessionCreations: Map<string, Promise<string>>;
}

/** Ensures a wallet and one process-local Crashsim session per player. */
export function createEnsurePlayerSession({
  financial,
  engine,
  sessions,
  sessionCreations,
}: EnsurePlayerSessionDeps): (playerId: string) => Promise<string> {
  return async (playerId) => {
    const existing = sessions.get(playerId);
    if (existing) return existing;

    const inFlight = sessionCreations.get(playerId);
    if (inFlight) return inFlight;

    const creation = (async () => {
      await financial.ensureWallet(playerId);
      const session = await engine.createSession(playerId);
      sessions.set(playerId, session.sessionId);
      return session.sessionId;
    })();
    sessionCreations.set(playerId, creation);
    try {
      return await creation;
    } finally {
      if (sessionCreations.get(playerId) === creation) sessionCreations.delete(playerId);
    }
  };
}
