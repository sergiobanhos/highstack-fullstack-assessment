import { useCallback, useEffect, useState } from 'react';
import { useQueryClient, type InfiniteData } from '@tanstack/react-query';
import {
  Stack,
  Tabs,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  createIdempotencyKey,
  isTerminalRefusal,
  isUnauthenticated,
  OperatorApiError,
  type OperatorApi,
  type PayoutPage,
} from '../lib/operator/operator-api';
import { formatCents, parseUsdToCents } from '../lib/money/money';
import { upsertPayout } from '../features/wallet/model/payouts';
import { usePlayerPayoutLookup, usePlayerPayouts, usePlayerTransactions, usePlayerWallet, usePlayerWalletCommands } from '../features/wallet/hooks/use-wallet-data';
import { queryKeys } from '../lib/query/query-keys';
import { WalletHistory, type PayoutView } from '../features/wallet/components/wallet-history';
import { WalletBalanceCard } from '../features/wallet/components/wallet-balance-card';
import { TopUpPanel } from '../features/wallet/components/top-up-panel';
import { PayoutPanel, type PayoutAvailability } from '../features/wallet/components/payout-panel';
import {
  clearPendingPayout,
  clearPendingTopUp,
  readPendingPayout,
  readPendingTopUp,
  writePendingPayout,
  writePendingTopUp,
  type PendingAmountCommand,
} from '../features/wallet/model/pending-commands';

const PAYOUT_POLL_DELAYS_MS = [1000, 2000, 4000] as const;

export interface WalletScreenProps {
  api: OperatorApi;
  token: string;
  playerId: string;
  onUnauthorized(): void;
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
  playerId,
  onUnauthorized,
}: WalletScreenProps): React.JSX.Element {
  const queryClient = useQueryClient();
  const playerContext = { api, token, playerId, onUnauthorized };
  const walletQuery = usePlayerWallet(playerContext);
  const ledgerQuery = usePlayerTransactions(playerContext);
  const payoutsQuery = usePlayerPayouts(playerContext);
  const walletCommands = usePlayerWalletCommands(playerContext);
  const payoutLookup = usePlayerPayoutLookup(playerContext);
  const balanceCents = walletQuery.data?.balanceCents ?? null;
  const ledger = ledgerQuery.data?.pages.flatMap((page) => page.items) ?? null;
  const ledgerError = ledgerQuery.error === null
    ? null
    : ledgerQuery.error instanceof OperatorApiError ? ledgerQuery.error.message : 'Could not load the history.';
  const ledgerBusy = ledgerQuery.isFetching;
  const ledgerCursor = ledgerQuery.hasNextPage ? 'next' : null;

  const [topUpAmount, setTopUpAmount] = useState('');
  const [topUpError, setTopUpError] = useState<string | null>(null);
  const [topUpBusy, setTopUpBusy] = useState(false);
  const [pendingTopUp, setPendingTopUp] = useState<PendingAmountCommand | null>(() =>
    readPendingTopUp(),
  );

  const payoutPages = payoutsQuery.data?.pages.flatMap((page) => page.items) ?? null;
  const [missingPayoutIds, setMissingPayoutIds] = useState<Set<string>>(() => new Set());
  const payouts: PayoutView[] | null = payoutPages?.map((payout) => ({
    ...payout,
    ...(missingPayoutIds.has(payout.id) ? { missing: true } : {}),
  })) ?? null;
  const payoutCursor = payoutsQuery.hasNextPage ? 'next' : null;
  const payoutAvailability: PayoutAvailability = !payoutsQuery.isFetched
    ? { status: 'checking' }
    : payoutsQuery.error instanceof OperatorApiError && payoutsQuery.error.status === 404 && payoutsQuery.error.code === null
      ? { status: 'disabled' }
      : payoutsQuery.error !== null
        ? { status: 'error', message: payoutsQuery.error instanceof Error ? payoutsQuery.error.message : 'Could not load payouts.' }
        : { status: 'ready' };
  const [payoutAmount, setPayoutAmount] = useState('');
  const [payoutError, setPayoutError] = useState<string | null>(null);
  const [payoutBusy, setPayoutBusy] = useState(false);
  const [pendingPayout, setPendingPayout] = useState<PendingAmountCommand | null>(() =>
    readPendingPayout(),
  );
  const [payoutPolls, setPayoutPolls] = useState(0);

  const refreshBalance = useCallback(async (): Promise<void> => {
    const result = await walletQuery.refetch();
    if (result.error && isUnauthenticated(result.error)) onUnauthorized();
  }, [walletQuery.refetch, onUnauthorized]);

  const loadLedger = useCallback(async (mode: 'reset' | 'more'): Promise<void> => {
    if (mode === 'more') await ledgerQuery.fetchNextPage();
    else await ledgerQuery.refetch();
  }, [ledgerQuery.fetchNextPage, ledgerQuery.refetch]);

  const loadPayouts = useCallback(async (mode: 'reset' | 'more'): Promise<void> => {
    setPayoutError(null);
    if (mode === 'more') await payoutsQuery.fetchNextPage();
    else await payoutsQuery.refetch();
  }, [payoutsQuery.fetchNextPage, payoutsQuery.refetch]);

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
            const fresh = await payoutLookup(item.id);
            setMissingPayoutIds((current) => {
              if (!current.has(item.id)) return current;
              const next = new Set(current);
              next.delete(item.id);
              return next;
            });
            queryClient.setQueryData<InfiniteData<PayoutPage, string | null>>(queryKeys.payouts(playerId), (current) => {
              if (!current) return current;
              const [first, ...rest] = current.pages;
              return {
                ...current,
                pages: [{ ...first, items: upsertPayout(first.items, fresh) }, ...rest],
              };
            });
            if (fresh.status === 'done') void refreshBalance();
          } catch (error) {
            if (isUnauthenticated(error)) {
              onUnauthorized();
              return;
            }
            // The list still shows it, but the item is gone or belongs to
            // another identity: stop treating it as an in-flight payout.
            if (error instanceof OperatorApiError && error.status === 404 && error.code !== null) {
              setMissingPayoutIds((current) => new Set(current).add(item.id));
            }
          }
        }
      })();
    }, PAYOUT_POLL_DELAYS_MS[payoutPolls]);
    return () => clearTimeout(timer);
  }, [payouts, payoutPolls, api, token, playerId, queryClient, payoutLookup, onUnauthorized, refreshBalance]);

  const runTopUp = async (command: PendingAmountCommand): Promise<void> => {
    setTopUpBusy(true);
    setTopUpError(null);
    try {
      const receipt = await walletCommands.topUp.mutateAsync(command);
      clearPendingTopUp();
      setPendingTopUp(null);
      setTopUpAmount('');
      queryClient.setQueryData(queryKeys.wallet(playerId), { balanceCents: receipt.balanceCents, currency: receipt.currency });
      await loadLedger('reset');
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
      const payout = await walletCommands.payout.mutateAsync(command);
      clearPendingPayout();
      setPendingPayout(null);
      setPayoutAmount('');
      setPayoutPolls(0);
      queryClient.setQueryData<InfiniteData<PayoutPage, string | null>>(queryKeys.payouts(playerId), (current) => {
        if (!current) return current;
        const [first, ...rest] = current.pages;
        return { ...current, pages: [{ ...first, items: upsertPayout(first.items, payout) }, ...rest] };
      });
      await loadLedger('reset');
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
      <WalletBalanceCard balanceCents={balanceCents} onRefresh={() => void refreshBalance()} />

      <TopUpPanel
        amount={topUpAmount}
        error={topUpError}
        pending={pendingTopUp}
        busy={topUpBusy}
        onAmountChange={setTopUpAmount}
        onSubmit={() => void submitTopUp()}
        onDismissError={() => setTopUpError(null)}
      />

      <Tabs defaultValue="ledger" keepMounted={false}>
        <Tabs.List>
          <Tabs.Tab value="ledger">Transactions</Tabs.Tab>
          <Tabs.Tab value="payouts">Payouts</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="ledger" pt="md">
          <WalletHistory
            ledger={ledger}
            error={ledgerError}
            loading={ledgerBusy}
            hasMore={ledgerCursor !== null}
            onRefresh={() => void loadLedger('reset')}
            onLoadMore={() => void loadLedger('more')}
          />
        </Tabs.Panel>

        <Tabs.Panel value="payouts" pt="md">
          <PayoutPanel
            availability={payoutAvailability}
            payouts={payouts}
            hasMore={payoutCursor !== null}
            amount={payoutAmount}
            error={payoutError}
            pending={pendingPayout}
            busy={payoutBusy}
            onAmountChange={setPayoutAmount}
            onSubmit={() => void submitPayout()}
            onDismissError={() => setPayoutError(null)}
            onRetry={() => void loadPayouts('reset')}
            onRefreshItem={() => {
              setPayoutPolls(0);
              void loadPayouts('reset');
            }}
            onLoadMore={() => void loadPayouts('more')}
          />
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}
