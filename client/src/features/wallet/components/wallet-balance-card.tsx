import { ActionIcon, Group, Stack, Text, Title } from '@mantine/core';
import { formatCents } from '../../../lib/money/money';
import { BrandIcon, Surface } from '../../../components/ui';

interface WalletBalanceCardProps {
  balanceCents: number | null;
  onRefresh(): void;
}

export function WalletBalanceCard({ balanceCents, onRefresh }: WalletBalanceCardProps): React.JSX.Element {
  return (
    <Surface className="hs-wallet-balance" p={{ base: 'md', sm: 'lg' }} radius="lg">
      <Group className="hs-wallet-balance__inner" justify="space-between" align="center" wrap="wrap" gap="xl">
        <div>
          <Text className="hs-wallet-balance__label" size="sm">Available test balance <span aria-hidden="true">ⓘ</span></Text>
          <Title className="hs-wallet-balance__amount" order={2}>{balanceCents === null ? '—' : formatCents(balanceCents)}</Title>
          <span className="hs-wallet-balance__tag">Local simulation only</span>
        </div>
        <div className="hs-wallet-balance__notice">
          <span className="hs-wallet-balance__notice-icon" aria-hidden="true">i</span>
          <Stack gap={2}>
            <Text fw={700}>Local simulation only</Text>
            <Text size="sm" c="dimmed">This is a test balance for local play. No real money is sent or received.</Text>
          </Stack>
          <ActionIcon className="hs-wallet-balance__refresh" variant="subtle" aria-label="Refresh balance" onClick={onRefresh}>
            <BrandIcon name="clock" />
          </ActionIcon>
        </div>
      </Group>
    </Surface>
  );
}
