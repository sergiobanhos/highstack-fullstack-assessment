import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Group,
  Loader,
  Paper,
  Stack,
  Table,
  Tabs,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  createIdempotencyKey,
  isTerminalRefusal,
  isUnauthenticated,
  OperatorApiError,
  type LedgerEntry,
  type OperatorApi,
  type Payout,
} from './operator-api';
import { formatCents, formatCentsInput, formatSignedCents, parseUsdToCents } from './money';
import { mergePayoutPage, upsertPayout } from './payouts';
import {
  clearPendingPayout,
  clearPendingTopUp,
  readPendingPayout,
  readPendingTopUp,
  writePendingPayout,
  writePendingTopUp,
  type PendingAmountCommand,
} from './pending-commands';

const LEDGER_PAGE_SIZE = 20;
const PAYOUT_PAGE_SIZE = 50;
const PAYOUT_POLL_DELAYS_MS = [1000, 2000, 4000] as const;

/** A payout the list knows about but `GET /payouts/:id` no longer returns. */
type PayoutView = Payout & { missing?: boolean };

type PayoutAvailability =
  | { status: 'checking' }
  | { status: 'ready' }
  | { status: 'disabled' }
  | { status: 'error'; message: string };

export interface WalletScreenProps {
  api: OperatorApi;
  token: string;
  balanceCents: number | null;
  onBalanceChange(balanceCents: number): void;
  onUnauthorized(): void;
}

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
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(milliseconds);
}

function describeTopUpError(error: unknown): string {
  if (error instanceof OperatorApiError) {
    switch (error.code) {
      case 'INVALID_AMOUNT':
        return 'Amount is outside the range supported by the operator.';
      case 'BALANCE_LIMIT':
        return 'The balance would exceed the operator limit.';
      case 'IDEMPOTENCY_CONFLICT':
        return 'This request conflicts with an earlier top-up. Refresh the wallet before trying again.';
      case 'SERVICE_UNAVAILABLE':
        return 'The financial service is currently unavailable.';
      default:
        if (error.status === 404) return 'Test top-up is not enabled on this operator.';
        return error.message;
    }
  }
  return 'Could not reach the operator. Check your connection.';
}

function describePayoutError(error: unknown): string {
  if (error instanceof OperatorApiError) {
    switch (error.code) {
      case 'INSUFFICIENT_FUNDS':
        return 'Insufficient balance for this payout.';
      case 'INVALID_AMOUNT':
        return 'Amount is outside the range supported by the operator.';
      case 'BALANCE_LIMIT':
        return 'The amount exceeds the operator limit.';
      case 'IDEMPOTENCY_CONFLICT':
        return 'This request conflicts with an earlier payout. Refresh the history before trying again.';
      case 'SERVICE_UNAVAILABLE':
        return 'The financial service is currently unavailable.';
      default:
        if (error.status === 404) return 'Local payout is not enabled on this operator.';
        return error.message;
    }
  }
  return 'Could not reach the operator. Check your connection.';
}

export function WalletScreen({
  api,
  token,
  balanceCents,
  onBalanceChange,
  onUnauthorized,
}: WalletScreenProps): React.JSX.Element {
  const [ledger, setLedger] = useState<LedgerEntry[] | null>(null);
  const [ledgerCursor, setLedgerCursor] = useState<string | null>(null);
  const [ledgerError, setLedgerError] = useState<string | null>(null);
  const [ledgerBusy, setLedgerBusy] = useState(false);

  const [topUpAmount, setTopUpAmount] = useState('');
  const [topUpError, setTopUpError] = useState<string | null>(null);
  const [topUpBusy, setTopUpBusy] = useState(false);
  const [pendingTopUp, setPendingTopUp] = useState<PendingAmountCommand | null>(() =>
    readPendingTopUp(),
  );

  const [payouts, setPayouts] = useState<PayoutView[] | null>(null);
  const [payoutCursor, setPayoutCursor] = useState<string | null>(null);
  const [payoutAvailability, setPayoutAvailability] = useState<PayoutAvailability>({
    status: 'checking',
  });
  const [payoutAmount, setPayoutAmount] = useState('');
  const [payoutError, setPayoutError] = useState<string | null>(null);
  const [payoutBusy, setPayoutBusy] = useState(false);
  const [pendingPayout, setPendingPayout] = useState<PendingAmountCommand | null>(() =>
    readPendingPayout(),
  );
  const [payoutPolls, setPayoutPolls] = useState(0);

  const refreshBalance = useCallback(async (): Promise<void> => {
    try {
      const wallet = await api.getWallet(token);
      onBalanceChange(wallet.balanceCents);
    } catch (error) {
      if (isUnauthenticated(error)) onUnauthorized();
    }
  }, [api, token, onBalanceChange, onUnauthorized]);

  const loadLedger = useCallback(
    async (mode: 'reset' | 'more', cursor: string | null): Promise<void> => {
      setLedgerBusy(true);
      setLedgerError(null);
      try {
        const page = await api.getTransactions(token, {
          limit: LEDGER_PAGE_SIZE,
          ...(mode === 'more' && cursor !== null ? { cursor } : {}),
        });
        setLedger((current) => (mode === 'more' && current !== null ? [...current, ...page.items] : page.items));
        setLedgerCursor(page.nextCursor);
      } catch (error) {
        if (isUnauthenticated(error)) {
          onUnauthorized();
          return;
        }
        setLedgerError(
          error instanceof OperatorApiError ? error.message : 'Could not load the history.',
        );
      } finally {
        setLedgerBusy(false);
      }
    },
    [api, token, onUnauthorized],
  );

  const loadPayouts = useCallback(
    async (mode: 'reset' | 'more', cursor: string | null): Promise<void> => {
      try {
        const page = await api.listPayouts(token, {
          limit: PAYOUT_PAGE_SIZE,
          ...(mode === 'more' && cursor !== null ? { cursor } : {}),
        });
        setPayouts((current) =>
          mode === 'more' && current !== null ? mergePayoutPage(current, page.items) : page.items,
        );
        setPayoutCursor(page.nextCursor);
        setPayoutAvailability({ status: 'ready' });
        setPayoutError(null);
      } catch (error) {
        if (isUnauthenticated(error)) {
          onUnauthorized();
          return;
        }
        if (error instanceof OperatorApiError && error.status === 404 && error.code === null) {
          // Route not registered: local payout simulation is disabled here.
          setPayoutAvailability({ status: 'disabled' });
          setPayouts(null);
          return;
        }
        setPayoutAvailability({
          status: 'error',
          message: error instanceof OperatorApiError ? error.message : 'Could not load payouts.',
        });
      }
    },
    [api, token, onUnauthorized],
  );

  useEffect(() => {
    void refreshBalance();
  }, [refreshBalance]);

  useEffect(() => {
    void loadLedger('reset', null);
  }, [loadLedger]);

  useEffect(() => {
    void loadPayouts('reset', null);
  }, [loadPayouts]);

  // A requested payout settles shortly after; poll briefly, then require a manual refresh.
  useEffect(() => {
    if (payouts === null) return;
    const processing = payouts.filter((item) => item.status === 'processing' && item.missing !== true);
    if (processing.length === 0 || payoutPolls >= PAYOUT_POLL_DELAYS_MS.length) return;
    const timer = setTimeout(() => {
      setPayoutPolls((count) => count + 1);
      void (async () => {
        for (const item of processing) {
          try {
            const fresh = await api.getPayout(token, item.id);
            setPayouts((current) => (current === null ? current : upsertPayout(current, fresh)));
            if (fresh.status === 'done') void refreshBalance();
          } catch (error) {
            if (isUnauthenticated(error)) {
              onUnauthorized();
              return;
            }
            // The list still shows it, but the item is gone or belongs to
            // another identity: stop treating it as an in-flight payout.
            if (error instanceof OperatorApiError && error.status === 404 && error.code !== null) {
              setPayouts((current) =>
                current === null ? current : upsertPayout(current, { ...item, missing: true }),
              );
            }
          }
        }
      })();
    }, PAYOUT_POLL_DELAYS_MS[payoutPolls]);
    return () => clearTimeout(timer);
  }, [payouts, payoutPolls, api, token, onUnauthorized, refreshBalance]);

  const runTopUp = async (command: PendingAmountCommand): Promise<void> => {
    setTopUpBusy(true);
    setTopUpError(null);
    try {
      const receipt = await api.requestTopUp(token, command);
      clearPendingTopUp();
      setPendingTopUp(null);
      setTopUpAmount('');
      onBalanceChange(receipt.balanceCents);
      await loadLedger('reset', null);
      notifications.show({
        color: 'teal',
        title: 'Balance added',
        message: `${formatCents(command.amountCents)} credited (local test operation).`,
      });
    } catch (error) {
      if (isUnauthenticated(error)) {
        onUnauthorized();
        return;
      }
      if (isTerminalRefusal(error)) {
        // Definitive pre-commit refusal: the key is spent, a new attempt needs a new one.
        clearPendingTopUp();
        setPendingTopUp(null);
        setTopUpError(describeTopUpError(error));
        return;
      }
      // Timeout, unparseable body, or operator failure: the key is kept, because
      // the credit may have been committed. Retrying replays the same operation.
      setTopUpError(
        'Could not confirm the operation. It is still pending; retry before creating another.',
      );
    } finally {
      setTopUpBusy(false);
    }
  };

  const submitTopUp = async (): Promise<void> => {
    if (pendingTopUp !== null) {
      await runTopUp(pendingTopUp);
      return;
    }
    const parsed = parseUsdToCents(topUpAmount);
    if (!parsed.ok) {
      setTopUpError(parsed.message);
      return;
    }
    const command: PendingAmountCommand = {
      idempotencyKey: createIdempotencyKey(),
      amountCents: parsed.value,
    };
    writePendingTopUp(command);
    setPendingTopUp(command);
    await runTopUp(command);
  };

  const runPayout = async (command: PendingAmountCommand): Promise<void> => {
    setPayoutBusy(true);
    setPayoutError(null);
    try {
      const payout = await api.createPayout(token, command);
      clearPendingPayout();
      setPendingPayout(null);
      setPayoutAmount('');
      setPayoutPolls(0);
      setPayouts((current) => (current === null ? [payout] : upsertPayout(current, payout)));
      await loadLedger('reset', null);
      await refreshBalance();
      notifications.show({
        color: 'teal',
        title: 'Payout requested',
        message: `${formatCents(payout.amountCents)} processing (local simulation).`,
      });
    } catch (error) {
      if (isUnauthenticated(error)) {
        onUnauthorized();
        return;
      }
      if (isTerminalRefusal(error)) {
        // Only pre-commit refusals consume the key. A `503` can arrive *after*
        // the debit committed, so it must keep the key and be retried as-is.
        clearPendingPayout();
        setPendingPayout(null);
        setPayoutError(describePayoutError(error));
        return;
      }
      setPayoutError(
        'Could not confirm the request. It is still pending; retry before creating another.',
      );
    } finally {
      setPayoutBusy(false);
    }
  };

  const submitPayout = async (): Promise<void> => {
    if (pendingPayout !== null) {
      await runPayout(pendingPayout);
      return;
    }
    const parsed = parseUsdToCents(payoutAmount);
    if (!parsed.ok) {
      setPayoutError(parsed.message);
      return;
    }
    if (balanceCents !== null && parsed.value > balanceCents) {
      setPayoutError('The amount exceeds the displayed available balance.');
      return;
    }
    const command: PendingAmountCommand = {
      idempotencyKey: createIdempotencyKey(),
      amountCents: parsed.value,
    };
    writePendingPayout(command);
    setPendingPayout(command);
    await runPayout(command);
  };

  return (
    <Stack gap="md">
      <Paper withBorder p="md" radius="md">
        <Group justify="space-between" align="center" wrap="wrap">
          <div>
            <Text size="sm" c="dimmed">
              Available balance
            </Text>
            <Title order={2}>{balanceCents === null ? '—' : formatCents(balanceCents)}</Title>
          </div>
          <Stack gap={4} align="flex-end">
            <Badge variant="light">Local environment — test balance</Badge>
            <Button size="xs" variant="default" onClick={() => void refreshBalance()}>
              Refresh balance
            </Button>
          </Stack>
        </Group>
      </Paper>

      <Paper withBorder p="md" radius="md">
        <Title order={4}>Add balance (test top-up)</Title>
        <Text size="sm" c="dimmed" mt={4}>
          Local test operation with an idempotency key: retrying does not credit twice.
        </Text>
        {pendingTopUp !== null && (
          <Alert color="yellow" mt="sm" title="Top-up awaiting confirmation">
            {formatCents(pendingTopUp.amountCents)} — the previous response never arrived. Try again
            to confirm; the same key will be reused.
          </Alert>
        )}
        {topUpError !== null && (
          <Alert color="red" mt="sm" withCloseButton onClose={() => setTopUpError(null)}>
            {topUpError}
          </Alert>
        )}
        <Group align="flex-end" mt="sm" wrap="wrap">
          <TextInput
            label="Amount (USD)"
            placeholder="50.00"
            inputMode="decimal"
            w={160}
            value={pendingTopUp !== null ? formatCentsInput(pendingTopUp.amountCents) : topUpAmount}
            disabled={pendingTopUp !== null}
            onChange={(event) => setTopUpAmount(event.currentTarget.value)}
          />
          <Button onClick={() => void submitTopUp()} loading={topUpBusy}>
            {pendingTopUp !== null ? 'Try again' : 'Add balance'}
          </Button>
        </Group>
      </Paper>

      <Tabs defaultValue="ledger" keepMounted={false}>
        <Tabs.List>
          <Tabs.Tab value="ledger">Transactions</Tabs.Tab>
          <Tabs.Tab value="payouts">Payouts</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="ledger" pt="md">
          <Paper withBorder p="md" radius="md">
            <Group justify="space-between">
              <Title order={4}>Wallet history</Title>
              <Button size="xs" variant="default" onClick={() => void loadLedger('reset', null)}>
                Refresh
              </Button>
            </Group>
            {ledgerError !== null && (
              <Alert color="red" mt="sm" withCloseButton onClose={() => setLedgerError(null)}>
                {ledgerError}
              </Alert>
            )}
            <Table mt="sm" striped withTableBorder>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>When</Table.Th>
                  <Table.Th>Operation</Table.Th>
                  <Table.Th>Amount</Table.Th>
                  <Table.Th>Balance after</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {ledger === null ? (
                  <Table.Tr>
                    <Table.Td colSpan={4}>
                      <Group gap="xs">
                        <Loader size="xs" />
                        <Text size="sm" c="dimmed">
                          Loading…
                        </Text>
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                ) : ledger.length === 0 ? (
                  <Table.Tr>
                    <Table.Td colSpan={4}>
                      <Text size="sm" c="dimmed">
                        No transactions yet.
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                ) : (
                  ledger.map((entry) => (
                    <Table.Tr key={entry.id}>
                      <Table.Td>{formatTimestamp(entry.createdAt)}</Table.Td>
                      <Table.Td>
                        <Badge size="sm" variant="light" color={entry.direction === 'credit' ? 'teal' : 'orange'}>
                          {DIRECTION_LABELS[entry.direction]}
                        </Badge>{' '}
                        {SOURCE_LABELS[entry.source] ?? entry.source}
                      </Table.Td>
                      <Table.Td>{formatSignedCents(entry.amountCents, entry.direction)}</Table.Td>
                      <Table.Td>{formatCents(entry.balanceAfterCents)}</Table.Td>
                    </Table.Tr>
                  ))
                )}
              </Table.Tbody>
            </Table>
            {ledgerCursor !== null && (
              <Button mt="sm" size="xs" variant="light" loading={ledgerBusy} onClick={() => void loadLedger('more', ledgerCursor)}>
                Load more
              </Button>
            )}
          </Paper>
        </Tabs.Panel>

        <Tabs.Panel value="payouts" pt="md">
          <Paper withBorder p="md" radius="md">
            <Title order={4}>Simulated payout</Title>
            <Text size="sm" c="dimmed" mt={4}>
              Local test payout. The request is recorded by the operator and does not use real money.
            </Text>

            {payoutAvailability.status === 'checking' && (
              <Group gap="xs" mt="sm">
                <Loader size="xs" />
                <Text size="sm" c="dimmed">
                  Checking local payout availability…
                </Text>
              </Group>
            )}

            {payoutAvailability.status === 'disabled' && (
              <Alert color="gray" mt="sm" title="Local payout unavailable">
                This operator has payout simulation disabled.
              </Alert>
            )}

            {payoutAvailability.status === 'error' && (
              <Alert color="red" mt="sm" title="Could not load payouts">
                <Group justify="space-between">
                  <Text size="sm">{payoutAvailability.message}</Text>
                  <Button size="xs" variant="light" onClick={() => void loadPayouts('reset', null)}>
                    Try again
                  </Button>
                </Group>
              </Alert>
            )}

            {payoutAvailability.status === 'ready' && (
              <>
                {pendingPayout !== null && (
                  <Alert color="yellow" mt="sm" title="Payout awaiting confirmation">
                    {formatCents(pendingPayout.amountCents)} — the previous response never arrived.
                    Try again to confirm; the same key will be reused.
                  </Alert>
                )}
                {payoutError !== null && (
                  <Alert color="red" mt="sm" withCloseButton onClose={() => setPayoutError(null)}>
                    {payoutError}
                  </Alert>
                )}
                <Group align="flex-end" mt="sm" wrap="wrap">
                  <TextInput
                    label="Amount (USD)"
                    placeholder="25.00"
                    inputMode="decimal"
                    w={160}
                    value={pendingPayout !== null ? formatCentsInput(pendingPayout.amountCents) : payoutAmount}
                    disabled={pendingPayout !== null}
                    onChange={(event) => setPayoutAmount(event.currentTarget.value)}
                  />
                  <Button onClick={() => void submitPayout()} loading={payoutBusy}>
                    {pendingPayout !== null ? 'Try again' : 'Request payout'}
                  </Button>
                </Group>

                <Table mt="md" striped withTableBorder>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Requested</Table.Th>
                      <Table.Th>Reference</Table.Th>
                      <Table.Th>Amount</Table.Th>
                      <Table.Th>Status</Table.Th>
                      <Table.Th>Completed</Table.Th>
                      <Table.Th />
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {payouts === null || payouts.length === 0 ? (
                      <Table.Tr>
                        <Table.Td colSpan={6}>
                          <Text size="sm" c="dimmed">
                            {payouts === null ? 'Loading…' : 'No payouts requested yet.'}
                          </Text>
                        </Table.Td>
                      </Table.Tr>
                    ) : (
                      payouts.map((payout) => (
                        <Table.Tr key={payout.id}>
                          <Table.Td>{formatTimestamp(payout.requestedAt)}</Table.Td>
                          <Table.Td>
                            <Text size="xs" ff="monospace">
                              {payout.id.slice(0, 8)}…
                            </Text>
                          </Table.Td>
                          <Table.Td>{formatCents(payout.amountCents)}</Table.Td>
                          <Table.Td>
                            {payout.missing === true ? (
                              <Badge variant="light" color="red">
                                Not found
                              </Badge>
                            ) : (
                              <>
                                <Badge
                                  variant="light"
                                  color={payout.status === 'done' ? 'teal' : 'blue'}
                                >
                                  {PAYOUT_STATUS_LABELS[payout.status]}
                                </Badge>
                                {payout.simulated && (
                                  <Text size="xs" c="dimmed">
                                    local simulation
                                  </Text>
                                )}
                              </>
                            )}
                          </Table.Td>
                          <Table.Td>
                            {payout.completedAt === null ? '—' : formatTimestamp(payout.completedAt)}
                          </Table.Td>
                          <Table.Td>
                            {payout.status === 'processing' && payout.missing !== true && (
                              <Button
                                size="compact-xs"
                                variant="light"
                                onClick={() => {
                                  setPayoutPolls(0);
                                  void loadPayouts('reset', null);
                                }}
                              >
                                Refresh
                              </Button>
                            )}
                          </Table.Td>
                        </Table.Tr>
                      ))
                    )}
                  </Table.Tbody>
                </Table>
                {payoutCursor !== null && (
                  <Button mt="sm" size="xs" variant="light" onClick={() => void loadPayouts('more', payoutCursor)}>
                    Load more
                  </Button>
                )}
              </>
            )}
          </Paper>
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}
