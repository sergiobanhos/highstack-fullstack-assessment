import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Accordion,
  Alert,
  Badge,
  Button,
  Code,
  Divider,
  Group,
  Loader,
  Paper,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import {
  createIdempotencyKey,
  isUnauthenticated,
  OperatorApiError,
  type BetCommandResult,
  type BetCommandStatus,
  type OperatorApi,
} from './operator-api';
import {
  formatCents,
  formatCentsInput,
  formatMultiplier,
  MAX_BET_CENTS,
  parseMultiplierToHundredths,
  parseUsdToCents,
  projectPayoutCents,
} from './money';
import { verifyRound, type ProofCheck, type RoundProof } from './fairness';
import { isBetOutcomePending, shouldRefreshBetsForSnapshot } from './bet-status';
import { usePlayerBetLookups, usePlayerBets, usePlayerGameCommands, usePlayerGameSession } from './hooks/use-game-data';
import { useGameStream } from './hooks/use-game-stream';
import { queryKeys } from './query-keys';
import { RecentBetsTable } from './components/recent-bets-table';
import { MAX_RETAINED_EVENTS, type DownstreamConnection, type UpstreamConnection } from './operator-events.client';

const BETS_LIMIT = 10;
/** Bounded read-only reconciliation attempts after an unknown command outcome. */
const RECONCILE_DELAYS_MS = [1000, 2000, 4000] as const;
const SETTLEMENT_POLL_MS = 5000;
const MAX_SETTLEMENT_POLLS = 12;
/** Grace period before a reconnect blip becomes a full warning in the UI. */
const STALE_ALERT_DELAY_MS = 2000;
/** Engine auto-cashouts are only visible to the operator through an engine read. */
const ACTIVE_BET_POLL_MS = 3000;
const MAX_ACTIVE_BET_POLLS = 40;

interface PendingGameCommand {
  type: 'bet' | 'cashout';
  idempotencyKey: string;
  roundId: string;
  amountCents: number;
  autoCashoutHundredths: number | null;
  betId: string | null;
  commandId: string | null;
  attempts: number;
  note: string;
}

interface Feedback {
  color: 'green' | 'red' | 'yellow';
  text: string;
}

export interface GameScreenProps {
  api: OperatorApi;
  token: string;
  playerId: string;
  onUnauthorized(): void;
  onWalletChanged(): void;
}

const PHASE_LABELS: Record<string, string> = {
  betting: 'Betting open',
  running: 'Round running',
  crashed: 'Crashed',
};

const PHASE_COLORS: Record<string, string> = {
  betting: 'teal',
  running: 'blue',
  crashed: 'red',
};

const UPSTREAM_LABELS: Record<UpstreamConnection, string> = {
  connected: 'engine connected',
  reconnecting: 'engine reconnecting',
  synchronizing: 'engine syncing',
};

const DOWNSTREAM_LABELS: Record<DownstreamConnection, string> = {
  connecting: 'stream connecting',
  open: 'stream open',
  error: 'stream error',
};

const COMMAND_STATUS_LABELS: Record<BetCommandStatus, string> = {
  pending: 'Pending',
  accepted: 'Accepted',
  rejected: 'Rejected',
  unknown: 'Confirming',
};

const RESULT_CODE_MESSAGES: Record<string, string> = {
  insufficient_funds: 'The engine reported insufficient funds for this bet.',
  engine_unavailable: 'The engine became unavailable; no new bet was confirmed.',
  debit_applied_engine_rejected: 'The engine rejected the bet and the amount will be returned to the wallet.',
  betting_closed: 'The round was no longer accepting bets.',
  bet_not_found: 'The bet was not found in the engine.',
  bet_not_active: 'The bet is no longer active in the engine.',
  round_not_running: 'The round was no longer running.',
  session_not_found: 'The engine session expired.',
  accepted_bet_missing: 'The engine confirmed the debit but the bet is missing; the amount will be returned.',
  unsafe_stored_amount: 'The stored amount could not be used safely; nothing was debited.',
};

function describeBetResult(resultCode: string | null): string {
  if (resultCode === null) return 'The operator refused the operation.';
  return RESULT_CODE_MESSAGES[resultCode] ?? `The operator refused the operation (${resultCode}).`;
}

function ProofBadge({ check, label }: { check: ProofCheck; label: string }): React.JSX.Element {
  const color = check === 'match' ? 'teal' : check === 'mismatch' ? 'red' : 'gray';
  const text = check === 'match' ? 'matches' : check === 'mismatch' ? 'mismatch' : 'unavailable';
  return (
    <Badge color={color} variant="light">
      {label}: {text}
    </Badge>
  );
}

export function describeGameError(error: unknown): string {
  if (error instanceof OperatorApiError) {
    switch (error.code) {
      case 'INSUFFICIENT_FUNDS':
        return 'Insufficient balance for this bet. Add balance in your wallet.';
      case 'ROUND_NOT_ACCEPTING_BETS':
        return 'The round is no longer accepting bets.';
      case 'BET_ALREADY_EXISTS':
        return 'You already have a bet in this round.';
      case 'BET_OUTCOME_UNKNOWN':
        return 'Your previous bet in this round is still being confirmed.';
      case 'GAME_NOT_SYNCHRONIZED':
        return 'The operator is not yet synchronized with the engine.';
      case 'ROUND_NOT_RUNNING':
        return 'The round is no longer running.';
      case 'BET_NOT_ACTIVE':
        return 'The bet is no longer active for cashout.';
      case 'BET_NOT_FOUND':
        return 'The bet was not found.';
      case 'IDEMPOTENCY_KEY_REUSED':
        return 'This request conflicts with an earlier operation. Check your bets.';
      case 'SERVICE_UNAVAILABLE':
        return 'The operator is currently unavailable.';
      case 'RATE_LIMITED':
        return 'Too many attempts in a short time. Wait and try again.';
      default:
        return error.message;
    }
  }
  return 'Could not reach the operator. Check your connection.';
}

export function GameScreen({
  api,
  token,
  playerId,
  onUnauthorized,
  onWalletChanged,
}: GameScreenProps): React.JSX.Element {
  const queryClient = useQueryClient();
  const playerContext = { api, token, playerId, onUnauthorized };
  const { stream, stale } = useGameStream();
  const [sessionAttempt, setSessionAttempt] = useState(0);
  const [betsError, setBetsError] = useState<string | null>(null);
  const [amountText, setAmountText] = useState('');
  const [autoCashoutText, setAutoCashoutText] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingGameCommand | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [settlementPolls, setSettlementPolls] = useState(0);
  const [staleAlertVisible, setStaleAlertVisible] = useState(false);
  const lastBetsRef = useRef<BetCommandResult[] | null>(null);
  const [checkingBetIds, setCheckingBetIds] = useState<Set<string>>(() => new Set());
  const [failedBetVerifications, setFailedBetVerifications] = useState<Set<string>>(() => new Set());
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

  const reconcile = useCallback(
    async (command: PendingGameCommand): Promise<void> => {
      try {
        let result: BetCommandResult | null = null;
        if (command.commandId !== null) {
          result = await betLookups.command(command.commandId);
        } else if (command.type === 'cashout' && command.betId !== null) {
          result = await betLookups.bet(command.betId);
        } else {
          const response = await betsQuery.refetch();
          if (response.error) throw response.error;
          const list = response.data ?? [];
          result = list.find((item) => item.roundId === command.roundId) ?? null;
        }

        if (result === null) {
          setPending((current) =>
            current === null
              ? null
              : { ...current, attempts: current.attempts + 1, note: 'The operator has not confirmed this operation yet.' },
          );
          return;
        }

        if (result.betCommandStatus === 'accepted') {
          setPending(null);
          setFeedback({
            color: 'green',
            text: command.type === 'bet'
              ? 'Bet confirmed by the operator.'
              : 'Cashout confirmed by the operator.',
          });
          await afterMutation();
          return;
        }
        if (result.betCommandStatus === 'rejected') {
          setPending(null);
          setFeedback({ color: 'red', text: describeBetResult(result.resultCode) });
          await afterMutation();
          return;
        }
        setPending((current) =>
          current === null
            ? null
            : { ...current, attempts: current.attempts + 1, note: 'The operator is still resolving this operation.' },
        );
      } catch (error) {
        if (isUnauthenticated(error)) {
          onUnauthorized();
          return;
        }
        setPending((current) =>
          current === null
            ? null
            : { ...current, attempts: current.attempts + 1, note: 'Could not reach the operator right now.' },
        );
      }
  },
    [betsQuery.refetch, betLookups, onUnauthorized, afterMutation],
  );

  // Bounded, read-only reconciliation: never resend with a fresh key.
  useEffect(() => {
    if (pending === null || pending.attempts >= RECONCILE_DELAYS_MS.length) return;
    const timer = setTimeout(() => {
      void reconcile(pending);
    }, RECONCILE_DELAYS_MS[pending.attempts]);
    return () => clearTimeout(timer);
  }, [pending, reconcile]);

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
  const [proof, setProof] = useState<{
    roundId: string;
    status: 'checking' | 'done' | 'failed';
    result: RoundProof | null;
  } | null>(null);
  const [proofAttempt, setProofAttempt] = useState(0);
  const commitmentHash = snapshot?.serverSeedHash ?? null;

  useEffect(() => {
    if (revealed === null) return;
    let cancelled = false;
    setProof({ roundId: revealed.roundId, status: 'checking', result: null });
    void verifyRound({
      roundId: revealed.roundId,
      serverSeed: revealed.serverSeed,
      serverSeedHash: revealed.serverSeedHash,
      crashPoint: revealed.crashPoint,
    })
      .then((result) => {
        if (!cancelled) setProof({ roundId: revealed.roundId, status: 'done', result });
      })
      .catch(() => {
        if (!cancelled) setProof({ roundId: revealed.roundId, status: 'failed', result: null });
      });
    return () => {
      cancelled = true;
    };
  }, [revealed, proofAttempt]);

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

  const parsedAmount = amountText.trim().length === 0
    ? null
    : parseUsdToCents(amountText, { maxCents: MAX_BET_CENTS });
  const parsedAutoCashout = autoCashoutText.trim().length === 0
    ? null
    : parseMultiplierToHundredths(autoCashoutText);

  const canBet =
    !stale &&
    phase === 'betting' &&
    roundId !== null &&
    pending === null &&
    !busy &&
    conflictingBet === null &&
    parsedAmount !== null &&
    parsedAmount.ok &&
    (parsedAutoCashout === null || parsedAutoCashout.ok);

  const canCashout = !stale && phase === 'running' && activeBet !== null && pending === null && !busy;

  // Prediction only, mirroring the engine formula; the operator still decides
  // the credited amount when the cashout is confirmed.
  const liveMultiplierHundredths =
    snapshot?.multiplier === null || snapshot?.multiplier === undefined
      ? null
      : Math.round(snapshot.multiplier * 100);
  const predictedPayoutCents =
    activeBet !== null && liveMultiplierHundredths !== null
      ? projectPayoutCents(activeBet.amountCents, liveMultiplierHundredths)
      : null;
  const cashoutLabel =
    predictedPayoutCents === null
      ? 'Cashout'
      : `Cashout (USD ${formatCentsInput(predictedPayoutCents)})`;

  // The engine cashes the bet out the instant the multiplier reaches the
  // target, and the operator records it from the credit webhook. Crossing the
  // target is therefore the moment to re-read the list instead of waiting for
  // the next cadence tick — the row still only changes when the operator says so.
  const crossedAutoCashout =
    activeBet !== null &&
    activeBet.autoCashoutHundredths !== null &&
    liveMultiplierHundredths !== null &&
    liveMultiplierHundredths >= activeBet.autoCashoutHundredths;
  const crossedBetId = crossedAutoCashout ? (activeBet?.betId ?? null) : null;
  const crossedReadRef = useRef<string | null>(null);
  useEffect(() => {
    if (crossedBetId === null || crossedReadRef.current === crossedBetId) return;
    crossedReadRef.current = crossedBetId;
    void loadBets();
  }, [crossedBetId, loadBets]);

  const submitBet = async (): Promise<void> => {
    if (roundId === null || parsedAmount === null || !parsedAmount.ok) return;
    if (parsedAutoCashout !== null && !parsedAutoCashout.ok) return;
    const command: PendingGameCommand = {
      type: 'bet',
      idempotencyKey: createIdempotencyKey(),
      roundId,
      amountCents: parsedAmount.value,
      autoCashoutHundredths: parsedAutoCashout === null ? null : parsedAutoCashout.value,
      betId: null,
      commandId: null,
      attempts: 0,
      note: '',
    };

    setBusy(true);
    setFeedback(null);
    try {
      const outcome = await gameCommands.placeBet.mutateAsync({
        roundId: command.roundId,
        amountCents: command.amountCents,
        autoCashoutHundredths: command.autoCashoutHundredths,
        idempotencyKey: command.idempotencyKey,
      });
      if (outcome.kind === 'accepted') {
        setAmountText('');
        setAutoCashoutText('');
        setFeedback({ color: 'green', text: `Bet of ${formatCents(command.amountCents)} accepted.` });
        await afterMutation();
      } else if (outcome.kind === 'unknown') {
        setPending({
          ...command,
          commandId: outcome.command?.commandId ?? null,
          note: 'The operator is still confirming this bet. Do not place another bet in this round.',
        });
        await afterMutation();
      } else {
        setFeedback({
          color: 'red',
          text: describeBetResult(outcome.command?.resultCode ?? null),
        });
        await afterMutation();
      }
    } catch (error) {
      if (isUnauthenticated(error)) {
        onUnauthorized();
        return;
      }
      // No response reached us: the command may exist server-side. Keep the
      // same key and reconcile by reading before any retry.
      setPending({
        ...command,
        commandId: null,
        note: 'The response never arrived. No new bet was sent: confirm before trying again.',
      });
      await afterMutation();
    } finally {
      setBusy(false);
    }
  };

  const submitCashout = async (): Promise<void> => {
    if (activeBet === null || activeBet.betId === null) return;
    const betId = activeBet.betId;
    const command: PendingGameCommand = {
      type: 'cashout',
      idempotencyKey: createIdempotencyKey(),
      roundId: activeBet.roundId,
      amountCents: activeBet.amountCents,
      autoCashoutHundredths: null,
      betId,
      commandId: null,
      attempts: 0,
      note: '',
    };

    setBusy(true);
    setFeedback(null);
    try {
      const outcome = await gameCommands.cashout.mutateAsync({
        betId,
        idempotencyKey: command.idempotencyKey,
      });
      if (outcome.kind === 'accepted') {
        setFeedback({ color: 'green', text: 'Cashout accepted. The credit is confirmed by the operator.' });
        await afterMutation();
      } else if (outcome.kind === 'unknown') {
        setPending({
          ...command,
          commandId: outcome.command?.commandId ?? null,
          note: 'The operator is still confirming this cashout.',
        });
        await afterMutation();
      } else {
        setFeedback({
          color: 'red',
          text: describeBetResult(outcome.command?.resultCode ?? null),
        });
        await afterMutation();
      }
    } catch (error) {
      if (isUnauthenticated(error)) {
        onUnauthorized();
        return;
      }
      setPending({
        ...command,
        commandId: null,
        note: 'The response never arrived. No new cashout was sent: confirm before trying again.',
      });
      await afterMutation();
    } finally {
      setBusy(false);
    }
  };

  const amountError =
    parsedAmount !== null && !parsedAmount.ok ? parsedAmount.message : null;
  const autoCashoutError =
    parsedAutoCashout !== null && !parsedAutoCashout.ok ? parsedAutoCashout.message : null;

  return (
    <Stack gap="md">
      <Paper withBorder p="md" radius="md">
        <Group justify="space-between" align="flex-start" wrap="wrap">
          <div>
            <Group gap="xs">
              <Badge size="lg" color={phase === null ? 'gray' : (PHASE_COLORS[phase] ?? 'gray')}>
                {phase === null ? 'Waiting for state' : (PHASE_LABELS[phase] ?? phase)}
              </Badge>
              {stale && <Badge color="yellow">Reconnecting — frozen state</Badge>}
            </Group>
            <Title order={1} mt="xs" aria-live="polite">
              {multiplierText}
            </Title>
            <Text size="sm" c="dimmed">
              Round {roundId ?? '—'} · seq {snapshot?.seq ?? '—'}
            </Text>
          </div>
          <Stack gap={4} miw={220}>
            <Badge variant="light" color={stream.upstream === 'connected' ? 'teal' : 'yellow'} fullWidth>
              {UPSTREAM_LABELS[stream.upstream]}
            </Badge>
            <Badge
              variant="light"
              color={stream.downstream === 'open' ? 'teal' : stream.downstream === 'connecting' ? 'gray' : 'yellow'}
              fullWidth
            >
              {DOWNSTREAM_LABELS[stream.downstream]}
            </Badge>
          </Stack>
        </Group>
      </Paper>

      {stale && staleAlertVisible && (
        <Alert color="yellow" title="State not synchronized">
          The last update received is frozen and bets/cashouts stay blocked until the
          operator synchronizes the round state again.
        </Alert>
      )}

      {session === 'unavailable' && (
        <Alert color="yellow" title="Game session unavailable">
          <Group justify="space-between">
            <Text size="sm">Could not prepare your engine session right now.</Text>
            <Button size="xs" variant="light" onClick={() => setSessionAttempt((count) => count + 1)}>
              Try again
            </Button>
          </Group>
        </Alert>
      )}

      {feedback !== null && (
        <Alert color={feedback.color} withCloseButton onClose={() => setFeedback(null)}>
          {feedback.text}
        </Alert>
      )}

      {pending !== null && (
        <Alert color="yellow" title={pending.type === 'bet' ? 'Bet awaiting confirmation' : 'Cashout awaiting confirmation'}>
          <Stack gap="xs">
            <Text size="sm">
              {pending.note} The operation keeps the same idempotency key
              {pending.amountCents > 0 ? ` (${formatCents(pending.amountCents)})` : ''}.
            </Text>
            <Group>
              <Button size="xs" variant="light" onClick={() => void reconcile(pending)}>
                Check again
              </Button>
            </Group>
          </Stack>
        </Alert>
      )}

      <Paper withBorder p="md" radius="md">
        <Title order={4}>Bet</Title>
        <Stack gap="sm" mt="sm">
          <Group align="flex-end" wrap="wrap">
            <TextInput
              label="Amount (USD)"
              placeholder="10.00"
              inputMode="decimal"
              w={160}
              value={amountText}
              error={amountError}
              disabled={pending !== null || busy}
              onChange={(event) => setAmountText(event.currentTarget.value)}
            />
            <TextInput
              label="Auto-cashout (optional)"
              placeholder="1.50"
              inputMode="decimal"
              w={200}
              value={autoCashoutText}
              error={autoCashoutError}
              disabled={pending !== null || busy}
              onChange={(event) => setAutoCashoutText(event.currentTarget.value)}
            />
            <Button onClick={() => void submitBet()} loading={busy} disabled={!canBet}>
              Place bet
            </Button>
            <Button
              variant="light"
              color="orange"
              miw={190}
              onClick={() => void submitCashout()}
              loading={busy}
              disabled={!canCashout}
            >
              {cashoutLabel}
            </Button>
          </Group>
          <Text size="sm" c="dimmed">
            {conflictingBet !== null
              ? `You already have a bet in this round (${COMMAND_STATUS_LABELS[conflictingBet.betCommandStatus]}).`
              : phase === 'betting'
                ? 'Place your bet while betting is open.'
                : 'Wait for the next betting window.'}
          </Text>
        </Stack>
      </Paper>

      <RecentBetsTable
        bets={bets}
        error={betsError}
        roundId={roundId}
        phase={phase}
        liveMultiplierHundredths={liveMultiplierHundredths}
        checkingBetIds={checkingBetIds}
        failedBetVerifications={failedBetVerifications}
        onRefresh={() => void loadBets()}
        onRefreshBet={(betId) => void refreshBet(betId)}
      />

      <Accordion variant="contained">
        <Accordion.Item value="fairness">
          <Accordion.Control>Round proof (provably fair)</Accordion.Control>
          <Accordion.Panel>
            <Stack gap="xs">
              <Text size="xs" c="dimmed">
                The operator publishes the SHA-256 commitment of the seed before the round and reveals it
                after the crash. The verification recomputes the crash point in this browser, with the same
                engine algorithm, without trusting the server.
              </Text>
              <Group gap="xs">
                <Text size="sm" fw={500}>
                  Current round commitment:
                </Text>
                <Text size="xs" ff="monospace" title={commitmentHash ?? undefined}>
                  {commitmentHash === null ? '—' : `${commitmentHash.slice(0, 16)}…`}
                </Text>
              </Group>
              <Divider />
              {revealed === null ? (
                <Text size="sm" c="dimmed">
                  No round has finished since this screen was opened.
                </Text>
              ) : (
                <Stack gap="xs">
                  <Group gap="xs">
                    <Text size="sm">
                      Last finished round:{' '}
                      <Text span ff="monospace" size="sm">
                        {revealed.roundId.slice(0, 8)}…
                      </Text>
                    </Text>
                    <Badge variant="light">{revealed.crashPoint.toFixed(2)}x</Badge>
                    {proof?.status === 'checking' && <Loader size="xs" />}
                    {proof?.status === 'failed' && (
                      <Badge color="yellow" variant="light">
                        verification failed
                      </Badge>
                    )}
                  </Group>
                  {proof?.status === 'done' && proof.result !== null && (
                    <Group gap="xs">
                      <ProofBadge check={proof.result.commitment} label="Commitment" />
                      <ProofBadge check={proof.result.result} label="Result" />
                      {proof.result.reproducedHundredths !== null && (
                        <Text size="xs" c="dimmed">
                          recomputed: {formatMultiplier(proof.result.reproducedHundredths)}
                        </Text>
                      )}
                    </Group>
                  )}
                  {proof?.status === 'done' &&
                    proof.result !== null &&
                    (proof.result.commitment === 'mismatch' || proof.result.result === 'mismatch') && (
                      <Alert color="red" title="Round proof mismatch">
                        The recomputed result does not match what was displayed. Save the round id
                        and avoid betting until the difference is understood.
                        <Code block mt="xs" style={{ wordBreak: 'break-all' }}>
                          {revealed.roundId}
                        </Code>
                      </Alert>
                    )}
                  {revealed.serverSeedHash === null && (
                    <Text size="xs" c="dimmed">
                      This round commitment was not captured in this session; only the result could
                      be recomputed.
                    </Text>
                  )}
                  <div>
                    <Text size="sm">Revealed seed:</Text>
                    <Code block style={{ wordBreak: 'break-all' }}>
                      {revealed.serverSeed}
                    </Code>
                  </div>
                  <Group>
                    <Button
                      size="compact-xs"
                      variant="default"
                      onClick={() => setProofAttempt((count) => count + 1)}
                    >
                      Verify again
                    </Button>
                  </Group>
                </Stack>
              )}
            </Stack>
          </Accordion.Panel>
        </Accordion.Item>
        <Accordion.Item value="diagnostics">
          <Accordion.Control>Connection diagnostics</Accordion.Control>
          <Accordion.Panel>
            <Stack gap="xs">
              <Text size="xs" c="dimmed">
                Round {roundId ?? '—'} · seq {snapshot?.seq ?? '—'} · eventos retidos{' '}
                {stream.events.length}/{MAX_RETAINED_EVENTS}
              </Text>
              <Divider />
              <Code block mah={200} style={{ overflow: 'auto' }}>
                {stream.events.length === 0
                  ? 'no events received'
                  : stream.events
                      .map((event) => `#${event.seq} ${event.type} ${event.roundId}`)
                      .join('\n')}
              </Code>
            </Stack>
          </Accordion.Panel>
        </Accordion.Item>
      </Accordion>
    </Stack>
  );
}
