import { Alert, Badge, Button, Group, Paper, Stack, Text, Title } from '@mantine/core';
import type { DownstreamConnection, UpstreamConnection } from '../data/operator-events.client';

const PHASE_LABELS: Record<string, string> = {
  betting: 'Betting open',
  running: 'Round running',
  crashed: 'Crashed',
};

const PHASE_COLORS: Record<string, string> = {
  betting: 'teal',
  running: 'blue',
  crashed: 'red',
};

const UPSTREAM_LABELS: Record<UpstreamConnection, string> = {
  connected: 'engine connected',
  reconnecting: 'engine reconnecting',
  synchronizing: 'engine syncing',
};

const DOWNSTREAM_LABELS: Record<DownstreamConnection, string> = {
  connecting: 'stream connecting',
  open: 'stream open',
  error: 'stream error',
};

interface RoundStatusPanelProps {
  phase: string | null;
  roundId: string | null;
  sequence: number | null;
  multiplier: string;
  stale: boolean;
  staleAlertVisible: boolean;
  upstream: UpstreamConnection;
  downstream: DownstreamConnection;
  sessionUnavailable: boolean;
  onRetrySession(): void;
}

export function RoundStatusPanel({
  phase,
  roundId,
  sequence,
  multiplier,
  stale,
  staleAlertVisible,
  upstream,
  downstream,
  sessionUnavailable,
  onRetrySession,
}: RoundStatusPanelProps): React.JSX.Element {
  return (
    <Stack gap="md">
      <Paper withBorder p="md" radius="md">
        <Group justify="space-between" align="flex-start" wrap="wrap">
          <div>
            <Group gap="xs">
              <Badge size="lg" color={phase === null ? 'gray' : (PHASE_COLORS[phase] ?? 'gray')}>
                {phase === null ? 'Waiting for state' : (PHASE_LABELS[phase] ?? phase)}
              </Badge>
              {stale && <Badge color="yellow">Reconnecting — frozen state</Badge>}
            </Group>
            <Title order={1} mt="xs" aria-live="polite">{multiplier}</Title>
            <Text size="sm" c="dimmed">Round {roundId ?? '—'} · seq {sequence ?? '—'}</Text>
          </div>
          <Stack gap={4} miw={220}>
            <Badge variant="light" color={upstream === 'connected' ? 'teal' : 'yellow'} fullWidth>
              {UPSTREAM_LABELS[upstream]}
            </Badge>
            <Badge
              variant="light"
              color={downstream === 'open' ? 'teal' : downstream === 'connecting' ? 'gray' : 'yellow'}
              fullWidth
            >
              {DOWNSTREAM_LABELS[downstream]}
            </Badge>
          </Stack>
        </Group>
      </Paper>
      {stale && staleAlertVisible && (
        <Alert color="yellow" title="State not synchronized">
          The last update received is frozen and bets/cashouts stay blocked until the operator synchronizes the round state again.
        </Alert>
      )}
      {sessionUnavailable && (
        <Alert color="yellow" title="Game session unavailable">
          <Group justify="space-between">
            <Text size="sm">Could not prepare your engine session right now.</Text>
            <Button size="xs" variant="light" onClick={onRetrySession}>Try again</Button>
          </Group>
        </Alert>
      )}
    </Stack>
  );
}
