import { Alert, Button, Group, Paper, Stack, Text, TextInput, Title } from '@mantine/core';
import { formatCents, formatCentsInput } from '../../../lib/money/money';
import type { PendingAmountCommand } from '../model/pending-commands';

interface TopUpPanelProps {
  amount: string;
  error: string | null;
  pending: PendingAmountCommand | null;
  busy: boolean;
  onAmountChange(value: string): void;
  onSubmit(): void;
  onDismissError(): void;
}

export function TopUpPanel({ amount, error, pending, busy, onAmountChange, onSubmit, onDismissError }: TopUpPanelProps): React.JSX.Element {
  return (
    <Paper withBorder p="md" radius="md">
      <Title order={4}>Add balance (test top-up)</Title>
      <Text size="sm" c="dimmed" mt={4}>
        Local test operation with an idempotency key: retrying does not credit twice.
      </Text>
      {pending !== null && (
        <Alert color="yellow" mt="sm" title="Top-up awaiting confirmation">
          {formatCents(pending.amountCents)} — the previous response never arrived. Try again to confirm; the same key will be reused.
        </Alert>
      )}
      {error !== null && <Alert color="red" mt="sm" withCloseButton onClose={onDismissError}>{error}</Alert>}
      <Stack gap="sm" mt="sm">
        <Group align="flex-end" wrap="wrap">
          <TextInput label="Amount (USD)" placeholder="50.00" inputMode="decimal" w={160}
            value={pending !== null ? formatCentsInput(pending.amountCents) : amount}
            disabled={pending !== null} onChange={(event) => onAmountChange(event.currentTarget.value)} />
          <Button onClick={onSubmit} loading={busy}>{pending !== null ? 'Try again' : 'Add balance'}</Button>
        </Group>
      </Stack>
    </Paper>
  );
}
