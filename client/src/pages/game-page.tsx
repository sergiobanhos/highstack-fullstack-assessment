import { Accordion, Alert, Stack } from '@mantine/core';
import type { GamePageModelOptions } from '../features/game/hooks/use-game-page-model';
import { useGamePageModel } from '../features/game/hooks/use-game-page-model';
import { RecentBetsTable } from '../features/game/components/recent-bets-table';
import { BetCommandPanel } from '../features/game/components/bet-command-panel';
import { RoundDiagnostics } from '../features/game/components/round-diagnostics';
import { RoundStatusPanel } from '../features/game/components/round-status-panel';
import { RoundProofPanel } from '../features/game/components/round-proof-panel';
import { GameOutcomeDialog } from '../features/game/components/game-outcome-dialog';
import '../features/game/game.css';

export type GameScreenProps = GamePageModelOptions;

export function GameScreen(props: GameScreenProps): React.JSX.Element {
  const { round, feedback, autoCashout, betCommand, bets, proof } = useGamePageModel(props);

  return (
    <Stack className="hs-game-page" gap="md">
      <div className="hs-game-layout">
        <div className="hs-game-layout__main">
          <RoundStatusPanel
            phase={round.phase}
            roundId={round.roundId}
            sequence={round.snapshot?.seq ?? null}
            multiplier={round.multiplierText}
            snapshot={round.snapshot}
            chartPoints={round.stream.tickHistory}
            stale={round.stale}
            staleAlertVisible={round.staleAlertVisible}
            upstream={round.stream.upstream}
            downstream={round.stream.downstream}
            sessionUnavailable={round.session === 'unavailable'}
            onRetrySession={round.retrySession}
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
        </div>

        <aside className="hs-game-layout__side">
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
          />
        </aside>
      </div>

      {feedback.value !== null && !feedback.value.kind.startsWith('cashout') && (
        <Alert className="hs-command-feedback" color={feedback.value.color} withCloseButton onClose={feedback.dismiss}>
          {feedback.value.text}
        </Alert>
      )}

      <GameOutcomeDialog
        feedback={feedback.value}
        autoCashout={autoCashout.value}
        pending={betCommand.pending}
        pendingOpen={betCommand.pendingDialogOpen}
        onDismissFeedback={feedback.dismiss}
        onDismissAutoCashout={autoCashout.dismiss}
        onCheckAutoCashout={() => void bets.load()}
        onDismissPending={betCommand.dismissPendingDialog}
        onReconcile={() => betCommand.pending !== null && void betCommand.reconcile(betCommand.pending)}
      />

      <Accordion className="hs-game-details" variant="contained">
        <RoundProofPanel commitmentHash={proof.commitmentHash} revealed={proof.revealed} proof={proof.result} onRetry={proof.retry} />
        <RoundDiagnostics stream={round.stream} roundId={round.roundId} sequence={round.snapshot?.seq ?? null} />
      </Accordion>
    </Stack>
  );
}
