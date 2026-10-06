import { Alert, Button, Group, Loader, Paper, Stack, Text, TextInput, Title } from '@mantine/core';
import { formatCents, formatCentsInput } from '../../../lib/money/money';
import { PayoutHistory, type PayoutView } from './wallet-history';
import type { PendingAmountCommand } from '../model/pending-commands';

export type PayoutAvailability =
  | { status: 'checking' }
  | { status: 'ready' }
  | { status: 'disabled' }
  | { status: 'error'; message: string };

interface PayoutPanelProps {
  availability: PayoutAvailability;
  payouts: PayoutView[] | null;
  hasMore: boolean;
  amount: string;
  error: string | null;
  pending: PendingAmountCommand | null;
  busy: boolean;
  onAmountChange(value: string): void;
  onSubmit(): void;
  onDismissError(): void;
  onRetry(): void;
  onRefreshItem(): void;
  onLoadMore(): void;
}

export function PayoutPanel({
  availability, payouts, hasMore, amount, error, pending, busy,
  onAmountChange, onSubmit, onDismissError, onRetry, onRefreshItem, onLoadMore,
}: PayoutPanelProps): React.JSX.Element {
  return (
    <Paper withBorder p="md" radius="md">
      <Title order={4}>Simulated payout</Title>
      <Text size="sm" c="dimmed" mt={4}>
        Local test payout. The request is recorded by the operator and does not use real money.
      </Text>
      {availability.status === 'checking' && (
        <Group gap="xs" mt="sm"><Loader size="xs" /><Text size="sm" c="dimmed">Checking local payout availability…</Text></Group>
      )}
      {availability.status === 'disabled' && <Alert color="gray" mt="sm" title="Local payout unavailable">This operator has payout simulation disabled.</Alert>}
      {availability.status === 'error' && (
        <Alert color="red" mt="sm" title="Could not load payouts">
          <Group justify="space-between"><Text size="sm">{availability.message}</Text><Button size="xs" variant="light" onClick={onRetry}>Try again</Button></Group>
        </Alert>
      )}
      {availability.status === 'ready' && (
        <Stack gap="sm" mt="sm">
          {pending !== null && (
            <Alert color="yellow" title="Payout awaiting confirmation">
              {formatCents(pending.amountCents)} — the previous response never arrived. Try again to confirm; the same key will be reused.
            </Alert>
          )}
          {error !== null && <Alert color="red" withCloseButton onClose={onDismissError}>{error}</Alert>}
          <Group align="flex-end" wrap="wrap">
            <TextInput label="Amount (USD)" placeholder="25.00" inputMode="decimal" w={160}
              value={pending !== null ? formatCentsInput(pending.amountCents) : amount}
              disabled={pending !== null} onChange={(event) => onAmountChange(event.currentTarget.value)} />
            <Button onClick={onSubmit} loading={busy}>{pending !== null ? 'Try again' : 'Request payout'}</Button>
          </Group>
          <PayoutHistory payouts={payouts} hasMore={hasMore} onRefreshItem={onRefreshItem} onLoadMore={onLoadMore} />
        </Stack>
      )}
    </Paper>
  );
}
