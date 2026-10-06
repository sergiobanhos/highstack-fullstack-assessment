import { Stack, Tabs } from '@mantine/core';
import type { WalletPageModelOptions } from '../features/wallet/hooks/use-wallet-page-model';
import { useWalletPageModel } from '../features/wallet/hooks/use-wallet-page-model';
import { WalletHistory } from '../features/wallet/components/wallet-history';
import { WalletBalanceCard } from '../features/wallet/components/wallet-balance-card';
import { TopUpPanel } from '../features/wallet/components/top-up-panel';
import { PayoutPanel } from '../features/wallet/components/payout-panel';

export type WalletScreenProps = WalletPageModelOptions;

export function WalletScreen(props: WalletScreenProps): React.JSX.Element {
  const { wallet, topUp, ledger, payouts } = useWalletPageModel(props);

  return (
    <Stack gap="md">
      <WalletBalanceCard balanceCents={wallet.balanceCents} onRefresh={() => void wallet.refresh()} />

      <TopUpPanel
        amount={topUp.amount}
        error={topUp.error}
        pending={topUp.pending}
        busy={topUp.busy}
        onAmountChange={topUp.setAmount}
        onSubmit={() => void topUp.submit()}
        onDismissError={topUp.dismissError}
      />

      <Tabs defaultValue="ledger" keepMounted={false}>
        <Tabs.List>
          <Tabs.Tab value="ledger">Transactions</Tabs.Tab>
          <Tabs.Tab value="payouts">Payouts</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="ledger" pt="md">
          <WalletHistory
            ledger={ledger.items}
            error={ledger.error}
            loading={ledger.loading}
            hasMore={ledger.hasMore}
            onRefresh={() => void ledger.refresh()}
            onLoadMore={() => void ledger.loadMore()}
          />
        </Tabs.Panel>

        <Tabs.Panel value="payouts" pt="md">
          <PayoutPanel
            availability={payouts.availability}
            payouts={payouts.items}
            hasMore={payouts.hasMore}
            amount={payouts.amount}
            error={payouts.error}
            pending={payouts.pending}
            busy={payouts.busy}
            onAmountChange={payouts.setAmount}
            onSubmit={() => void payouts.submit()}
            onDismissError={payouts.dismissError}
            onRetry={() => void payouts.retry()}
            onRefreshItem={() => void payouts.refresh()}
            onLoadMore={() => void payouts.loadMore()}
          />
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}
