import { Accordion, Alert, Badge, Button, Code, Divider, Group, Loader, Stack, Text } from '@mantine/core';
import { formatMultiplier } from '../../../lib/money/money';
import type { ProofCheck, RoundProof } from '../model/fairness';
import type { RevealedRound } from '../data/operator-events.client';

function ProofBadge({ check, label }: { check: ProofCheck; label: string }): React.JSX.Element {
  const color = check === 'match' ? 'teal' : check === 'mismatch' ? 'red' : 'gray';
  const text = check === 'match' ? 'matches' : check === 'mismatch' ? 'mismatch' : 'unavailable';
  return <Badge color={color} variant="light">{label}: {text}</Badge>;
}

interface RoundProofPanelProps {
  commitmentHash: string | null;
  revealed: RevealedRound | null;
  proof: { status: 'checking' | 'done' | 'failed'; result: RoundProof | null } | null;
  onRetry(): void;
}

export function RoundProofPanel({ commitmentHash, revealed, proof, onRetry }: RoundProofPanelProps): React.JSX.Element {
  return (
    <Accordion.Item value="fairness">
      <Accordion.Control>Round proof (provably fair)</Accordion.Control>
      <Accordion.Panel>
        <Stack gap="xs">
          <Text size="xs" c="dimmed">
            The operator publishes the SHA-256 commitment of the seed before the round and reveals it after the crash. This browser recomputes the crash point with the engine algorithm.
          </Text>
          <Group gap="xs">
            <Text size="sm" fw={500}>Current round commitment:</Text>
            <Text size="xs" ff="monospace" title={commitmentHash ?? undefined}>{commitmentHash === null ? '—' : `${commitmentHash.slice(0, 16)}…`}</Text>
          </Group>
          <Divider />
          {revealed === null ? <Text size="sm" c="dimmed">No round has finished since this screen was opened.</Text> : (
            <Stack gap="xs">
              <Group gap="xs">
                <Text size="sm">Last finished round: <Text span ff="monospace" size="sm">{revealed.roundId.slice(0, 8)}…</Text></Text>
                <Badge variant="light">{revealed.crashPoint.toFixed(2)}x</Badge>
                {proof?.status === 'checking' && <Loader size="xs" />}
                {proof?.status === 'failed' && <Badge color="yellow" variant="light">verification failed</Badge>}
              </Group>
              {proof?.status === 'done' && proof.result !== null && (
                <Group gap="xs">
                  <ProofBadge check={proof.result.commitment} label="Commitment" />
                  <ProofBadge check={proof.result.result} label="Result" />
                  {proof.result.reproducedHundredths !== null && <Text size="xs" c="dimmed">recomputed: {formatMultiplier(proof.result.reproducedHundredths)}</Text>}
                </Group>
              )}
              {proof?.status === 'done' && proof.result !== null && (proof.result.commitment === 'mismatch' || proof.result.result === 'mismatch') && (
                <Alert color="red" title="Round proof mismatch">
                  The recomputed result does not match what was displayed. Save the round id and avoid betting until the difference is understood.
                  <Code block mt="xs" style={{ wordBreak: 'break-all' }}>{revealed.roundId}</Code>
                </Alert>
              )}
              {revealed.serverSeedHash === null && <Text size="xs" c="dimmed">This round commitment was not captured in this session; only the result could be recomputed.</Text>}
              <div><Text size="sm">Revealed seed:</Text><Code block style={{ wordBreak: 'break-all' }}>{revealed.serverSeed}</Code></div>
              <Group><Button size="compact-xs" variant="default" onClick={onRetry}>Verify again</Button></Group>
            </Stack>
          )}
        </Stack>
      </Accordion.Panel>
    </Accordion.Item>
  );
}
