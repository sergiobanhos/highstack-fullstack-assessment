import { ActionIcon, Group, Stack, Text } from '@mantine/core';
import { Surface } from '../../../components/ui';

interface WalletActionCardsProps {
  onAddFunds(): void;
  onRequestPayout(): void;
}

export function WalletActionCards({ onAddFunds, onRequestPayout }: WalletActionCardsProps): React.JSX.Element {
  return (
    <div className="hs-wallet-actions">
      <Surface className="hs-wallet-action hs-wallet-action--primary" component="button" type="button" onClick={onAddFunds}>
        <Group wrap="nowrap" gap="md">
          <ActionIcon className="hs-wallet-action__icon hs-wallet-action__icon--primary" size={64} radius="xl" aria-hidden="true">+</ActionIcon>
          <Stack gap={2} align="flex-start">
            <Text fw={700}>Add test funds</Text>
            <Text size="sm" c="dimmed">Top up your test balance for local play.</Text>
          </Stack>
          <span className="hs-wallet-action__arrow" aria-hidden="true">›</span>
        </Group>
      </Surface>
      <Surface className="hs-wallet-action" component="button" type="button" onClick={onRequestPayout}>
        <Group wrap="nowrap" gap="md">
          <ActionIcon className="hs-wallet-action__icon" size={64} radius="lg" aria-hidden="true">↗</ActionIcon>
          <Stack gap={2} align="flex-start">
            <Text fw={700}>Request payout</Text>
            <Text size="sm" c="dimmed">Simulate a payout request from your test balance.</Text>
          </Stack>
          <span className="hs-wallet-action__arrow" aria-hidden="true">›</span>
        </Group>
      </Surface>
    </div>
  );
}
