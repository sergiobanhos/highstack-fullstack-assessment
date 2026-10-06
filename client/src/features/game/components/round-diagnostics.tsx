import { Accordion, Code, Divider, Stack, Text } from '@mantine/core';
import type { OperatorStreamState } from '../data/operator-events.client';
import { MAX_RETAINED_EVENTS } from '../data/operator-events.client';

interface RoundDiagnosticsProps {
  stream: OperatorStreamState;
  roundId: string | null;
  sequence: number | null;
}

export function RoundDiagnostics({ stream, roundId, sequence }: RoundDiagnosticsProps): React.JSX.Element {
  return (
    <Accordion.Item value="diagnostics">
      <Accordion.Control>Connection diagnostics</Accordion.Control>
      <Accordion.Panel>
        <Stack gap="xs">
          <Text size="xs" c="dimmed">Round {roundId ?? '—'} · seq {sequence ?? '—'} · retained events {stream.events.length}/{MAX_RETAINED_EVENTS}</Text>
          <Divider />
          <Code block mah={200} style={{ overflow: 'auto' }}>
            {stream.events.length === 0 ? 'no events received' : stream.events.map((event) => `#${event.seq} ${event.type} ${event.roundId}`).join('\n')}
          </Code>
        </Stack>
      </Accordion.Panel>
    </Accordion.Item>
  );
}
