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
  credit: 'Crédito',
  debit: 'Débito',
};

const SOURCE_LABELS: Record<string, string> = {
  engine: 'Engine (aposta/cashout)',
  test: 'Top-up de teste',
  payout: 'Saque simulado',
  reconciliation: 'Reconciliação',
};

const PAYOUT_STATUS_LABELS: Record<Payout['status'], string> = {
  processing: 'Processando',
  done: 'Concluído',
};

function formatTimestamp(value: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return value;
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(milliseconds);
}

function describeTopUpError(error: unknown): string {
  if (error instanceof OperatorApiError) {
    switch (error.code) {
      case 'INVALID_AMOUNT':
        return 'Valor fora do intervalo suportado pelo operador.';
      case 'BALANCE_LIMIT':
        return 'O saldo ultrapassaria o limite suportado pelo operador.';
      case 'IDEMPOTENCY_CONFLICT':
        return 'Esta solicitação conflita com um top-up anterior. Atualize a carteira antes de tentar de novo.';
      case 'SERVICE_UNAVAILABLE':
        return 'O serviço financeiro está indisponível no momento.';
      default:
        if (error.status === 404) return 'O top-up de teste não está habilitado neste operador.';
        return error.message;
    }
  }
  return 'Não foi possível falar com o operador. Verifique a conexão.';
}

function describePayoutError(error: unknown): string {
  if (error instanceof OperatorApiError) {
    switch (error.code) {
      case 'INSUFFICIENT_FUNDS':
        return 'Saldo insuficiente para esse saque.';
      case 'INVALID_AMOUNT':
        return 'Valor fora do intervalo suportado pelo operador.';
      case 'BALANCE_LIMIT':
        return 'O valor excede o limite suportado pelo operador.';
      case 'IDEMPOTENCY_CONFLICT':
        return 'Esta solicitação conflita com um saque anterior. Atualize o histórico antes de tentar de novo.';
      case 'SERVICE_UNAVAILABLE':
        return 'O serviço financeiro está indisponível no momento.';
      default:
        if (error.status === 404) return 'O saque local não está habilitado neste operador.';
        return error.message;
    }
  }
  return 'Não foi possível falar com o operador. Verifique a conexão.';
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
          error instanceof OperatorApiError ? error.message : 'Não foi possível carregar o histórico.',
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
          message: error instanceof OperatorApiError ? error.message : 'Não foi possível carregar os saques.',
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
        title: 'Saldo adicionado',
        message: `${formatCents(command.amountCents)} creditados (operação de teste local).`,
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
        'Não foi possível confirmar a operação. Ela continua pendente; tente novamente antes de criar outra.',
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
        title: 'Saque solicitado',
        message: `${formatCents(payout.amountCents)} em processamento (simulação local).`,
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
        'Não foi possível confirmar a solicitação. Ela continua pendente; tente novamente antes de criar outra.',
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
      setPayoutError('O valor excede o saldo disponível exibido.');
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
              Saldo disponível
            </Text>
            <Title order={2}>{balanceCents === null ? '—' : formatCents(balanceCents)}</Title>
          </div>
          <Stack gap={4} align="flex-end">
            <Badge variant="light">Ambiente local — saldo de teste</Badge>
            <Button size="xs" variant="default" onClick={() => void refreshBalance()}>
              Atualizar saldo
            </Button>
          </Stack>
        </Group>
      </Paper>

      <Paper withBorder p="md" radius="md">
        <Title order={4}>Adicionar saldo (top-up de teste)</Title>
        <Text size="sm" c="dimmed" mt={4}>
          Operação local de teste com chave idempotente: tentar de novo não credita duas vezes.
        </Text>
        {pendingTopUp !== null && (
          <Alert color="yellow" mt="sm" title="Top-up pendente de confirmação">
            {formatCents(pendingTopUp.amountCents)} — a resposta anterior não chegou. Tente novamente
            para confirmar; a mesma chave será reutilizada.
          </Alert>
        )}
        {topUpError !== null && (
          <Alert color="red" mt="sm" withCloseButton onClose={() => setTopUpError(null)}>
            {topUpError}
          </Alert>
        )}
        <Group align="flex-end" mt="sm" wrap="wrap">
          <TextInput
            label="Valor (USD)"
            placeholder="50.00"
            inputMode="decimal"
            w={160}
            value={pendingTopUp !== null ? formatCentsInput(pendingTopUp.amountCents) : topUpAmount}
            disabled={pendingTopUp !== null}
            onChange={(event) => setTopUpAmount(event.currentTarget.value)}
          />
          <Button onClick={() => void submitTopUp()} loading={topUpBusy}>
            {pendingTopUp !== null ? 'Tentar novamente' : 'Adicionar saldo'}
          </Button>
        </Group>
      </Paper>

      <Tabs defaultValue="ledger" keepMounted={false}>
        <Tabs.List>
          <Tabs.Tab value="ledger">Movimentações</Tabs.Tab>
          <Tabs.Tab value="payouts">Saques</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="ledger" pt="md">
          <Paper withBorder p="md" radius="md">
            <Group justify="space-between">
              <Title order={4}>Histórico da carteira</Title>
              <Button size="xs" variant="default" onClick={() => void loadLedger('reset', null)}>
                Atualizar
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
                  <Table.Th>Quando</Table.Th>
                  <Table.Th>Operação</Table.Th>
                  <Table.Th>Valor</Table.Th>
                  <Table.Th>Saldo após</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {ledger === null ? (
                  <Table.Tr>
                    <Table.Td colSpan={4}>
                      <Group gap="xs">
                        <Loader size="xs" />
                        <Text size="sm" c="dimmed">
                          Carregando…
                        </Text>
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                ) : ledger.length === 0 ? (
                  <Table.Tr>
                    <Table.Td colSpan={4}>
                      <Text size="sm" c="dimmed">
                        Nenhuma movimentação ainda.
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
                Carregar mais
              </Button>
            )}
          </Paper>
        </Tabs.Panel>

        <Tabs.Panel value="payouts" pt="md">
          <Paper withBorder p="md" radius="md">
            <Title order={4}>Saque simulado</Title>
            <Text size="sm" c="dimmed" mt={4}>
              Saque local de teste. A solicitação é registrada pelo operador e não usa dinheiro real.
            </Text>

            {payoutAvailability.status === 'checking' && (
              <Group gap="xs" mt="sm">
                <Loader size="xs" />
                <Text size="sm" c="dimmed">
                  Verificando disponibilidade do saque local…
                </Text>
              </Group>
            )}

            {payoutAvailability.status === 'disabled' && (
              <Alert color="gray" mt="sm" title="Saque local indisponível">
                Este operador está com a simulação de saque desabilitada.
              </Alert>
            )}

            {payoutAvailability.status === 'error' && (
              <Alert color="red" mt="sm" title="Não foi possível carregar os saques">
                <Group justify="space-between">
                  <Text size="sm">{payoutAvailability.message}</Text>
                  <Button size="xs" variant="light" onClick={() => void loadPayouts('reset', null)}>
                    Tentar novamente
                  </Button>
                </Group>
              </Alert>
            )}

            {payoutAvailability.status === 'ready' && (
              <>
                {pendingPayout !== null && (
                  <Alert color="yellow" mt="sm" title="Saque pendente de confirmação">
                    {formatCents(pendingPayout.amountCents)} — a resposta anterior não chegou. Tente
                    novamente para confirmar; a mesma chave será reutilizada.
                  </Alert>
                )}
                {payoutError !== null && (
                  <Alert color="red" mt="sm" withCloseButton onClose={() => setPayoutError(null)}>
                    {payoutError}
                  </Alert>
                )}
                <Group align="flex-end" mt="sm" wrap="wrap">
                  <TextInput
                    label="Valor (USD)"
                    placeholder="25.00"
                    inputMode="decimal"
                    w={160}
                    value={pendingPayout !== null ? formatCentsInput(pendingPayout.amountCents) : payoutAmount}
                    disabled={pendingPayout !== null}
                    onChange={(event) => setPayoutAmount(event.currentTarget.value)}
                  />
                  <Button onClick={() => void submitPayout()} loading={payoutBusy}>
                    {pendingPayout !== null ? 'Tentar novamente' : 'Solicitar saque'}
                  </Button>
                </Group>

                <Table mt="md" striped withTableBorder>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Solicitado</Table.Th>
                      <Table.Th>Referência</Table.Th>
                      <Table.Th>Valor</Table.Th>
                      <Table.Th>Status</Table.Th>
                      <Table.Th>Concluído</Table.Th>
                      <Table.Th />
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {payouts === null || payouts.length === 0 ? (
                      <Table.Tr>
                        <Table.Td colSpan={6}>
                          <Text size="sm" c="dimmed">
                            {payouts === null ? 'Carregando…' : 'Nenhum saque solicitado ainda.'}
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
                                Não encontrado
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
                                    simulação local
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
                                Atualizar
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
                    Carregar mais
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
