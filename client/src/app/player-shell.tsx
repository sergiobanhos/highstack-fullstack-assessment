import { lazy, Suspense, useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ActionIcon, AppShell, Badge, Center, Container, Group, Loader, Menu, Tabs, Text } from '@mantine/core';
import type { OperatorApi } from '../lib/operator/operator-api';
import type { PlayerSession } from '../features/auth/model/session';
import { formatCents } from '../lib/money/money';
import { useAuthCommands } from '../features/auth/hooks/use-auth-commands';
import { usePlayerWallet } from '../features/wallet/hooks/use-wallet-data';
import { queryKeys } from '../lib/query/query-keys';
import { BrandIcon, BrandLogo } from '../components/ui';

const GameScreen = lazy(() => import('../pages/game-page').then((module) => ({ default: module.GameScreen })));
const WalletScreen = lazy(() => import('../pages/wallet-page').then((module) => ({ default: module.WalletScreen })));

type PlayerView = 'game' | 'wallet';

interface PlayerShellProps {
  api: OperatorApi;
  session: PlayerSession;
  onSessionEnded(notice: string | null): void;
}

export function PlayerShell({ api, session, onSessionEnded }: PlayerShellProps): React.JSX.Element {
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
    <AppShell className="hs-app" header={{ height: 76 }} padding="md">
      <AppShell.Header>
        <Group className="hs-header" h="100%" px={{ base: 'sm', sm: 'md', lg: 'xl' }} justify="space-between" wrap="nowrap">
          <Group className="hs-header__brand" gap="md" wrap="nowrap">
            <BrandLogo compact />
            <span className="hs-header__divider" aria-hidden="true" />
            <Text fw={650} className="hs-header__product">Crash</Text>
          </Group>
          <Group className="hs-header__actions" gap="sm" wrap="nowrap">
            <Tabs className="hs-nav" value={view} onChange={(value) => setView(value === 'wallet' ? 'wallet' : 'game')}>
              <Tabs.List>
                <Tabs.Tab value="game">Game</Tabs.Tab>
                <Tabs.Tab value="wallet">Wallet</Tabs.Tab>
              </Tabs.List>
            </Tabs>
            <Badge className="hs-balance" size="lg" variant="light" color="emerald" title="Available balance (USD)">
              <Group className="hs-balance__content" gap={8} wrap="nowrap">
                <BrandIcon name="wallet" />
                <span>{balanceCents === null ? '—' : formatCents(balanceCents)}</span>
              </Group>
            </Badge>
            <Menu position="bottom-end" shadow="md" withinPortal>
              <Menu.Target>
                <ActionIcon className="hs-account-trigger" variant="default" radius="xl" size={44} aria-label="Account menu">
                  <BrandIcon name="person" size={20} />
                </ActionIcon>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Label>{session.user.name}</Menu.Label>
                <Menu.Item
                  leftSection={<BrandIcon name="logout" />}
                  disabled={authCommands.logout.isPending}
                  onClick={() => void logout()}
                >
                  {authCommands.logout.isPending ? 'Signing out…' : 'Sign out'}
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </Group>
        </Group>
      </AppShell.Header>
      <AppShell.Main>
        <Container className="hs-page" size="xl" px={{ base: 'xs', sm: 'md' }}>
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
