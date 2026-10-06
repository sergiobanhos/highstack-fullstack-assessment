import { Group, Stack, Text } from '@mantine/core';
import type { BetCommandResult } from '../../../lib/operator/operator-api';
import { formatCents, formatMultiplier } from '../../../lib/money/money';
import { ActionButton, AppModal, StatusBadge } from '../../../components/ui';
import type { GameCommandFeedback } from '../hooks/use-game-command-flow';
import type { PendingGameCommandView } from './bet-command-panel';

interface GameOutcomeDialogProps {
  feedback: GameCommandFeedback | null;
  autoCashout: { status: 'checking' | 'confirmed'; command: BetCommandResult | null } | null;
  pending: PendingGameCommandView | null;
  pendingOpen: boolean;
  onDismissFeedback(): void;
  onDismissAutoCashout(): void;
  onCheckAutoCashout(): void;
  onDismissPending(): void;
  onReconcile(): void;
}

function CashoutResult({ command }: { command: BetCommandResult | null }): React.JSX.Element {
  const payoutCents = command?.bet?.payoutCents ?? null;
  const multiplierHundredths = command?.bet?.multiplierHundredths ?? null;
  const settlement = command?.bet?.settlementStatus;
  return (
    <>
      <div className="hs-outcome-dialog__icon hs-outcome-dialog__icon--success" aria-hidden="true">✓</div>
      <Text className="hs-outcome-dialog__amount" ta="center" fw={800}>{payoutCents === null ? 'Cashout confirmed' : formatCents(payoutCents)}</Text>
      <Text ta="center" c="dimmed" size="sm">
        {multiplierHundredths === null ? 'The operator confirmed your cashout.' : `Cashed out at ${formatMultiplier(multiplierHundredths)}.`}
      </Text>
      {settlement === 'pending' && <StatusBadge tone="warning">Wallet credit pending</StatusBadge>}
      {settlement === 'confirmed' && <StatusBadge tone="success">Wallet credit confirmed</StatusBadge>}
      {settlement === 'precision_incident' && <StatusBadge tone="danger">Settlement needs review</StatusBadge>}
      <Text className="hs-outcome-dialog__footnote" size="xs" ta="center">The game result and wallet settlement are tracked separately.</Text>
    </>
  );
}

export function GameOutcomeDialog({ feedback, autoCashout, pending, pendingOpen, onDismissFeedback, onDismissAutoCashout, onCheckAutoCashout, onDismissPending, onReconcile }: GameOutcomeDialogProps): React.JSX.Element {
  const showPending = pending !== null && pendingOpen;
  const cashoutFeedback = feedback?.kind === 'cashout' || feedback?.kind === 'cashout-error';
  const showAutoCashout = autoCashout !== null && !showPending && !cashoutFeedback;
  const opened = showPending || (cashoutFeedback && feedback !== null) || showAutoCashout;
  const close = showPending ? onDismissPending : showAutoCashout ? onDismissAutoCashout : onDismissFeedback;
  const title = showPending
    ? pending?.type === 'cashout' ? 'Cashout status' : 'Bet status'
    : feedback?.kind === 'cashout-error' ? 'Cashout not completed' : showAutoCashout ? autoCashout?.status === 'checking' ? 'Auto cashout' : 'Auto cashout complete' : 'Cashout complete';

  return (
    <AppModal opened={opened} onClose={close} title={title} size="sm">
      <Stack className="hs-outcome-dialog" align="center" gap="md" pb="xs">
        {showPending && pending !== null ? (
          <>
            <div className="hs-outcome-dialog__icon hs-outcome-dialog__icon--pending" aria-hidden="true">…</div>
            <Text className="hs-outcome-dialog__amount" ta="center" fw={800}>Request being checked</Text>
            <Text ta="center" c="dimmed" size="sm">{pending.note}</Text>
            <Text className="hs-outcome-dialog__footnote" size="xs" ta="center">Keep this window open or close it and wait. Do not send a second request.</Text>
            <Group grow w="100%">
              <ActionButton tone="secondary" onClick={onDismissPending}>Close</ActionButton>
              <ActionButton onClick={onReconcile}>Check status</ActionButton>
            </Group>
          </>
        ) : feedback?.kind === 'cashout' ? (
          <>
            <CashoutResult command={feedback.command} />
            <ActionButton w="100%" onClick={onDismissFeedback}>Done</ActionButton>
          </>
        ) : feedback?.kind === 'cashout-error' ? (
          <>
            <div className="hs-outcome-dialog__icon hs-outcome-dialog__icon--error" aria-hidden="true">!</div>
            <Text ta="center" fw={700}>{feedback.text}</Text>
            <Text className="hs-outcome-dialog__footnote" size="xs" ta="center">The operator did not confirm this cashout. The bet result remains visible in your recent bets.</Text>
            <ActionButton w="100%" onClick={onDismissFeedback}>Close</ActionButton>
          </>
        ) : showAutoCashout && autoCashout !== null ? (
          <>
            {autoCashout.status === 'checking' ? (
              <>
                <div className="hs-outcome-dialog__icon hs-outcome-dialog__icon--pending" aria-hidden="true">…</div>
                <Text className="hs-outcome-dialog__amount" ta="center" fw={800}>Auto cashout triggered</Text>
                <Text ta="center" c="dimmed" size="sm">The configured multiplier was reached. We are checking the result with the operator.</Text>
                <StatusBadge tone="warning">Wallet credit pending</StatusBadge>
                <Text className="hs-outcome-dialog__footnote" size="xs" ta="center">The chart stays live while the operator confirms the cashout and wallet settlement.</Text>
                <Group grow w="100%">
                  <ActionButton tone="secondary" onClick={onDismissAutoCashout}>Close</ActionButton>
                  <ActionButton onClick={onCheckAutoCashout}>Check status</ActionButton>
                </Group>
              </>
            ) : (
              <>
                <CashoutResult command={autoCashout.command} />
                <ActionButton w="100%" onClick={onDismissAutoCashout}>Done</ActionButton>
              </>
            )}
          </>
        ) : null}
      </Stack>
    </AppModal>
  );
}
