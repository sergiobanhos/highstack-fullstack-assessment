import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { isUnauthenticated, OperatorApiError, type BetCommandResult, type OperatorApi } from '../../../lib/operator/operator-api';
import { isBetOutcomePending, shouldRefreshBetsForSnapshot } from '../model/bet-status';
import { usePlayerBetLookups, usePlayerBets, usePlayerGameCommands, usePlayerGameSession } from './use-game-data';
import { useGameStream } from './use-game-stream';
import { queryKeys } from '../../../lib/query/query-keys';
import { useRoundProof } from './use-round-proof';
import { useGameCommandFlow } from './use-game-command-flow';

const BETS_LIMIT = 10;
const SETTLEMENT_POLL_MS = 5000;
const MAX_SETTLEMENT_POLLS = 12;
const STALE_ALERT_DELAY_MS = 2000;
const ACTIVE_BET_POLL_MS = 3000;
const MAX_ACTIVE_BET_POLLS = 40;

export interface GamePageModelOptions {
  api: OperatorApi;
  token: string;
  playerId: string;
  onUnauthorized(): void;
  onWalletChanged(): void;
}

export function describeGameError(error: unknown): string {
  if (error instanceof OperatorApiError) {
    switch (error.code) {
      case 'INSUFFICIENT_FUNDS': return 'Insufficient balance for this bet. Add balance in your wallet.';
      case 'ROUND_NOT_ACCEPTING_BETS': return 'The round is no longer accepting bets.';
      case 'BET_ALREADY_EXISTS': return 'You already have a bet in this round.';
      case 'BET_OUTCOME_UNKNOWN': return 'Your previous bet in this round is still being confirmed.';
      case 'GAME_NOT_SYNCHRONIZED': return 'The operator is not yet synchronized with the engine.';
      case 'ROUND_NOT_RUNNING': return 'The round is no longer running.';
      case 'BET_NOT_ACTIVE': return 'The bet is no longer active for cashout.';
      case 'BET_NOT_FOUND': return 'The bet was not found.';
      case 'IDEMPOTENCY_KEY_REUSED': return 'This request conflicts with an earlier operation. Check your bets.';
      case 'SERVICE_UNAVAILABLE': return 'The operator is currently unavailable.';
      case 'RATE_LIMITED': return 'Too many attempts in a short time. Wait and try again.';
      default: return error.message;
    }
  }
  return 'Could not reach the operator. Check your connection.';
}

export function useGamePageModel({ api, token, playerId, onUnauthorized, onWalletChanged }: GamePageModelOptions) {

  const queryClient = useQueryClient();
  const playerContext = { api, token, playerId, onUnauthorized };
  const { stream, stale } = useGameStream();
  const [sessionAttempt, setSessionAttempt] = useState(0);
  const [betsError, setBetsError] = useState<string | null>(null);
  const [settlementPolls, setSettlementPolls] = useState(0);
  const [staleAlertVisible, setStaleAlertVisible] = useState(false);
  const lastBetsRef = useRef<BetCommandResult[] | null>(null);
  const [checkingBetIds, setCheckingBetIds] = useState<Set<string>>(() => new Set());
  const [failedBetVerifications, setFailedBetVerifications] = useState<Set<string>>(() => new Set());
  const [autoCashout, setAutoCashout] = useState<{ betId: string; command: BetCommandResult | null } | null>(null);
  const previousBetStatusesRef = useRef(new Map<string, string>());
  const triggeredAutoCashoutBetRef = useRef<string | null>(null);
  const betsQuery = usePlayerBets(playerContext, BETS_LIMIT);
  const gameSessionMutation = usePlayerGameSession(playerContext);
  const gameCommands = usePlayerGameCommands(playerContext);
  const betLookups = usePlayerBetLookups(playerContext);
  const bets = betsQuery.data ?? null;
  const session = gameSessionMutation.isError
    ? 'unavailable'
    : gameSessionMutation.isSuccess ? 'ready' : 'connecting';

  useEffect(() => {
    gameSessionMutation.reset();
    gameSessionMutation.mutate();
  }, [gameSessionMutation.mutate, gameSessionMutation.reset, sessionAttempt]);

  // A brief reconnect blip must not throw a full-width warning at the player:
  // the frozen badge and the disabled controls already carry that state, and
  // the alert only appears once the loss of synchronization is not momentary.
  useEffect(() => {
    if (!stale) {
      setStaleAlertVisible(false);
      return;
    }
    const timer = setTimeout(() => setStaleAlertVisible(true), STALE_ALERT_DELAY_MS);
    return () => clearTimeout(timer);
  }, [stale]);
  const snapshot = stream.snapshot;
  const phase = snapshot?.state ?? null;
  const roundId = snapshot?.roundId ?? null;
  const betRoundContextRef = useRef({ roundId, phase });
  betRoundContextRef.current = { roundId, phase };
  const previousConnectedBetRound = useRef<string | null>(null);
  const multiplierText =
    snapshot?.multiplier !== null && snapshot?.multiplier !== undefined
      ? `${snapshot.multiplier.toFixed(2)}x`
      : '—';

  const refreshBet = useCallback(async (betId: string): Promise<void> => {
    setCheckingBetIds((current) => new Set(current).add(betId));
    setFailedBetVerifications((current) => {
      const next = new Set(current);
      next.delete(betId);
      return next;
    });
    try {
      const fresh = await betLookups.bet(betId);
      if (fresh === null) {
        setFailedBetVerifications((current) => new Set(current).add(betId));
        return;
      }
      queryClient.setQueryData<BetCommandResult[]>(queryKeys.bets(playerId, BETS_LIMIT), (current) =>
        current?.map((bet) => (bet.commandId === fresh.commandId ? fresh : bet)),
      );
      if (fresh.bet?.settlementStatus === 'confirmed') onWalletChanged();
    } catch (error) {
      if (isUnauthenticated(error)) onUnauthorized();
      else setFailedBetVerifications((current) => new Set(current).add(betId));
    } finally {
      setCheckingBetIds((current) => {
        const next = new Set(current);
        next.delete(betId);
        return next;
      });
    }
  }, [betLookups, playerId, queryClient, onUnauthorized, onWalletChanged]);

  const loadBets = useCallback(async (): Promise<void> => {
    try {
      const response = await betsQuery.refetch();
      if (response.error) throw response.error;
      const list = response.data ?? [];
      const previous = lastBetsRef.current;
      lastBetsRef.current = list;
      setBetsError(null);

      // A bet that stopped being active is exactly the moment the operator
      // credited it (engine auto-cashout included), so the balance must be
      // re-read instead of being left stale in the header.
      const settledNow = list.some((item) => {
        const before = previous?.find((bet) => bet.commandId === item.commandId);
        return before?.bet?.engineStatus === 'active' && item.bet?.engineStatus !== 'active';
      });
      if (settledNow) onWalletChanged();

      const context = betRoundContextRef.current;
      const closedActiveBets = list.filter(
        (item) => item.betId !== null && isBetOutcomePending(item, context),
      );
      await Promise.all(closedActiveBets.map((item) => refreshBet(item.betId!)));
    } catch (error) {
      if (isUnauthenticated(error)) {
        onUnauthorized();
        return;
      }
      setBetsError(describeGameError(error));
    }
  }, [betsQuery.refetch, onUnauthorized, refreshBet, onWalletChanged]);

  const afterMutation = useCallback(async (): Promise<void> => {
    setSettlementPolls(0);
    await loadBets();
    onWalletChanged();
  }, [loadBets, onWalletChanged]);

  useEffect(() => {
    if (betsQuery.error !== null) {
      if (isUnauthenticated(betsQuery.error)) onUnauthorized();
      else setBetsError(describeGameError(betsQuery.error));
    }
  }, [betsQuery.error, onUnauthorized]);

  useEffect(() => {
    if (betsQuery.data !== undefined) {
      lastBetsRef.current = betsQuery.data;
      setBetsError(null);
    }
  }, [betsQuery.data]);

  // Refresh personal bets after a crash, initial synchronization, or a new
  // connected round. Primitive dependencies keep ticks from reloading the list.
  useEffect(() => {
    const connected = stream.synchronized && stream.upstream === 'connected';
    if (!connected || roundId === null) return;
    const shouldRefresh = shouldRefreshBetsForSnapshot(
      previousConnectedBetRound.current,
      { roundId, phase },
      connected,
    );
    previousConnectedBetRound.current = roundId;
    if (shouldRefresh) void loadBets();
  }, [stream.synchronized, stream.upstream, phase, roundId, loadBets]);

  // Pending credits are confirmed by the operator; poll slowly while visible.
  useEffect(() => {
    if (bets === null) return;
    const awaitingCredit = bets.filter(
      (item) => item.bet !== null && item.bet.settlementStatus === 'pending',
    );
    if (awaitingCredit.length === 0 || settlementPolls >= MAX_SETTLEMENT_POLLS) return;
    const timer = setTimeout(() => {
      setSettlementPolls((count) => count + 1);
      void (async () => {
        for (const item of awaitingCredit) {
          if (item.betId === null) continue;
          try {
            const fresh = await betLookups.bet(item.betId);
            if (fresh === null) continue;
            if (fresh.bet?.settlementStatus === 'confirmed') onWalletChanged();
            queryClient.setQueryData<BetCommandResult[]>(queryKeys.bets(playerId, BETS_LIMIT), (current) =>
              current?.map((bet) => (bet.commandId === fresh.commandId ? fresh : bet)),
            );
          } catch (error) {
            if (isUnauthenticated(error)) {
              onUnauthorized();
              return;
            }
          }
        }
      })();
    }, SETTLEMENT_POLL_MS);
    return () => clearTimeout(timer);
  }, [bets, settlementPolls, api, token, playerId, queryClient, onUnauthorized, onWalletChanged]);

  // Provably-fair proof for the last finished round: recomputed locally, never
  // taken from the operator's word.
  const revealed = stream.lastRevealed;
  const { proof, retry: retryProof } = useRoundProof(revealed);
  const commitmentHash = snapshot?.serverSeedHash ?? null;

  const roundBets = roundId === null ? [] : (bets ?? []).filter((item) => item.roundId === roundId);
  const conflictingBet =
    roundBets.find((item) => item.betCommandStatus !== 'rejected') ?? null;
  const activeBet =
    roundBets.find((item) => item.bet?.engineStatus === 'active' && item.betCommandStatus === 'accepted') ??
    null;

  // The engine can cash a bet out on its own (auto-cashout) while the round
  // keeps running. The operator records that from the credit webhook, so the
  // list read below is enough — no engine reconcile is triggered from here.
  const polledActiveBetId = activeBet?.betId ?? null;
  const activeBetPollRef = useRef<{ roundId: string | null; count: number }>({
    roundId: null,
    count: 0,
  });

  useEffect(() => {
    if (stale || phase !== 'running' || roundId === null || polledActiveBetId === null) return;
    if (activeBetPollRef.current.roundId !== roundId) {
      activeBetPollRef.current = { roundId, count: 0 };
    }
    if (activeBetPollRef.current.count >= MAX_ACTIVE_BET_POLLS) return;

    const timer = setTimeout(() => {
      activeBetPollRef.current = {
        roundId,
        count: activeBetPollRef.current.count + 1,
      };
      // `loadBets` re-reads the balance when a bet stops being active, which is
      // how an engine auto-cashout reaches the header without a manual refresh.
      void loadBets();
    }, ACTIVE_BET_POLL_MS);
    return () => clearTimeout(timer);
  }, [stale, phase, roundId, polledActiveBetId, bets, loadBets]);

  const liveMultiplierHundredths = snapshot?.multiplier === null || snapshot?.multiplier === undefined
    ? null
    : Math.round(snapshot.multiplier * 100);
  const commandFlow = useGameCommandFlow({
    roundId, phase, stale, activeBet, conflictingBet, liveMultiplierHundredths,
    betsQuery, gameCommands, betLookups, afterMutation, onUnauthorized,
  });
  const {
    amountText, setAmountText, autoCashoutText, setAutoCashoutText,
    amountError, autoCashoutError, busy, pending, pendingDialogOpen, dismissPendingDialog, feedback, setFeedback,
    canBet, canCashout, cashoutLabel, reconcile, submitBet, submitCashout,
  } = commandFlow;

  const autoCashoutReached = !stale && phase === 'running' && activeBet?.betId !== null &&
    activeBet?.autoCashoutHundredths !== null && activeBet?.autoCashoutHundredths !== undefined &&
    liveMultiplierHundredths !== null && liveMultiplierHundredths >= activeBet.autoCashoutHundredths;

  // Open an in-progress modal as soon as the live multiplier reaches the
  // configured target. The result shown in it still comes from the operator.
  useEffect(() => {
    if (!autoCashoutReached || activeBet?.betId == null || triggeredAutoCashoutBetRef.current === activeBet.betId) return;
    triggeredAutoCashoutBetRef.current = activeBet.betId;
    setAutoCashout({ betId: activeBet.betId, command: null });
    void loadBets();
  }, [autoCashoutReached, activeBet?.betId, loadBets]);

  useEffect(() => {
    if (bets === null) return;
    for (const item of bets) {
      const previousStatus = previousBetStatusesRef.current.get(item.commandId);
      const currentStatus = item.bet?.engineStatus ?? 'unknown';
      const manualCashoutInFlight = pending?.type === 'cashout' && pending.betId === item.betId;
      const cashoutDialogAlreadyShown = feedback?.kind === 'cashout' || feedback?.kind === 'cashout-error';
      const closedAtAutoTarget = item.autoCashoutHundredths !== null &&
        item.bet?.multiplierHundredths !== null && item.bet?.multiplierHundredths !== undefined &&
        item.bet.multiplierHundredths >= item.autoCashoutHundredths;
      if (
        previousStatus === 'active' && currentStatus === 'cashed_out' &&
        closedAtAutoTarget && !manualCashoutInFlight && !cashoutDialogAlreadyShown
      ) setAutoCashout({ betId: item.betId ?? item.commandId, command: item });
      if (currentStatus === 'cashed_out' && autoCashout?.betId === item.betId) {
        setAutoCashout((current) => current?.betId === item.betId ? { ...current, command: item } : current);
      }
      previousBetStatusesRef.current.set(item.commandId, currentStatus);
    }
  }, [bets, pending, feedback, autoCashout?.betId]);


  return {
    round: {
      stream, stale, session, retrySession: () => setSessionAttempt((count) => count + 1),
      phase, roundId, snapshot, multiplierText, staleAlertVisible,
    },
    feedback: { value: feedback, dismiss: () => setFeedback(null) },
    autoCashout: {
      value: autoCashout === null ? null : { status: autoCashout.command === null ? 'checking' as const : 'confirmed' as const, command: autoCashout.command },
      dismiss: () => setAutoCashout(null),
    },
    betCommand: {
      amountText, setAmountText, autoCashoutText, setAutoCashoutText,
      amountError, autoCashoutError, busy, pending, pendingDialogOpen, dismissPendingDialog,
      canBet, canCashout, cashoutLabel,
      submitBet, submitCashout, reconcile,
    },
    bets: {
      items: bets, error: betsError, liveMultiplierHundredths,
      checkingBetIds, failedBetVerifications, load: loadBets, refreshOne: refreshBet,
      conflictingBet,
    },
    proof: { revealed, result: proof, commitmentHash, retry: retryProof },
  };
}
