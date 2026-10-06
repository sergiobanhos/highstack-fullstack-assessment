import { Alert, Group, Loader, Stack, Text, TextInput } from '@mantine/core';
import { formatCents } from '../../../lib/money/money';
import type { Payout } from '../../../lib/operator/operator-api';
import { ActionButton, AppModal, BrandIcon, StatusBadge } from '../../../components/ui';
import type { PendingAmountCommand } from '../model/pending-commands';

export type PayoutAvailability =
  | { status: 'checking' }
  | { status: 'ready' }
  | { status: 'disabled' }
  | { status: 'error'; message: string };

interface PayoutPanelProps {
  opened: boolean;
  availability: PayoutAvailability;
  amount: string;
  error: string | null;
  pending: PendingAmountCommand | null;
  receipt: Payout | null;
  balanceCents: number | null;
  busy: boolean;
  onAmountChange(value: string): void;
  onSubmit(): void;
  onClose(): void;
  onRetry(): void;
}

export function PayoutPanel({
  opened, availability, amount, error, pending, receipt, balanceCents, busy,
  onAmountChange, onSubmit, onClose, onRetry,
}: PayoutPanelProps): React.JSX.Element {
  const unknown = pending !== null;
  const resultReady = receipt !== null;
  const complete = receipt?.status === 'done';
  const title = resultReady ? complete ? 'Payout complete' : 'Payout processing' : unknown ? 'Payout awaiting confirmation' : 'Request payout';

  return (
    <AppModal className="hs-wallet-modal" opened={opened} onClose={onClose} title={title} size="md">
      <Stack gap="md" pb="xs">
        {resultReady ? (
          <div className="hs-wallet-result">
            <span className={`hs-wallet-result__icon ${complete ? 'hs-wallet-result__icon--success' : 'hs-wallet-result__icon--pending'}`}>
              {complete ? <BrandIcon name="check" size={26} /> : <Loader size="sm" color="yellow" />}
            </span>
            <Text className="hs-wallet-result__amount" fw={800}>{formatCents(receipt.amountCents)}</Text>
            <Text fw={700}>{complete ? 'Payout completed' : 'Your payout is being processed'}</Text>
            <Text c="dimmed" size="sm" ta="center">
              {complete ? 'The local simulation has finished.' : 'The operator recorded the request. We will refresh its status shortly.'}
            </Text>
            <StatusBadge tone={complete ? 'success' : 'warning'}>{complete ? 'Complete' : 'Processing'}</StatusBadge>
            <Text className="hs-wallet-result__note" size="xs" ta="center">Local simulation only. No real money is sent or received.</Text>
            <ActionButton w="100%" onClick={onClose}>Done</ActionButton>
          </div>
        ) : unknown ? (
          <div className="hs-wallet-result">
            <span className="hs-wallet-result__icon hs-wallet-result__icon--pending"><BrandIcon name="clock" size={25} /></span>
            <Text fw={700} ta="center">We could not confirm this payout yet.</Text>
            <Text c="dimmed" size="sm" ta="center">{error ?? 'This request is still being resolved.'} Do not start another request. Retry with the same request key to check this payout.</Text>
            <StatusBadge tone="warning">{formatCents(pending.amountCents)} · status unknown</StatusBadge>
            <Group grow w="100%">
              <ActionButton tone="secondary" onClick={onClose}>Close</ActionButton>
              <ActionButton loading={busy} onClick={onSubmit}>Check again</ActionButton>
            </Group>
          </div>
        ) : availability.status === 'checking' ? (
          <Group justify="center" py="xl"><Loader size="sm" /><Text size="sm" c="dimmed">Checking payout availability…</Text></Group>
        ) : availability.status === 'disabled' ? (
          <Alert color="gray" title="Local payout unavailable">This operator has payout simulation disabled.</Alert>
        ) : availability.status === 'error' ? (
          <Alert color="red" title="Could not load payouts">
            <Group justify="space-between"><Text size="sm">{availability.message}</Text><ActionButton size="xs" onClick={onRetry}>Try again</ActionButton></Group>
          </Alert>
        ) : (
          <>
            <div className="hs-wallet-modal__intro">
              <span className="hs-wallet-modal__icon hs-wallet-modal__icon--neutral">↗</span>
              <div><Text fw={700}>Simulate a payout request</Text><Text size="sm" c="dimmed">Request a payout from your test balance.</Text></div>
            </div>
            <Alert className="hs-wallet-modal__simulation" color="teal" icon={<BrandIcon name="info" />}>
              <Text fw={700} size="sm">Local simulation only</Text>
              <Text size="sm">This does not transfer real money. Available balance: {balanceCents === null ? '—' : formatCents(balanceCents)}.</Text>
            </Alert>
            {error !== null && <Alert color="red" title="Could not request payout">{error}</Alert>}
            <TextInput
              className="hs-wallet-modal__amount"
              label="Amount"
              placeholder="25.00"
              inputMode="decimal"
              leftSection="$"
              rightSection={<span className="hs-currency-label">USD</span>}
              value={amount}
              disabled={busy}
              onChange={(event) => onAmountChange(event.currentTarget.value)}
            />
            <Group grow mt="xs">
              <ActionButton tone="secondary" size="lg" onClick={onClose}>Cancel</ActionButton>
              <ActionButton size="lg" loading={busy} onClick={onSubmit}>Request payout</ActionButton>
            </Group>
          </>
        )}
      </Stack>
    </AppModal>
  );
}
