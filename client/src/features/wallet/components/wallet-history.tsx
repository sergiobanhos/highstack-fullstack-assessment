import {
  Badge,
  Button,
  Group,
  Loader,
  Paper,
  Table,
  Text,
  Title,
} from '@mantine/core';
import type { LedgerEntry, Payout } from '../../../lib/operator/operator-api';
import { formatCents, formatSignedCents } from '../../../lib/money/money';

const DIRECTION_LABELS: Record<LedgerEntry['direction'], string> = {
  credit: 'Credit',
  debit: 'Debit',
};

const SOURCE_LABELS: Record<string, string> = {
  engine: 'Engine (bet/cashout)',
  test: 'Test top-up',
  payout: 'Simulated payout',
  reconciliation: 'Reconciliation',
};

const PAYOUT_STATUS_LABELS: Record<Payout['status'], string> = {
  processing: 'Processing',
  done: 'Done',
};

function formatTimestamp(value: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return value;
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'short', timeStyle: 'short' }).format(milliseconds);
}

export interface PayoutView extends Payout {
  missing?: boolean;
}

interface WalletHistoryProps {
  ledger: LedgerEntry[] | null;
  error: string | null;
  loading: boolean;
  hasMore: boolean;
  onRefresh(): void;
  onLoadMore(): void;
}

export function WalletHistory({ ledger, error, loading, hasMore, onRefresh, onLoadMore }: WalletHistoryProps): React.JSX.Element {
  return (
    <Paper withBorder p="md" radius="md">
      <Group justify="space-between">
        <Title order={4}>Wallet history</Title>
        <Button size="xs" variant="default" onClick={onRefresh}>Refresh</Button>
      </Group>
      {error !== null && <Text size="sm" c="red" mt="sm">{error}</Text>}
      <Table mt="sm" striped withTableBorder>
        <Table.Thead><Table.Tr><Table.Th>When</Table.Th><Table.Th>Operation</Table.Th><Table.Th>Amount</Table.Th><Table.Th>Balance after</Table.Th></Table.Tr></Table.Thead>
        <Table.Tbody>
          {ledger === null ? (
            <Table.Tr><Table.Td colSpan={4}><Group gap="xs"><Loader size="xs" /><Text size="sm" c="dimmed">Loading…</Text></Group></Table.Td></Table.Tr>
          ) : ledger.length === 0 ? (
            <Table.Tr><Table.Td colSpan={4}><Text size="sm" c="dimmed">No transactions yet.</Text></Table.Td></Table.Tr>
          ) : ledger.map((entry) => (
            <Table.Tr key={entry.id}>
              <Table.Td>{formatTimestamp(entry.createdAt)}</Table.Td>
              <Table.Td><Badge size="sm" variant="light" color={entry.direction === 'credit' ? 'teal' : 'orange'}>{DIRECTION_LABELS[entry.direction]}</Badge>{' '}{SOURCE_LABELS[entry.source] ?? entry.source}</Table.Td>
              <Table.Td>{formatSignedCents(entry.amountCents, entry.direction)}</Table.Td>
              <Table.Td>{formatCents(entry.balanceAfterCents)}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      {hasMore && <Button mt="sm" size="xs" variant="light" loading={loading} onClick={onLoadMore}>Load more</Button>}
    </Paper>
  );
}

interface PayoutHistoryProps {
  payouts: PayoutView[] | null;
  hasMore: boolean;
  onRefreshItem(id: string): void;
  onLoadMore(): void;
}

export function PayoutHistory({ payouts, hasMore, onRefreshItem, onLoadMore }: PayoutHistoryProps): React.JSX.Element {
  return (
    <>
      <Table mt="md" striped withTableBorder>
        <Table.Thead><Table.Tr><Table.Th>Requested</Table.Th><Table.Th>Reference</Table.Th><Table.Th>Amount</Table.Th><Table.Th>Status</Table.Th><Table.Th>Completed</Table.Th><Table.Th /></Table.Tr></Table.Thead>
        <Table.Tbody>
          {payouts === null || payouts.length === 0 ? (
            <Table.Tr><Table.Td colSpan={6}><Text size="sm" c="dimmed">{payouts === null ? 'Loading…' : 'No payouts requested yet.'}</Text></Table.Td></Table.Tr>
          ) : payouts.map((payout) => (
            <Table.Tr key={payout.id}>
              <Table.Td>{formatTimestamp(payout.requestedAt)}</Table.Td>
              <Table.Td><Text size="xs" ff="monospace">{payout.id.slice(0, 8)}…</Text></Table.Td>
              <Table.Td>{formatCents(payout.amountCents)}</Table.Td>
              <Table.Td>
                {payout.missing === true ? <Badge variant="light" color="red">Not found</Badge> : <>
                  <Badge variant="light" color={payout.status === 'done' ? 'teal' : 'blue'}>{PAYOUT_STATUS_LABELS[payout.status]}</Badge>
                  {payout.simulated && <Text size="xs" c="dimmed">local simulation</Text>}
                </>}
              </Table.Td>
              <Table.Td>{payout.completedAt === null ? '—' : formatTimestamp(payout.completedAt)}</Table.Td>
              <Table.Td>{payout.status === 'processing' && payout.missing !== true && <Button size="compact-xs" variant="light" onClick={() => onRefreshItem(payout.id)}>Refresh</Button>}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      {hasMore && <Button mt="sm" size="xs" variant="light" onClick={onLoadMore}>Load more</Button>}
    </>
  );
}
