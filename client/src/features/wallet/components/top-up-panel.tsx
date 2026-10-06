import { Alert, Group, Stack, Text, TextInput } from '@mantine/core';
import { formatCents } from '../../../lib/money/money';
import type { TopUpReceipt } from '../../../lib/operator/operator-api';
import { ActionButton, AppModal, BrandIcon, StatusBadge } from '../../../components/ui';
import type { PendingAmountCommand } from '../model/pending-commands';

interface TopUpPanelProps {
  opened: boolean;
  amount: string;
  error: string | null;
  pending: PendingAmountCommand | null;
  receipt: TopUpReceipt | null;
  completedAmount: number | null;
  busy: boolean;
  onAmountChange(value: string): void;
  onSubmit(): void;
  onClose(): void;
}

const QUICK_AMOUNTS = [10, 50, 100, 200];

export function TopUpPanel({ opened, amount, error, pending, receipt, completedAmount, busy, onAmountChange, onSubmit, onClose }: TopUpPanelProps): React.JSX.Element {
  const unknown = pending !== null;
  const confirmed = receipt !== null;
  const title = confirmed ? 'Funds added' : unknown ? 'Top-up awaiting confirmation' : 'Add test funds';

  return (
    <AppModal className="hs-wallet-modal" opened={opened} onClose={onClose} title={title} size="md">
      <Stack gap="md" pb="xs">
        {confirmed ? (
          <div className="hs-wallet-result">
            <span className="hs-wallet-result__icon hs-wallet-result__icon--success"><BrandIcon name="check" size={26} /></span>
            <Text className="hs-wallet-result__amount" fw={800}>{formatCents(completedAmount ?? 0)}</Text>
            <Text ta="center" c="dimmed">Added to your test balance. Current balance: {formatCents(receipt.balanceCents)}.</Text>
            <StatusBadge tone="success">Confirmed</StatusBadge>
            <Text className="hs-wallet-result__note" size="xs" ta="center">Local simulation only. No real money is sent or received.</Text>
            <ActionButton w="100%" onClick={onClose}>Done</ActionButton>
          </div>
        ) : unknown ? (
          <div className="hs-wallet-result">
            <span className="hs-wallet-result__icon hs-wallet-result__icon--pending"><BrandIcon name="clock" size={25} /></span>
            <Text fw={700} ta="center">We could not confirm this top-up yet.</Text>
            <Text c="dimmed" size="sm" ta="center">{error ?? 'This request is still being resolved.'} Do not create another request. Retry with the same request key to check the original operation.</Text>
            <StatusBadge tone="warning">{formatCents(pending.amountCents)} · status unknown</StatusBadge>
            <Group grow w="100%">
              <ActionButton tone="secondary" onClick={onClose}>Close</ActionButton>
              <ActionButton loading={busy} onClick={onSubmit}>Check again</ActionButton>
            </Group>
          </div>
        ) : (
          <>
            <div className="hs-wallet-modal__intro">
              <span className="hs-wallet-modal__icon">+</span>
              <div><Text fw={700}>Top up your test balance</Text><Text size="sm" c="dimmed">Add test funds for local play.</Text></div>
            </div>
            <Alert className="hs-wallet-modal__simulation" color="teal" icon={<BrandIcon name="info" />}>
              <Text fw={700} size="sm">Local simulation only</Text>
              <Text size="sm">This is a test balance for local play. No real money is sent or received.</Text>
            </Alert>
            {error !== null && <Alert color="red" title="Could not add funds">{error}</Alert>}
            <TextInput
              className="hs-wallet-modal__amount"
              label="Amount"
              placeholder="50.00"
              inputMode="decimal"
              leftSection="$"
              rightSection={<span className="hs-currency-label">USD</span>}
              value={amount}
              disabled={busy}
              onChange={(event) => onAmountChange(event.currentTarget.value)}
            />
            <Group className="hs-wallet-modal__presets" grow gap="xs">
              {QUICK_AMOUNTS.map((value) => <button type="button" key={value} disabled={busy} onClick={() => onAmountChange(String(value))}>${value}</button>)}
            </Group>
            <Group grow mt="xs">
              <ActionButton tone="secondary" size="lg" onClick={onClose}>Cancel</ActionButton>
              <ActionButton size="lg" loading={busy} onClick={onSubmit}>Add funds</ActionButton>
            </Group>
          </>
        )}
      </Stack>
    </AppModal>
  );
}
