import { useCallback, useEffect, useMemo, useState } from 'react';
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

function readStoredToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

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
  const [boot, setBoot] = useState<BootState>({ phase: 'checking' });
  const [bootAttempt, setBootAttempt] = useState(0);

  useEffect(() => {
    const storedToken = readStoredToken();
    if (storedToken === null) {
      setBoot({ phase: 'unauthenticated', notice: null });
      return;
    }

    let cancelled = false;
    setBoot({ phase: 'checking' });
    void (async () => {
      try {
        const user = await api.me(storedToken);
        if (!cancelled) setBoot({ phase: 'authenticated', session: { token: storedToken, user } });
      } catch (error) {
        if (cancelled) return;
        if (isUnauthenticated(error)) {
          // The stored credential is no longer valid; discard it and ask again.
          clearStoredToken();
          setBoot({ phase: 'unauthenticated', notice: 'Your session expired. Please sign in again.' });
          return;
        }
        // The credential may still be valid: keep it and offer a retry.
        setBoot({
          phase: 'unavailable',
          message:
            error instanceof OperatorApiError
              ? error.message
              : 'Could not reach the operator.',
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, bootAttempt]);

  const handleAuthenticated = useCallback((session: SessionInfo): void => {
    writeStoredToken(session.token);
    setBoot({ phase: 'authenticated', session: { token: session.token, user: session.user } });
  }, []);

  const endSession = useCallback((notice: string | null): void => {
    clearStoredToken();
    setBoot({ phase: 'unauthenticated', notice });
  }, []);

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
  const [balanceCents, setBalanceCents] = useState<number | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);

  const handleUnauthorized = useCallback((): void => {
    onSessionEnded('Your session expired. Please sign in again.');
  }, [onSessionEnded]);

  const refreshWallet = useCallback(async (): Promise<void> => {
    try {
      const wallet = await api.getWallet(session.token);
      setBalanceCents(wallet.balanceCents);
    } catch (error) {
      if (isUnauthenticated(error)) handleUnauthorized();
    }
  }, [api, session.token, handleUnauthorized]);

  useEffect(() => {
    void refreshWallet();
  }, [refreshWallet]);

  const logout = async (): Promise<void> => {
    setLoggingOut(true);
    let notice: string | null = null;
    try {
      await api.logout(session.token);
    } catch {
      notice =
        'You were signed out in this browser, but the operator could not confirm the logout.';
    } finally {
      setLoggingOut(false);
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
            <Button size="xs" variant="default" loading={loggingOut} onClick={() => void logout()}>
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
              onUnauthorized={handleUnauthorized}
              onWalletChanged={refreshWallet}
            />
          ) : (
            <WalletScreen
              api={api}
              token={session.token}
              balanceCents={balanceCents}
              onBalanceChange={setBalanceCents}
              onUnauthorized={handleUnauthorized}
            />
          )}
        </Container>
      </AppShell.Main>
    </AppShell>
  );
}
