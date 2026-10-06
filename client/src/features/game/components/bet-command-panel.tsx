import { Group, Stack, Text, TextInput } from '@mantine/core';
import type { BetCommandResult } from '../../../lib/operator/operator-api';
import { ActionButton, Surface } from '../../../components/ui';

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
}

const QUICK_AMOUNTS = ['$5', '$10', '$25', '$50'];

export function BetCommandPanel(props: BetCommandPanelProps): React.JSX.Element {
  const {
    amountText, autoCashoutText, amountError, autoCashoutError, busy, canBet,
    canCashout, cashoutLabel, phase, conflictingBet, pending,
    onAmountChange, onAutoCashoutChange, onBet, onCashout,
  } = props;
  const locked = busy || pending !== null;

  return (
    <Surface className="hs-bet-panel" p={{ base: 'md', sm: 'lg' }} radius="lg">
      <Group justify="space-between" align="flex-start" mb="lg">
        <div>
          <Text className="hs-bet-panel__eyebrow" size="xs" fw={700}>YOUR BET</Text>
          <Text className="hs-bet-panel__heading" fw={700}>Place a bet</Text>
        </div>
        <span className="hs-bet-panel__round-state">{phase === 'betting' ? 'BETTING OPEN' : 'NEXT ROUND'}</span>
      </Group>

      <Stack gap="md">
        <div>
          <TextInput
            className="hs-bet-panel__amount"
            label="Bet amount"
            placeholder="0.00"
            inputMode="decimal"
            leftSection={<span className="hs-currency">$</span>}
            rightSection={<span className="hs-currency-label">USD</span>}
            value={amountText}
            error={amountError}
            disabled={locked}
            onChange={(event) => onAmountChange(event.currentTarget.value)}
          />
          <Group className="hs-bet-panel__presets" gap="xs" grow mt="sm" aria-label="Quick bet amounts">
            {QUICK_AMOUNTS.map((amount) => (
              <button key={amount} type="button" disabled={locked} onClick={() => onAmountChange(amount.slice(1))}>{amount}</button>
            ))}
          </Group>
        </div>

        <TextInput
          className="hs-bet-panel__auto-cashout"
          label="Auto cashout"
          placeholder="Optional multiplier"
          inputMode="decimal"
          rightSection={<span className="hs-currency-label">×</span>}
          value={autoCashoutText}
          error={autoCashoutError}
          disabled={locked}
          onChange={(event) => onAutoCashoutChange(event.currentTarget.value)}
        />

        {pending !== null && (
          <div className="hs-bet-panel__pending" role="status">
            <Text size="sm" fw={600}>{pending.type === 'cashout' ? 'Cashout awaiting confirmation' : 'Bet awaiting confirmation'}</Text>
            <Text size="xs">{pending.note} Do not submit this operation again while its status is unknown.</Text>
          </div>
        )}
        {conflictingBet !== null && (
          <Text className="hs-bet-panel__hint" size="xs">A bet is already recorded for this round. Check its status below.</Text>
        )}

        <Stack gap="sm" mt="xs">
          <ActionButton className="hs-bet-panel__submit" size="lg" loading={busy} disabled={!canBet} onClick={onBet}>
            Place bet
          </ActionButton>
          <ActionButton className="hs-bet-panel__cashout" tone="secondary" size="lg" loading={busy} disabled={!canCashout} onClick={onCashout}>
            {cashoutLabel}
          </ActionButton>
        </Stack>
        <Text className="hs-bet-panel__hint" size="xs">
          {pending !== null ? 'We are checking the original request with the operator.' : phase === 'betting' ? 'Your bet is sent securely through the operator.' : 'Bets are available when the next round opens.'}
        </Text>
      </Stack>
    </Surface>
  );
}
