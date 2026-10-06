import { lazy, Suspense, useMemo } from 'react';
import { Alert, Button, Center, Loader, Stack, Text } from '@mantine/core';
import { createOperatorApi } from '../lib/operator/operator-api';
import { useAppSession } from '../features/auth/hooks/use-app-session';
import { PlayerShell } from './player-shell';

const AuthScreen = lazy(() => import('../pages/auth-page').then((module) => ({ default: module.AuthScreen })));

/** App composition root: session states choose which top-level view is rendered. */
export function App(): React.JSX.Element {
  const api = useMemo(() => createOperatorApi(), []);
  const { boot, retry, authenticated, endSession, dismissNotice } = useAppSession(api);

  if (boot.phase === 'checking') {
    return (
      <Center mih="100dvh">
        <Stack align="center" gap="xs">
          <Loader />
          <Text size="sm" c="dimmed">Loading your session…</Text>
        </Stack>
      </Center>
    );
  }

  if (boot.phase === 'unavailable') {
    return (
      <Center mih="100dvh" p="md">
        <Alert color="red" title="Operator unavailable" maw={480}>
          <Stack gap="sm">
            <Text size="sm">{boot.message} Your saved session was kept; try again when the operator is back.</Text>
            <Button size="xs" onClick={retry}>Try again</Button>
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
          onAuthenticated={authenticated}
        />
      </Suspense>
    );
  }

  return <PlayerShell api={api} session={boot.session} onSessionEnded={endSession} />;
}
