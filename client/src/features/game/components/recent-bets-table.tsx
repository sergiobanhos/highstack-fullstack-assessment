import { Alert, Badge, Stack, Table, Text, Title, Group } from '@mantine/core';
import type { BetCommandResult, BetCommandStatus, SettlementStatus } from '../../../lib/operator/operator-api';
import { formatCents, formatMultiplier } from '../../../lib/money/money';
import { getBetGameStatusLabel, isBetOutcomePending } from '../model/bet-status';
import { ActionButton, Surface } from '../../../components/ui';

const COMMAND_STATUS_LABELS: Record<BetCommandStatus, string> = {
  pending: 'Pending',
  accepted: 'Accepted',
  rejected: 'Rejected',
  unknown: 'Confirming',
};
const COMMAND_STATUS_COLORS: Record<BetCommandStatus, string> = {
  pending: 'gray',
  accepted: 'teal',
  rejected: 'red',
  unknown: 'yellow',
};
const SETTLEMENT_LABELS: Record<SettlementStatus, string> = {
  not_applicable: '—',
  pending: 'Credit pending',
  confirmed: 'Credited',
  precision_incident: 'Precision incident logged',
};

interface RecentBetsTableProps {
  bets: BetCommandResult[] | null;
  error: string | null;
  roundId: string | null;
  phase: string | null;
  liveMultiplierHundredths: number | null;
  checkingBetIds: ReadonlySet<string>;
  failedBetVerifications: ReadonlySet<string>;
  onRefresh(): void;
  onRefreshBet(betId: string): void;
}

export function RecentBetsTable({
  bets,
  error,
  roundId,
  phase,
  liveMultiplierHundredths,
  checkingBetIds,
  failedBetVerifications,
  onRefresh,
  onRefreshBet,
}: RecentBetsTableProps): React.JSX.Element {
  return (
    <Surface className="hs-recent-bets" p={{ base: 'sm', sm: 'md' }} radius="lg">
      <Group justify="space-between">
        <Title order={4} className="hs-recent-bets__title">Your recent bets</Title>
        <ActionButton tone="quiet" size="xs" onClick={onRefresh}>Refresh</ActionButton>
      </Group>
      {error !== null && <Alert color="red" mt="sm">{error}</Alert>}
      <div className="hs-recent-bets__scroll">
      <Table className="hs-recent-bets__table" mt="sm" striped highlightOnHover>
        <Table.Thead><Table.Tr><Table.Th>Round</Table.Th><Table.Th>Amount</Table.Th><Table.Th>Command</Table.Th><Table.Th>Game</Table.Th><Table.Th>Result</Table.Th><Table.Th>Settlement</Table.Th><Table.Th /></Table.Tr></Table.Thead>
        <Table.Tbody>
          {bets === null || bets.length === 0 ? (
            <Table.Tr><Table.Td colSpan={7}><Text size="sm" c="dimmed">{bets === null ? 'Loading…' : 'No bets recorded yet.'}</Text></Table.Td></Table.Tr>
          ) : bets.map((item) => {
            const settlementBetId = item.bet?.betId ?? null;
            const verificationBetId = item.bet?.betId ?? item.betId;
            const outcomePending = isBetOutcomePending(item, { roundId, phase });
            const autoCashoutCrossed = item.bet?.engineStatus === 'active' && item.autoCashoutHundredths !== null && liveMultiplierHundredths !== null && liveMultiplierHundredths >= item.autoCashoutHundredths;
            const multiplier = item.bet?.payoutCents !== null && item.bet?.payoutCents !== undefined
              ? formatCents(item.bet.payoutCents)
              : item.bet?.multiplierHundredths !== null && item.bet?.multiplierHundredths !== undefined
                ? formatMultiplier(item.bet.multiplierHundredths)
                : '—';
            return (
              <Table.Tr key={item.commandId}>
                <Table.Td><Text size="sm" ff="monospace">{item.roundId.slice(0, 8)}…</Text></Table.Td>
                <Table.Td>{formatCents(item.amountCents)}</Table.Td>
                <Table.Td><Badge color={COMMAND_STATUS_COLORS[item.betCommandStatus]} variant="light">{COMMAND_STATUS_LABELS[item.betCommandStatus]}</Badge>{item.resultCode !== null && <Text size="xs" c="dimmed">{item.resultCode}</Text>}</Table.Td>
                <Table.Td>{getBetGameStatusLabel(item, { roundId, phase })}{autoCashoutCrossed && <Text size="xs" c="dimmed">cashing out…</Text>}</Table.Td>
                <Table.Td>{multiplier}</Table.Td>
                <Table.Td>{item.bet === null ? '—' : SETTLEMENT_LABELS[item.bet.settlementStatus]}</Table.Td>
                <Table.Td>
                  {item.bet?.settlementStatus === 'pending' && settlementBetId !== null && <ActionButton tone="secondary" size="compact-xs" onClick={() => onRefreshBet(settlementBetId)}>Check credit</ActionButton>}
                  {outcomePending && verificationBetId !== null && <Stack gap={2} align="flex-start"><ActionButton tone="secondary" size="compact-xs" disabled={checkingBetIds.has(verificationBetId)} onClick={() => onRefreshBet(verificationBetId)}>{checkingBetIds.has(verificationBetId) ? 'Checking…' : 'Check result'}</ActionButton>{failedBetVerifications.has(verificationBetId) && <Text size="xs" c="dimmed">Could not verify right now. Try again.</Text>}</Stack>}
                </Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>
      </div>
    </Surface>
  );
}
