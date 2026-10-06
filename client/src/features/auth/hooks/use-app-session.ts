import { useCallback, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { isUnauthenticated, OperatorApiError, type OperatorApi, type SessionInfo } from '../../../lib/operator/operator-api';
import { queryKeys } from '../../../lib/query/query-keys';
import type { PlayerSession } from '../model/session';
import { useAuthSessionRestore } from './use-auth-session';

const TOKEN_STORAGE_KEY = 'operator.sessionToken';

type BootState =
  | { phase: 'checking' }
  | { phase: 'unavailable'; message: string }
  | { phase: 'unauthenticated'; notice: string | null }
  | { phase: 'authenticated'; session: PlayerSession };

function writeStoredToken(token: string): void {
  try { sessionStorage.setItem(TOKEN_STORAGE_KEY, token); } catch { /* This tab can continue without storage. */ }
}

function clearStoredToken(): void {
  try { sessionStorage.removeItem(TOKEN_STORAGE_KEY); } catch { /* Nothing else to clean up. */ }
}

export function useAppSession(api: OperatorApi) {
  const queryClient = useQueryClient();
  const [boot, setBoot] = useState<BootState>({ phase: 'checking' });
  const [attempt, setAttempt] = useState(0);
  const restoreQuery = useAuthSessionRestore(api, attempt);

  useEffect(() => {
    if (restoreQuery.isPending) {
      setBoot({ phase: 'checking' });
      return;
    }
    if (restoreQuery.error !== null) {
      if (isUnauthenticated(restoreQuery.error)) {
        clearStoredToken();
        setBoot({ phase: 'unauthenticated', notice: 'Your session expired. Please sign in again.' });
      } else {
        setBoot({
          phase: 'unavailable',
          message: restoreQuery.error instanceof OperatorApiError ? restoreQuery.error.message : 'Could not reach the operator.',
        });
      }
      return;
    }
    if (restoreQuery.data === null) {
      setBoot({ phase: 'unauthenticated', notice: null });
      return;
    }
    if (restoreQuery.data !== undefined) setBoot({ phase: 'authenticated', session: restoreQuery.data });
  }, [restoreQuery.data, restoreQuery.error, restoreQuery.isPending]);

  const authenticated = useCallback((session: SessionInfo): void => {
    writeStoredToken(session.token);
    setBoot({ phase: 'authenticated', session: { token: session.token, user: session.user } });
  }, []);

  const endSession = useCallback((notice: string | null): void => {
    clearStoredToken();
    queryClient.removeQueries({ queryKey: queryKeys.player(boot.phase === 'authenticated' ? boot.session.user.id : '') });
    queryClient.removeQueries({ queryKey: ['auth', 'restore'] });
    setBoot({ phase: 'unauthenticated', notice });
  }, [boot, queryClient]);

  return {
    boot,
    retry: () => setAttempt((count) => count + 1),
    authenticated,
    endSession,
    dismissNotice: () => setBoot((current) => current.phase === 'unauthenticated' ? { ...current, notice: null } : current),
  };
}
