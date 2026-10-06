import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  AppShell,
  Badge,
  Button,
  Center,
  Container,
  Group,
  Loader,
  Stack,
  Tabs,
  Text,
} from '@mantine/core';
import {
  createOperatorApi,
  isUnauthenticated,
  OperatorApiError,
  type AuthUser,
  type OperatorApi,
  type SessionInfo,
} from './operator-api';
import { formatCents } from './money';
import { AuthScreen } from './auth-screen';
import { GameScreen } from './game-screen';
import { WalletScreen } from './wallet-screen';
import { useAuthCommands } from './hooks/use-auth-commands';
import { useAuthSessionRestore } from './hooks/use-auth-session';
import { usePlayerWallet } from './hooks/use-wallet-data';
import { queryKeys } from './query-keys';

/**
 * Player client for the Crashsim operator.
 *
 * The browser only talks to the operator: REST for identity, wallet, bets and
 * payouts, and the operator SSE for the global round. The engine key and
 * webhook secret stay server-side.
 */

const TOKEN_STORAGE_KEY = 'operator.sessionToken';

interface Session {
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
      <AuthScreen
        api={api}
        notice={boot.notice}
        onNoticeDismissed={dismissNotice}
        onAuthenticated={handleAuthenticated}
      />
    );
  }

  return (
    <PlayerApp api={api} session={boot.session} onSessionEnded={endSession} />
  );
}

type PlayerView = 'game' | 'wallet';

interface PlayerAppProps {
  api: OperatorApi;
  session: Session;
  onSessionEnded(notice: string | null): void;
}

function PlayerApp({ api, session, onSessionEnded }: PlayerAppProps): React.JSX.Element {
  const [view, setView] = useState<PlayerView>('game');
  const queryClient = useQueryClient();

  const handleUnauthorized = useCallback((): void => {
    onSessionEnded('Your session expired. Please sign in again.');
  }, [onSessionEnded]);

  const walletQuery = usePlayerWallet({
    api,
    token: session.token,
    playerId: session.user.id,
    onUnauthorized: handleUnauthorized,
  });
  const balanceCents = walletQuery.data?.balanceCents ?? null;
  const refreshWallet = useCallback(async (): Promise<void> => {
    await walletQuery.refetch();
  }, [walletQuery.refetch]);
  const authCommands = useAuthCommands(api);

  const logout = async (): Promise<void> => {
    let notice: string | null = null;
    try {
      await authCommands.logout.mutateAsync(session.token);
    } catch {
      notice =
        'You were signed out in this browser, but the operator could not confirm the logout.';
    } finally {
      queryClient.removeQueries({ queryKey: queryKeys.player(session.user.id) });
      onSessionEnded(notice);
    }
  };

  return (
    <AppShell header={{ height: 64 }} padding="md">
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between" wrap="nowrap">
          <Group gap="xs" wrap="nowrap">
            <Text fw={700}>Crashsim</Text>
            <Badge variant="light" visibleFrom="sm">
              local operator
            </Badge>
          </Group>
          <Group gap="sm" wrap="nowrap">
            <Tabs value={view} onChange={(value) => setView(value === 'wallet' ? 'wallet' : 'game')}>
              <Tabs.List>
                <Tabs.Tab value="game">Game</Tabs.Tab>
                <Tabs.Tab value="wallet">Wallet</Tabs.Tab>
              </Tabs.List>
            </Tabs>
            <Badge size="lg" variant="light" color="teal" title="Available balance (USD)">
              {balanceCents === null ? '—' : formatCents(balanceCents)}
            </Badge>
            <Text size="sm" visibleFrom="md">
              {session.user.name}
            </Text>
            <Button size="xs" variant="default" loading={authCommands.logout.isPending} onClick={() => void logout()}>
              Sign out
            </Button>
          </Group>
        </Group>
      </AppShell.Header>
      <AppShell.Main>
        <Container size="lg">
          {view === 'game' ? (
            <GameScreen
              api={api}
              token={session.token}
              playerId={session.user.id}
              onUnauthorized={handleUnauthorized}
              onWalletChanged={refreshWallet}
            />
          ) : (
            <WalletScreen
              api={api}
              token={session.token}
              playerId={session.user.id}
              onUnauthorized={handleUnauthorized}
            />
          )}
        </Container>
      </AppShell.Main>
    </AppShell>
  );
}
