import { useCallback, useEffect, useState } from 'react';
import type { BetCommandResult } from '../../../lib/operator/operator-api';
import { createIdempotencyKey, isUnauthenticated } from '../../../lib/operator/operator-api';
import { formatCents, formatCentsInput, MAX_BET_CENTS, parseMultiplierToHundredths, parseUsdToCents, projectPayoutCents } from '../../../lib/money/money';
import { usePlayerBetLookups, usePlayerBets, usePlayerGameCommands } from './use-game-data';

const RECONCILE_DELAYS_MS = [1000, 2000, 4000] as const;

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

export interface GameCommandFeedback {
  color: 'green' | 'red' | 'yellow';
  text: string;
}

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

interface UseGameCommandFlowOptions {
  roundId: string | null;
  phase: string | null;
  stale: boolean;
  activeBet: BetCommandResult | null;
  conflictingBet: BetCommandResult | null;
  liveMultiplierHundredths: number | null;
  betsQuery: ReturnType<typeof usePlayerBets>;
  gameCommands: ReturnType<typeof usePlayerGameCommands>;
  betLookups: ReturnType<typeof usePlayerBetLookups>;
  afterMutation(): Promise<void>;
  onUnauthorized(): void;
}

export function useGameCommandFlow({
  roundId, phase, stale, activeBet, conflictingBet, liveMultiplierHundredths,
  betsQuery, gameCommands, betLookups, afterMutation, onUnauthorized,
}: UseGameCommandFlowOptions) {
  const [amountText, setAmountText] = useState('');
  const [autoCashoutText, setAutoCashoutText] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingGameCommand | null>(null);
  const [feedback, setFeedback] = useState<GameCommandFeedback | null>(null);
  const parsedAmount = amountText.trim().length === 0 ? null : parseUsdToCents(amountText, { maxCents: MAX_BET_CENTS });
  const parsedAutoCashout = autoCashoutText.trim().length === 0 ? null : parseMultiplierToHundredths(autoCashoutText);
  const amountError = parsedAmount !== null && !parsedAmount.ok ? parsedAmount.message : null;
  const autoCashoutError = parsedAutoCashout !== null && !parsedAutoCashout.ok ? parsedAutoCashout.message : null;
  const canBet = !stale && phase === 'betting' && roundId !== null && pending === null && !busy &&
    conflictingBet === null && parsedAmount !== null && parsedAmount.ok &&
    (parsedAutoCashout === null || parsedAutoCashout.ok);
  const canCashout = !stale && phase === 'running' && activeBet !== null && pending === null && !busy;
  const predictedPayoutCents = activeBet !== null && liveMultiplierHundredths !== null
    ? projectPayoutCents(activeBet.amountCents, liveMultiplierHundredths)
    : null;
  const cashoutLabel = predictedPayoutCents === null ? 'Cashout' : `Cashout (USD ${formatCentsInput(predictedPayoutCents)})`;

  const reconcile = useCallback(async (command: PendingGameCommand): Promise<void> => {
    try {
      let result: BetCommandResult | null = null;
      if (command.commandId !== null) result = await betLookups.command(command.commandId);
      else if (command.type === 'cashout' && command.betId !== null) result = await betLookups.bet(command.betId);
      else {
        const response = await betsQuery.refetch();
        if (response.error) throw response.error;
        result = (response.data ?? []).find((item) => item.roundId === command.roundId) ?? null;
      }
      if (result === null) {
        setPending((current) => current === null ? null : { ...current, attempts: current.attempts + 1, note: 'The operator has not confirmed this operation yet.' });
        return;
      }
      if (result.betCommandStatus === 'accepted') {
        setPending(null);
        setFeedback({ color: 'green', text: command.type === 'bet' ? 'Bet confirmed by the operator.' : 'Cashout confirmed by the operator.' });
        await afterMutation();
        return;
      }
      if (result.betCommandStatus === 'rejected') {
        setPending(null);
        setFeedback({ color: 'red', text: describeBetResult(result.resultCode) });
        await afterMutation();
        return;
      }
      setPending((current) => current === null ? null : { ...current, attempts: current.attempts + 1, note: 'The operator is still resolving this operation.' });
    } catch (error) {
      if (isUnauthenticated(error)) { onUnauthorized(); return; }
      setPending((current) => current === null ? null : { ...current, attempts: current.attempts + 1, note: 'Could not reach the operator right now.' });
    }
  }, [betsQuery.refetch, betLookups, onUnauthorized, afterMutation]);

  useEffect(() => {
    if (pending === null || pending.attempts >= RECONCILE_DELAYS_MS.length) return;
    const timer = setTimeout(() => { void reconcile(pending); }, RECONCILE_DELAYS_MS[pending.attempts]);
    return () => clearTimeout(timer);
  }, [pending, reconcile]);

  const submitBet = async (): Promise<void> => {
    if (roundId === null || parsedAmount === null || !parsedAmount.ok) return;
    if (parsedAutoCashout !== null && !parsedAutoCashout.ok) return;
    const command: PendingGameCommand = {
      type: 'bet', idempotencyKey: createIdempotencyKey(), roundId,
      amountCents: parsedAmount.value,
      autoCashoutHundredths: parsedAutoCashout === null ? null : parsedAutoCashout.value,
      betId: null, commandId: null, attempts: 0, note: '',
    };
    setBusy(true); setFeedback(null);
    try {
      const outcome = await gameCommands.placeBet.mutateAsync({
        roundId: command.roundId, amountCents: command.amountCents,
        autoCashoutHundredths: command.autoCashoutHundredths, idempotencyKey: command.idempotencyKey,
      });
      if (outcome.kind === 'accepted') {
        setAmountText(''); setAutoCashoutText('');
        setFeedback({ color: 'green', text: `Bet of ${formatCents(command.amountCents)} accepted.` });
        await afterMutation();
      } else if (outcome.kind === 'unknown') {
        setPending({ ...command, commandId: outcome.command?.commandId ?? null, note: 'The operator is still confirming this bet. Do not place another bet in this round.' });
        await afterMutation();
      } else {
        setFeedback({ color: 'red', text: describeBetResult(outcome.command?.resultCode ?? null) });
        await afterMutation();
      }
    } catch (error) {
      if (isUnauthenticated(error)) { onUnauthorized(); return; }
      // Keep the original idempotency key; reconcile by reading before any retry.
      setPending({ ...command, commandId: null, note: 'The response never arrived. No new bet was sent: confirm before trying again.' });
      await afterMutation();
    } finally { setBusy(false); }
  };

  const submitCashout = async (): Promise<void> => {
    if (activeBet === null || activeBet.betId === null) return;
    const betId = activeBet.betId;
    const command: PendingGameCommand = {
      type: 'cashout', idempotencyKey: createIdempotencyKey(), roundId: activeBet.roundId,
      amountCents: activeBet.amountCents, autoCashoutHundredths: null,
      betId, commandId: null, attempts: 0, note: '',
    };
    setBusy(true); setFeedback(null);
    try {
      const outcome = await gameCommands.cashout.mutateAsync({ betId, idempotencyKey: command.idempotencyKey });
      if (outcome.kind === 'accepted') {
        setFeedback({ color: 'green', text: 'Cashout accepted. The credit is confirmed by the operator.' });
        await afterMutation();
      } else if (outcome.kind === 'unknown') {
        setPending({ ...command, commandId: outcome.command?.commandId ?? null, note: 'The operator is still confirming this cashout.' });
        await afterMutation();
      } else {
        setFeedback({ color: 'red', text: describeBetResult(outcome.command?.resultCode ?? null) });
        await afterMutation();
      }
    } catch (error) {
      if (isUnauthenticated(error)) { onUnauthorized(); return; }
      setPending({ ...command, commandId: null, note: 'The response never arrived. No new cashout was sent: confirm before trying again.' });
      await afterMutation();
    } finally { setBusy(false); }
  };

  return {
    amountText, setAmountText, autoCashoutText, setAutoCashoutText,
    amountError, autoCashoutError, busy, pending, feedback, setFeedback,
    canBet, canCashout, cashoutLabel,
    reconcile, submitBet, submitCashout,
  };
}
