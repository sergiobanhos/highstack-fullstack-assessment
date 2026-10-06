import { Accordion, Alert, Stack } from '@mantine/core';
import type { GamePageModelOptions } from '../features/game/hooks/use-game-page-model';
import { useGamePageModel } from '../features/game/hooks/use-game-page-model';
import { RecentBetsTable } from '../features/game/components/recent-bets-table';
import { BetCommandPanel } from '../features/game/components/bet-command-panel';
import { RoundDiagnostics } from '../features/game/components/round-diagnostics';
import { RoundStatusPanel } from '../features/game/components/round-status-panel';
import { RoundProofPanel } from '../features/game/components/round-proof-panel';

export type GameScreenProps = GamePageModelOptions;

export function GameScreen(props: GameScreenProps): React.JSX.Element {
  const { round, feedback, betCommand, bets, proof } = useGamePageModel(props);

  return (
    <Stack gap="md">
      <RoundStatusPanel
        phase={round.phase}
        roundId={round.roundId}
        sequence={round.snapshot?.seq ?? null}
        multiplier={round.multiplierText}
        stale={round.stale}
        staleAlertVisible={round.staleAlertVisible}
        upstream={round.stream.upstream}
        downstream={round.stream.downstream}
        sessionUnavailable={round.session === 'unavailable'}
        onRetrySession={round.retrySession}
      />

      {feedback.value !== null && (
        <Alert color={feedback.value.color} withCloseButton onClose={feedback.dismiss}>
          {feedback.value.text}
        </Alert>
      )}

      <BetCommandPanel
        amountText={betCommand.amountText}
        autoCashoutText={betCommand.autoCashoutText}
        amountError={betCommand.amountError}
        autoCashoutError={betCommand.autoCashoutError}
        busy={betCommand.busy}
        canBet={betCommand.canBet}
        canCashout={betCommand.canCashout}
        cashoutLabel={betCommand.cashoutLabel}
        phase={round.phase}
        conflictingBet={bets.conflictingBet}
        pending={betCommand.pending}
        onAmountChange={betCommand.setAmountText}
        onAutoCashoutChange={betCommand.setAutoCashoutText}
        onBet={() => void betCommand.submitBet()}
        onCashout={() => void betCommand.submitCashout()}
        onReconcile={() => betCommand.pending !== null && void betCommand.reconcile(betCommand.pending)}
      />

      <RecentBetsTable
        bets={bets.items}
        error={bets.error}
        roundId={round.roundId}
        phase={round.phase}
        liveMultiplierHundredths={bets.liveMultiplierHundredths}
        checkingBetIds={bets.checkingBetIds}
        failedBetVerifications={bets.failedBetVerifications}
        onRefresh={() => void bets.load()}
        onRefreshBet={(betId) => void bets.refreshOne(betId)}
      />

      <Accordion variant="contained">
        <RoundProofPanel commitmentHash={proof.commitmentHash} revealed={proof.revealed} proof={proof.result} onRetry={proof.retry} />
        <RoundDiagnostics stream={round.stream} roundId={round.roundId} sequence={round.snapshot?.seq ?? null} />
      </Accordion>
    </Stack>
  );
}
