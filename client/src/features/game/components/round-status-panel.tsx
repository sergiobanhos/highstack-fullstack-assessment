import { Alert, Group, Stack, Text } from '@mantine/core';
import type { ClientRoundState, ClientTickPoint, DownstreamConnection, UpstreamConnection } from '../data/operator-events.client';
import { ActionButton, StatusBadge, Surface } from '../../../components/ui';
import { useRoundCountdown } from '../hooks/use-round-countdown';

const PHASE_LABELS: Record<string, string> = {
  betting: 'Betting open',
  running: 'Round is live',
  crashed: 'Round crashed',
};

const UPSTREAM_LABELS: Record<UpstreamConnection, string> = {
  connected: 'Engine connected',
  reconnecting: 'Engine reconnecting',
  synchronizing: 'Synchronizing engine',
};

const DOWNSTREAM_LABELS: Record<DownstreamConnection, string> = {
  connecting: 'Stream connecting',
  open: 'Stream open',
  error: 'Stream reconnecting',
};

interface RoundStatusPanelProps {
  phase: string | null;
  roundId: string | null;
  sequence: number | null;
  multiplier: string;
  snapshot: ClientRoundState | null;
  chartPoints: ClientTickPoint[];
  stale: boolean;
  staleAlertVisible: boolean;
  upstream: UpstreamConnection;
  downstream: DownstreamConnection;
  sessionUnavailable: boolean;
  onRetrySession(): void;
}

function RoundChart({ points, multiplier, stale, phase }: {
  points: ClientTickPoint[];
  multiplier: string;
  stale: boolean;
  phase: string | null;
}): React.JSX.Element {
  // Keep a stable time scale so every new tick extends the trace in place.
  const maxElapsed = Math.max(60_000, ...points.map((point) => point.elapsedMs));
  const maxMultiplier = Math.max(2, ...points.map((point) => point.multiplier));
  const yTop = Math.ceil(maxMultiplier * 1.15);
  const plot = { left: 78, right: 982, top: 42, bottom: 378 };
  const xFor = (elapsed: number): number => plot.left + (elapsed / maxElapsed) * (plot.right - plot.left);
  const yFor = (value: number): number => plot.bottom - ((value - 1) / Math.max(1, yTop - 1)) * (plot.bottom - plot.top);
  const line = points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${xFor(point.elapsedMs)} ${yFor(point.multiplier)}`).join(' ');
  const yTicks = Array.from({ length: 5 }, (_, index) => 1 + ((yTop - 1) * index) / 4);
  const xTicks = [0, 0.25, 0.5, 0.75, 1];

  return (
    <div className="hs-round-chart" role="img" aria-label={`${phase === 'crashed' ? 'Crashed' : 'Current'} round multiplier ${multiplier}`}>
      <svg className="hs-round-chart__svg" viewBox="0 0 1000 430" preserveAspectRatio="none" aria-hidden="true">
        {yTicks.map((tick) => {
          const y = yFor(tick);
          return <g key={tick}>
            <line className="hs-round-chart__grid" x1={plot.left} x2={plot.right} y1={y} y2={y} />
            <text className="hs-round-chart__axis-label" x="8" y={y + 5}>{tick.toFixed(2)}x</text>
          </g>;
        })}
        {xTicks.map((fraction) => {
          const x = plot.left + fraction * (plot.right - plot.left);
          return <g key={fraction}>
            <line className="hs-round-chart__grid hs-round-chart__grid--vertical" x1={x} x2={x} y1={plot.top} y2={plot.bottom} />
            <text className="hs-round-chart__axis-label hs-round-chart__axis-label--x" x={x} y="414">{Math.round((maxElapsed / 1000) * fraction)}s</text>
          </g>;
        })}
        <path className="hs-round-chart__axis" d={`M ${plot.left} ${plot.top} V ${plot.bottom} H ${plot.right}`} />
        {points.length > 1 && <path className="hs-round-chart__line" d={line} />}
        {points.length > 0 && <circle className="hs-round-chart__point" cx={xFor(points[points.length - 1]!.elapsedMs)} cy={yFor(points[points.length - 1]!.multiplier)} r="7" />}
      </svg>
      <div className={`hs-round-chart__multiplier${phase === 'crashed' ? ' is-crashed' : ''}`} aria-live="polite">
        {multiplier}
      </div>
      {stale && <div className="hs-round-chart__frozen"><StatusBadge tone="warning">Frozen · waiting for sync</StatusBadge></div>}
    </div>
  );
}

export function RoundStatusPanel({
  phase,
  roundId,
  sequence,
  multiplier,
  snapshot,
  chartPoints,
  stale,
  staleAlertVisible,
  upstream,
  downstream,
  sessionUnavailable,
  onRetrySession,
}: RoundStatusPanelProps): React.JSX.Element {
  const countdown = useRoundCountdown(snapshot?.bettingEndsAt ?? null, phase === 'betting' && !stale);
  const statusTone = phase === 'crashed' ? 'danger' : phase === 'running' ? 'live' : phase === 'betting' ? 'success' : 'neutral';
  const description = phase === 'betting'
    ? 'Place your bet before the round starts.'
    : phase === 'crashed'
      ? `The round ended at ${multiplier}. Your bet status is shown below.`
      : phase === 'running'
        ? 'Cash out while the multiplier is rising.'
        : 'Waiting for the operator to send a synchronized round snapshot.';

  return (
    <Stack className="hs-round-panel" gap="sm">
      <Surface className="hs-round-panel__surface" p={{ base: 'sm', sm: 'md' }} radius="lg">
        <Group className="hs-round-panel__status" justify="space-between" align="center" wrap="wrap">
          <Group gap="sm" wrap="wrap">
            <StatusBadge tone={statusTone} size="lg" className="hs-round-phase">
              <span className="hs-round-phase__dot" aria-hidden="true" />
              {phase === null ? 'Waiting for state' : (PHASE_LABELS[phase] ?? phase)}
            </StatusBadge>
            {stale && <StatusBadge tone="warning">Reconnecting · frozen state</StatusBadge>}
          </Group>
          <Group className="hs-stream-health" gap="xs" wrap="wrap" aria-label="Connection health">
            <StatusBadge tone={upstream === 'connected' ? 'success' : 'warning'}>{UPSTREAM_LABELS[upstream]}</StatusBadge>
            <StatusBadge tone={downstream === 'open' ? 'success' : downstream === 'connecting' ? 'neutral' : 'warning'}>{DOWNSTREAM_LABELS[downstream]}</StatusBadge>
          </Group>
        </Group>

        <div className="hs-round-panel__intro">
          <div>
            <Text className="hs-round-panel__title" fw={700}>{phase === null ? 'Connecting to the round' : (PHASE_LABELS[phase] ?? phase)}</Text>
            <Text size="sm" c="dimmed">{description}</Text>
          </div>
          {countdown !== null && (
            <div className="hs-round-countdown">
              <Text size="xs" c="dimmed">Next round in</Text>
              <Text className="hs-round-countdown__value" fw={700}>{countdown}</Text>
            </div>
          )}
        </div>

        <RoundChart points={chartPoints} multiplier={multiplier} stale={stale} phase={phase} />
        <Text className="hs-round-meta" size="xs" c="dimmed">Round {roundId ?? '—'} <span aria-hidden="true">·</span> seq {sequence ?? '—'}</Text>
      </Surface>

      {stale && staleAlertVisible && (
        <Alert className="hs-stale-alert" color="yellow" title="State not synchronized" role="status">
          The last update is frozen. Bets and cashouts remain disabled until the operator synchronizes a fresh snapshot.
        </Alert>
      )}
      {sessionUnavailable && (
        <Alert className="hs-stale-alert" color="yellow" title="Game session unavailable">
          <Group justify="space-between" align="center" wrap="wrap">
            <Text size="sm">Could not prepare your game session right now.</Text>
            <ActionButton tone="secondary" size="sm" onClick={onRetrySession}>Try again</ActionButton>
          </Group>
        </Alert>
      )}
    </Stack>
  );
}
