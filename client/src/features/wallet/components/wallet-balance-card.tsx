import { Badge, Button, Group, Paper, Stack, Text, Title } from '@mantine/core';
import { formatCents } from '../../../lib/money/money';

interface WalletBalanceCardProps {
  balanceCents: number | null;
  onRefresh(): void;
}

export function WalletBalanceCard({ balanceCents, onRefresh }: WalletBalanceCardProps): React.JSX.Element {
  return (
    <Paper withBorder p="md" radius="md">
      <Group justify="space-between" align="center" wrap="wrap">
        <div>
          <Text size="sm" c="dimmed">Available balance</Text>
          <Title order={2}>{balanceCents === null ? '—' : formatCents(balanceCents)}</Title>
        </div>
        <Stack gap={4} align="flex-end">
          <Badge variant="light">Local environment — test balance</Badge>
          <Button size="xs" variant="default" onClick={onRefresh}>Refresh balance</Button>
        </Stack>
      </Group>
    </Paper>
  );
}
