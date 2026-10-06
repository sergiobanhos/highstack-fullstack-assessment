import { useState } from 'react';
import { Alert, Stack, Tabs, Text, Title } from '@mantine/core';
import type { WalletPageModelOptions } from '../features/wallet/hooks/use-wallet-page-model';
import { useWalletPageModel } from '../features/wallet/hooks/use-wallet-page-model';
import { WalletHistory, PayoutHistory } from '../features/wallet/components/wallet-history';
import { WalletBalanceCard } from '../features/wallet/components/wallet-balance-card';
import { WalletActionCards } from '../features/wallet/components/wallet-action-cards';
import { TopUpPanel } from '../features/wallet/components/top-up-panel';
import { PayoutPanel } from '../features/wallet/components/payout-panel';
import '../features/wallet/wallet.css';

export type WalletScreenProps = WalletPageModelOptions;

export function WalletScreen(props: WalletScreenProps): React.JSX.Element {
  const { wallet, topUp, ledger, payouts } = useWalletPageModel(props);
  const [topUpOpened, setTopUpOpened] = useState(false);
  const [payoutOpened, setPayoutOpened] = useState(false);

  const closeTopUp = (): void => {
    setTopUpOpened(false);
    topUp.dismissReceipt();
  };
  const closePayout = (): void => {
    setPayoutOpened(false);
    payouts.dismissReceipt();
  };

  return (
    <Stack className="hs-wallet-page" gap="md">
      <div className="hs-wallet-heading">
        <Title order={1}>Wallet</Title>
        <Text size="sm" c="dimmed">Manage your local test balance and review activity.</Text>
      </div>
      <WalletBalanceCard balanceCents={wallet.balanceCents} onRefresh={() => void wallet.refresh()} />
      <WalletActionCards
        onAddFunds={() => { topUp.dismissReceipt(); topUp.dismissError(); setTopUpOpened(true); }}
        onRequestPayout={() => { payouts.dismissReceipt(); payouts.dismissError(); setPayoutOpened(true); }}
      />

      <Tabs className="hs-wallet-tabs" defaultValue="ledger" keepMounted={false}>
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
          {payouts.availability.status === 'disabled' && <Alert className="hs-wallet-history__notice" color="gray" mb="sm" title="Local payout unavailable">This operator has payout simulation disabled.</Alert>}
          {payouts.availability.status === 'error' && <Alert className="hs-wallet-history__notice" color="red" mb="sm" title="Could not load payouts">{payouts.availability.message}</Alert>}
          <PayoutHistory
            payouts={payouts.items}
            hasMore={payouts.hasMore}
            onRefreshItem={() => void payouts.refresh()}
            onLoadMore={() => void payouts.loadMore()}
          />
        </Tabs.Panel>
      </Tabs>

      <TopUpPanel
        opened={topUpOpened}
        amount={topUp.amount}
        error={topUp.error}
        pending={topUp.pending}
        receipt={topUp.receipt}
        completedAmount={topUp.completedAmount}
        busy={topUp.busy}
        onAmountChange={topUp.setAmount}
        onSubmit={() => void topUp.submit()}
        onClose={closeTopUp}
      />
      <PayoutPanel
        opened={payoutOpened}
        availability={payouts.availability}
        amount={payouts.amount}
        error={payouts.error}
        pending={payouts.pending}
        receipt={payouts.receipt}
        balanceCents={wallet.balanceCents}
        busy={payouts.busy}
        onAmountChange={payouts.setAmount}
        onSubmit={() => void payouts.submit()}
        onClose={closePayout}
        onRetry={payouts.retry}
      />
    </Stack>
  );
}
