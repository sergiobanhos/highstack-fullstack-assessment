import { Alert, Badge, Button, Stack, Table, Text, Title, Group, Paper } from '@mantine/core';
import type { BetCommandResult, BetCommandStatus, SettlementStatus } from '../operator-api';
import { formatCents, formatMultiplier } from '../money';
import { getBetGameStatusLabel, isBetOutcomePending } from '../bet-status';

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
    <Paper withBorder p="md" radius="md">
      <Group justify="space-between">
        <Title order={4}>Your recent bets</Title>
        <Button size="xs" variant="default" onClick={onRefresh}>Refresh</Button>
      </Group>
      {error !== null && <Alert color="red" mt="sm">{error}</Alert>}
      <Table mt="sm" striped withTableBorder highlightOnHover>
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
                  {item.bet?.settlementStatus === 'pending' && settlementBetId !== null && <Button size="compact-xs" variant="light" onClick={() => onRefreshBet(settlementBetId)}>Check credit</Button>}
                  {outcomePending && verificationBetId !== null && <Stack gap={2} align="flex-start"><Button size="compact-xs" variant="light" disabled={checkingBetIds.has(verificationBetId)} onClick={() => onRefreshBet(verificationBetId)}>{checkingBetIds.has(verificationBetId) ? 'Checking…' : 'Check result'}</Button>{failedBetVerifications.has(verificationBetId) && <Text size="xs" c="dimmed">Could not verify right now. Try again.</Text>}</Stack>}
                </Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>
    </Paper>
  );
}
