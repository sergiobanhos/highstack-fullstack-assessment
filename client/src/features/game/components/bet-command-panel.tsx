import { Alert, Button, Group, Paper, Stack, Text, TextInput, Title } from '@mantine/core';
import type { BetCommandResult, BetCommandStatus } from '../../../lib/operator/operator-api';

const COMMAND_STATUS_LABELS: Record<BetCommandStatus, string> = {
  pending: 'Pending',
  accepted: 'Accepted',
  rejected: 'Rejected',
  unknown: 'Confirming',
};

export interface PendingGameCommandView {
  type: 'bet' | 'cashout';
  amountCents: number;
  note: string;
}

interface BetCommandPanelProps {
  amountText: string;
  autoCashoutText: string;
  amountError: string | null;
  autoCashoutError: string | null;
  busy: boolean;
  canBet: boolean;
  canCashout: boolean;
  cashoutLabel: string;
  phase: string | null;
  conflictingBet: BetCommandResult | null;
  pending: PendingGameCommandView | null;
  onAmountChange(value: string): void;
  onAutoCashoutChange(value: string): void;
  onBet(): void;
  onCashout(): void;
  onReconcile(): void;
}

export function BetCommandPanel(props: BetCommandPanelProps): React.JSX.Element {
  const {
    amountText, autoCashoutText, amountError, autoCashoutError, busy, canBet,
    canCashout, cashoutLabel, phase, conflictingBet, pending,
    onAmountChange, onAutoCashoutChange, onBet, onCashout, onReconcile,
  } = props;
  return (
    <Stack gap="md">
      {pending !== null && (
        <Alert color="yellow" title={pending.type === 'bet' ? 'Bet awaiting confirmation' : 'Cashout awaiting confirmation'}>
          <Stack gap="xs">
            <Text size="sm">{pending.note} The operation keeps the same idempotency key{pending.amountCents > 0 ? ` (USD ${(pending.amountCents / 100).toFixed(2)})` : ''}.</Text>
            <Group><Button size="xs" variant="light" onClick={onReconcile}>Check again</Button></Group>
          </Stack>
        </Alert>
      )}
      <Paper withBorder p="md" radius="md">
        <Title order={4}>Bet</Title>
        <Stack gap="sm" mt="sm">
          <Group align="flex-end" wrap="wrap">
            <TextInput label="Amount (USD)" placeholder="10.00" inputMode="decimal" w={160}
              value={amountText} error={amountError} disabled={pending !== null || busy}
              onChange={(event) => onAmountChange(event.currentTarget.value)} />
            <TextInput label="Auto-cashout (optional)" placeholder="1.50" inputMode="decimal" w={200}
              value={autoCashoutText} error={autoCashoutError} disabled={pending !== null || busy}
              onChange={(event) => onAutoCashoutChange(event.currentTarget.value)} />
            <Button onClick={onBet} loading={busy} disabled={!canBet}>Place bet</Button>
            <Button variant="light" color="orange" miw={190} onClick={onCashout} loading={busy} disabled={!canCashout}>
              {cashoutLabel}
            </Button>
          </Group>
          <Text size="sm" c="dimmed">
            {conflictingBet !== null
              ? `You already have a bet in this round (${COMMAND_STATUS_LABELS[conflictingBet.betCommandStatus]}).`
              : phase === 'betting' ? 'Place your bet while betting is open.' : 'Wait for the next betting window.'}
          </Text>
        </Stack>
      </Paper>
    </Stack>
  );
}
