import { lazy, Suspense, useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AppShell, Badge, Button, Center, Container, Group, Loader, Tabs, Text } from '@mantine/core';
import type { OperatorApi } from '../lib/operator/operator-api';
import type { Session } from './App';
import { formatCents } from '../lib/money/money';
import { useAuthCommands } from '../features/auth/hooks/use-auth-commands';
import { usePlayerWallet } from '../features/wallet/hooks/use-wallet-data';
import { queryKeys } from '../lib/query/query-keys';

const GameScreen = lazy(() => import('../pages/game-page').then((module) => ({ default: module.GameScreen })));
const WalletScreen = lazy(() => import('../pages/wallet-page').then((module) => ({ default: module.WalletScreen })));

type PlayerView = 'game' | 'wallet';

interface PlayerAppProps {
  api: OperatorApi;
  session: Session;
  onSessionEnded(notice: string | null): void;
}

export function PlayerShell({ api, session, onSessionEnded }: PlayerAppProps): React.JSX.Element {
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
          <Suspense fallback={<Center mih="30vh"><Loader size="sm" /></Center>}>{view === 'game' ? (
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
          )}</Suspense>
        </Container>
      </AppShell.Main>
    </AppShell>
  );
}
