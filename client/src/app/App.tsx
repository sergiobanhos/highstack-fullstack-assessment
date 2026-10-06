import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Center,
  Loader,
  Stack,
  Text,
} from '@mantine/core';
import {
  createOperatorApi,
  isUnauthenticated,
  OperatorApiError,
  type AuthUser,
  type SessionInfo,
} from '../lib/operator/operator-api';
import { useAuthSessionRestore } from '../features/auth/hooks/use-auth-session';
import { queryKeys } from '../lib/query/query-keys';
import { PlayerShell } from './player-shell';

const AuthScreen = lazy(() => import('../pages/auth-page').then((module) => ({ default: module.AuthScreen })));

/**
 * Player client for the Crashsim operator.
 *
 * The browser only talks to the operator: REST for identity, wallet, bets and
 * payouts, and the operator SSE for the global round. The engine key and
 * webhook secret stay server-side.
 */

const TOKEN_STORAGE_KEY = 'operator.sessionToken';

export interface Session {
  token: string;
  user: AuthUser;
}

type BootState =
  | { phase: 'checking' }
  | { phase: 'unavailable'; message: string }
  | { phase: 'unauthenticated'; notice: string | null }
  | { phase: 'authenticated'; session: Session };

function writeStoredToken(token: string): void {
  try {
    sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
  } catch {
    // The session still works for this tab lifetime.
  }
}

function clearStoredToken(): void {
  try {
    sessionStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // Nothing else to clean up.
  }
}

export function App(): React.JSX.Element {
  const api = useMemo(() => createOperatorApi(), []);
  const queryClient = useQueryClient();
  const [boot, setBoot] = useState<BootState>({ phase: 'checking' });
  const [bootAttempt, setBootAttempt] = useState(0);
  const restoreQuery = useAuthSessionRestore(api, bootAttempt);

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
    if (restoreQuery.data !== undefined) {
      setBoot({ phase: 'authenticated', session: restoreQuery.data });
    }
  }, [restoreQuery.data, restoreQuery.error, restoreQuery.isPending]);

  const handleAuthenticated = useCallback((session: SessionInfo): void => {
    writeStoredToken(session.token);
    setBoot({ phase: 'authenticated', session: { token: session.token, user: session.user } });
  }, []);

  const endSession = useCallback((notice: string | null): void => {
    clearStoredToken();
    queryClient.removeQueries({ queryKey: queryKeys.player(boot.phase === 'authenticated' ? boot.session.user.id : '') });
    queryClient.removeQueries({ queryKey: ['auth', 'restore'] });
    setBoot({ phase: 'unauthenticated', notice });
  }, [boot, queryClient]);

  const dismissNotice = useCallback((): void => {
    setBoot((current) =>
      current.phase === 'unauthenticated' ? { ...current, notice: null } : current,
    );
  }, []);

  if (boot.phase === 'checking') {
    return (
      <Center mih="100dvh">
        <Stack align="center" gap="xs">
          <Loader />
          <Text size="sm" c="dimmed">
            Loading your session…
          </Text>
        </Stack>
      </Center>
    );
  }

  if (boot.phase === 'unavailable') {
    return (
      <Center mih="100dvh" p="md">
        <Alert color="red" title="Operator unavailable" maw={480}>
          <Stack gap="sm">
            <Text size="sm">
              {boot.message} Your saved session was kept; try again when the operator is back.
            </Text>
            <Button size="xs" onClick={() => setBootAttempt((count) => count + 1)}>
              Try again
            </Button>
          </Stack>
        </Alert>
      </Center>
    );
  }

  if (boot.phase === 'unauthenticated') {
    return (
      <Suspense fallback={<Center mih="100dvh"><Loader /></Center>}>
        <AuthScreen
          api={api}
          notice={boot.notice}
          onNoticeDismissed={dismissNotice}
          onAuthenticated={handleAuthenticated}
        />
      </Suspense>
    );
  }

  return (
    <PlayerShell api={api} session={boot.session} onSessionEnded={endSession} />
  );
}
