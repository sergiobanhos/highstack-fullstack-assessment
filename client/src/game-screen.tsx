import { useCallback, useEffect, useReducer, useState } from 'react';
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
  Table,
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
  type EngineBetStatus,
  type OperatorApi,
  type SettlementStatus,
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
import {
  initialStreamState,
  isSnapshotStale,
  MAX_RETAINED_EVENTS,
  parseOperatorFrame,
  streamReducer,
  type DownstreamConnection,
  type UpstreamConnection,
} from './operator-events.client';

const STREAM_URL = '/game/events';
const STREAM_EVENTS = ['snapshot', 'game-event', 'connection'] as const;
const BETS_LIMIT = 10;
/** Bounded read-only reconciliation attempts after an unknown command outcome. */
const RECONCILE_DELAYS_MS = [1000, 2000, 4000] as const;
const SETTLEMENT_POLL_MS = 5000;
const MAX_SETTLEMENT_POLLS = 12;

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
  onUnauthorized(): void;
  onWalletChanged(): void;
}

const PHASE_LABELS: Record<string, string> = {
  betting: 'Apostas abertas',
  running: 'Rodada em andamento',
  crashed: 'Crashou',
};

const PHASE_COLORS: Record<string, string> = {
  betting: 'teal',
  running: 'blue',
  crashed: 'red',
};

const UPSTREAM_LABELS: Record<UpstreamConnection, string> = {
  connected: 'engine conectado',
  reconnecting: 'engine reconectando',
  synchronizing: 'engine sincronizando',
};

const DOWNSTREAM_LABELS: Record<DownstreamConnection, string> = {
  connecting: 'stream conectando',
  open: 'stream aberto',
  error: 'stream com erro',
};

const COMMAND_STATUS_LABELS: Record<BetCommandStatus, string> = {
  pending: 'Pendente',
  accepted: 'Aceita',
  rejected: 'Recusada',
  unknown: 'Em confirmação',
};

const COMMAND_STATUS_COLORS: Record<BetCommandStatus, string> = {
  pending: 'gray',
  accepted: 'teal',
  rejected: 'red',
  unknown: 'yellow',
};

const ENGINE_STATUS_LABELS: Record<EngineBetStatus, string> = {
  active: 'Em andamento',
  lost: 'Perdida',
  cashed_out: 'Cashout',
};

const SETTLEMENT_LABELS: Record<SettlementStatus, string> = {
  not_applicable: '—',
  pending: 'Crédito pendente',
  confirmed: 'Creditado',
  precision_incident: 'Divergência registrada',
};

const RESULT_CODE_MESSAGES: Record<string, string> = {
  insufficient_funds: 'Saldo insuficiente no engine para essa aposta.',
  engine_unavailable: 'O engine ficou indisponível; nenhuma aposta nova foi confirmada.',
  debit_applied_engine_rejected: 'O engine recusou a aposta e o valor será devolvido à carteira.',
  betting_closed: 'A rodada já não aceitava mais apostas.',
  bet_not_found: 'A aposta não foi encontrada no engine.',
  bet_not_active: 'A aposta não está mais ativa no engine.',
  round_not_running: 'A rodada já não estava em andamento.',
  session_not_found: 'A sessão com o engine expirou.',
  accepted_bet_missing: 'O engine confirmou o débito mas a aposta não apareceu; o valor será devolvido.',
  unsafe_stored_amount: 'O valor registrado não pôde ser usado com segurança; nada foi debitado.',
};

function describeBetResult(resultCode: string | null): string {
  if (resultCode === null) return 'O operador recusou a operação.';
  return RESULT_CODE_MESSAGES[resultCode] ?? `O operador recusou a operação (${resultCode}).`;
}

function ProofBadge({ check, label }: { check: ProofCheck; label: string }): React.JSX.Element {
  const color = check === 'match' ? 'teal' : check === 'mismatch' ? 'red' : 'gray';
  const text = check === 'match' ? 'confere' : check === 'mismatch' ? 'divergência' : 'indisponível';
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
        return 'Saldo insuficiente para essa aposta. Adicione saldo na carteira.';
      case 'ROUND_NOT_ACCEPTING_BETS':
        return 'A rodada não aceita mais apostas.';
      case 'BET_ALREADY_EXISTS':
        return 'Você já tem uma aposta nesta rodada.';
      case 'BET_OUTCOME_UNKNOWN':
        return 'Sua aposta anterior nesta rodada ainda está sendo confirmada.';
      case 'GAME_NOT_SYNCHRONIZED':
        return 'A conexão do operador com o engine ainda não está sincronizada.';
      case 'ROUND_NOT_RUNNING':
        return 'A rodada não está mais em andamento.';
      case 'BET_NOT_ACTIVE':
        return 'A aposta não está mais ativa para cashout.';
      case 'BET_NOT_FOUND':
        return 'A aposta não foi encontrada.';
      case 'IDEMPOTENCY_KEY_REUSED':
        return 'Esta solicitação conflita com uma operação anterior. Consulte suas apostas.';
      case 'SERVICE_UNAVAILABLE':
        return 'O operador está indisponível no momento.';
      case 'RATE_LIMITED':
        return 'Muitas tentativas em pouco tempo. Aguarde e tente novamente.';
      default:
        return error.message;
    }
  }
  return 'Não foi possível falar com o operador. Verifique a conexão.';
}

export function GameScreen({
  api,
  token,
  onUnauthorized,
  onWalletChanged,
}: GameScreenProps): React.JSX.Element {
  const [stream, dispatch] = useReducer(streamReducer, initialStreamState);
  const [session, setSession] = useState<'connecting' | 'ready' | 'unavailable'>('connecting');
  const [sessionAttempt, setSessionAttempt] = useState(0);
  const [bets, setBets] = useState<BetCommandResult[] | null>(null);
  const [betsError, setBetsError] = useState<string | null>(null);
  const [amountText, setAmountText] = useState('');
  const [autoCashoutText, setAutoCashoutText] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingGameCommand | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [settlementPolls, setSettlementPolls] = useState(0);

  const stale = isSnapshotStale(stream);
  const snapshot = stream.snapshot;
  const phase = snapshot?.state ?? null;
  const roundId = snapshot?.roundId ?? null;
  const multiplierText =
    snapshot?.multiplier !== null && snapshot?.multiplier !== undefined
      ? `${snapshot.multiplier.toFixed(2)}x`
      : '—';

  const loadBets = useCallback(async (): Promise<void> => {
    try {
      const list = await api.listBets(token, BETS_LIMIT);
      setBets(list);
      setBetsError(null);
    } catch (error) {
      if (isUnauthenticated(error)) {
        onUnauthorized();
        return;
      }
      setBetsError(describeGameError(error));
    }
  }, [api, token, onUnauthorized]);

  const afterMutation = useCallback(async (): Promise<void> => {
    setSettlementPolls(0);
    await loadBets();
    onWalletChanged();
  }, [loadBets, onWalletChanged]);

  // The operator stream is the only source of round state; it is opened while
  // the game view is mounted and closed on leave.
  useEffect(() => {
    const source = new EventSource(STREAM_URL);
    source.onopen = () => dispatch({ type: 'downstream-open' });
    source.onerror = () => dispatch({ type: 'downstream-error' });
    const receive = (message: Event): void => {
      const action = parseOperatorFrame((message as MessageEvent<string>).data);
      if (action) dispatch(action);
    };
    for (const eventName of STREAM_EVENTS) source.addEventListener(eventName, receive);
    return () => {
      for (const eventName of STREAM_EVENTS) source.removeEventListener(eventName, receive);
      source.close();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setSession('connecting');
    void (async () => {
      try {
        await api.createSession(token);
        if (!cancelled) setSession('ready');
      } catch (error) {
        if (cancelled) return;
        if (isUnauthenticated(error)) {
          onUnauthorized();
          return;
        }
        setSession('unavailable');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, token, onUnauthorized, sessionAttempt]);

  useEffect(() => {
    void loadBets();
  }, [loadBets]);

  // Round transitions invalidate the personal view of bets: refresh on crash.
  useEffect(() => {
    if (phase === 'crashed' && roundId !== null) void loadBets();
  }, [phase, roundId, loadBets]);

  const reconcile = useCallback(
    async (command: PendingGameCommand): Promise<void> => {
      try {
        let result: BetCommandResult | null = null;
        if (command.commandId !== null) {
          result = await api.getCommand(token, command.commandId);
        } else if (command.type === 'cashout' && command.betId !== null) {
          result = await api.getBet(token, command.betId);
        } else {
          const list = await api.listBets(token, BETS_LIMIT);
          setBets(list);
          result = list.find((item) => item.roundId === command.roundId) ?? null;
        }

        if (result === null) {
          setPending((current) =>
            current === null
              ? null
              : { ...current, attempts: current.attempts + 1, note: 'Ainda não há confirmação do operador para esta operação.' },
          );
          return;
        }

        if (result.betCommandStatus === 'accepted') {
          setPending(null);
          setFeedback({
            color: 'green',
            text: command.type === 'bet'
              ? 'Aposta confirmada pelo operador.'
              : 'Cashout confirmado pelo operador.',
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
            : { ...current, attempts: current.attempts + 1, note: 'O operador ainda está resolvendo esta operação.' },
        );
      } catch (error) {
        if (isUnauthenticated(error)) {
          onUnauthorized();
          return;
        }
        setPending((current) =>
          current === null
            ? null
            : { ...current, attempts: current.attempts + 1, note: 'Não foi possível consultar o operador agora.' },
        );
      }
    },
    [api, token, onUnauthorized, afterMutation],
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
            const fresh = await api.getBet(token, item.betId);
            if (fresh === null) continue;
            if (fresh.bet?.settlementStatus === 'confirmed') onWalletChanged();
            setBets((current) =>
              current === null
                ? current
                : current.map((bet) => (bet.commandId === fresh.commandId ? fresh : bet)),
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
  }, [bets, settlementPolls, api, token, onUnauthorized, onWalletChanged]);

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
      const outcome = await api.placeBet(token, {
        roundId: command.roundId,
        amountCents: command.amountCents,
        autoCashoutHundredths: command.autoCashoutHundredths,
        idempotencyKey: command.idempotencyKey,
      });
      if (outcome.kind === 'accepted') {
        setAmountText('');
        setAutoCashoutText('');
        setFeedback({ color: 'green', text: `Aposta de ${formatCents(command.amountCents)} aceita.` });
        await afterMutation();
      } else if (outcome.kind === 'unknown') {
        setPending({
          ...command,
          commandId: outcome.command?.commandId ?? null,
          note: 'O operador ainda está confirmando esta aposta. Não envie uma nova aposta nesta rodada.',
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
        note: 'A resposta não chegou. Não enviamos uma nova aposta: confirme antes de tentar de novo.',
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
      const outcome = await api.cashout(token, {
        betId,
        idempotencyKey: command.idempotencyKey,
      });
      if (outcome.kind === 'accepted') {
        setFeedback({ color: 'green', text: 'Cashout aceito. O crédito é confirmado pelo operador.' });
        await afterMutation();
      } else if (outcome.kind === 'unknown') {
        setPending({
          ...command,
          commandId: outcome.command?.commandId ?? null,
          note: 'O operador ainda está confirmando este cashout.',
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
        note: 'A resposta não chegou. Não enviamos um novo cashout: confirme antes de tentar de novo.',
      });
      await afterMutation();
    } finally {
      setBusy(false);
    }
  };

  const refreshBet = async (betId: string): Promise<void> => {
    try {
      const fresh = await api.getBet(token, betId);
      if (fresh === null) return;
      setBets((current) =>
        current === null
          ? current
          : current.map((bet) => (bet.commandId === fresh.commandId ? fresh : bet)),
      );
      if (fresh.bet?.settlementStatus === 'confirmed') onWalletChanged();
    } catch (error) {
      if (isUnauthenticated(error)) onUnauthorized();
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
                {phase === null ? 'Aguardando estado' : (PHASE_LABELS[phase] ?? phase)}
              </Badge>
              {stale && <Badge color="yellow">Reconectando — estado congelado</Badge>}
            </Group>
            <Title order={1} mt="xs" aria-live="polite">
              {multiplierText}
            </Title>
            <Text size="sm" c="dimmed">
              Rodada {roundId ?? '—'} · seq {snapshot?.seq ?? '—'}
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

      {stale && (
        <Alert color="yellow" title="Estado não sincronizado">
          A última atualização recebida está congelada e apostas/cashouts ficam bloqueados até o
          operador voltar a sincronizar o estado da rodada.
        </Alert>
      )}

      {session === 'unavailable' && (
        <Alert color="yellow" title="Sessão de jogo indisponível">
          <Group justify="space-between">
            <Text size="sm">Não foi possível preparar sua sessão com o engine agora.</Text>
            <Button size="xs" variant="light" onClick={() => setSessionAttempt((count) => count + 1)}>
              Tentar novamente
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
        <Alert color="yellow" title={pending.type === 'bet' ? 'Aposta em confirmação' : 'Cashout em confirmação'}>
          <Stack gap="xs">
            <Text size="sm">
              {pending.note} Operação mantida com a mesma chave de idempotência
              {pending.amountCents > 0 ? ` (${formatCents(pending.amountCents)})` : ''}.
            </Text>
            <Group>
              <Button size="xs" variant="light" onClick={() => void reconcile(pending)}>
                Consultar novamente
              </Button>
            </Group>
          </Stack>
        </Alert>
      )}

      <Paper withBorder p="md" radius="md">
        <Title order={4}>Aposta</Title>
        <Stack gap="sm" mt="sm">
          <Group align="flex-end" wrap="wrap">
            <TextInput
              label="Valor (USD)"
              placeholder="10.00"
              inputMode="decimal"
              w={160}
              value={amountText}
              error={amountError}
              disabled={pending !== null || busy}
              onChange={(event) => setAmountText(event.currentTarget.value)}
            />
            <TextInput
              label="Auto-cashout (opcional)"
              placeholder="1.50"
              inputMode="decimal"
              w={200}
              value={autoCashoutText}
              error={autoCashoutError}
              disabled={pending !== null || busy}
              onChange={(event) => setAutoCashoutText(event.currentTarget.value)}
            />
            <Button onClick={() => void submitBet()} loading={busy} disabled={!canBet}>
              Apostar
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
              ? `Nesta rodada você já tem uma aposta (${COMMAND_STATUS_LABELS[conflictingBet.betCommandStatus]}).`
              : phase === 'betting'
                ? 'Aposte enquanto as apostas estão abertas.'
                : 'Aguarde a próxima janela de apostas.'}
          </Text>
        </Stack>
      </Paper>

      <Paper withBorder p="md" radius="md">
        <Group justify="space-between">
          <Title order={4}>Suas apostas recentes</Title>
          <Button size="xs" variant="default" onClick={() => void loadBets()}>
            Atualizar
          </Button>
        </Group>
        {betsError !== null && (
          <Alert color="red" mt="sm">
            {betsError}
          </Alert>
        )}
        <Table mt="sm" striped withTableBorder highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Rodada</Table.Th>
              <Table.Th>Valor</Table.Th>
              <Table.Th>Comando</Table.Th>
              <Table.Th>Jogo</Table.Th>
              <Table.Th>Resultado</Table.Th>
              <Table.Th>Liquidação</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {bets === null || bets.length === 0 ? (
              <Table.Tr>
                <Table.Td colSpan={7}>
                  <Text size="sm" c="dimmed">
                    {bets === null ? 'Carregando…' : 'Nenhuma aposta registrada ainda.'}
                  </Text>
                </Table.Td>
              </Table.Tr>
            ) : (
              bets.map((item) => {
                const settlementBetId = item.bet?.betId ?? null;
                const multiplier =
                  item.bet?.payoutCents !== null && item.bet?.payoutCents !== undefined
                    ? formatCents(item.bet.payoutCents)
                    : item.bet?.multiplierHundredths !== null &&
                        item.bet?.multiplierHundredths !== undefined
                      ? formatMultiplier(item.bet.multiplierHundredths)
                      : '—';
                return (
                  <Table.Tr key={item.commandId}>
                    <Table.Td>
                      <Text size="sm" ff="monospace">
                        {item.roundId.slice(0, 8)}…
                      </Text>
                    </Table.Td>
                    <Table.Td>{formatCents(item.amountCents)}</Table.Td>
                    <Table.Td>
                      <Badge color={COMMAND_STATUS_COLORS[item.betCommandStatus]} variant="light">
                        {COMMAND_STATUS_LABELS[item.betCommandStatus]}
                      </Badge>
                      {item.resultCode !== null && (
                        <Text size="xs" c="dimmed">
                          {item.resultCode}
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td>
                      {item.bet === null ? '—' : ENGINE_STATUS_LABELS[item.bet.engineStatus]}
                    </Table.Td>
                    <Table.Td>{multiplier}</Table.Td>
                    <Table.Td>
                      {item.bet === null ? '—' : SETTLEMENT_LABELS[item.bet.settlementStatus]}
                    </Table.Td>
                    <Table.Td>
                      {item.bet?.settlementStatus === 'pending' && settlementBetId !== null && (
                        <Button
                          size="compact-xs"
                          variant="light"
                          onClick={() => void refreshBet(settlementBetId)}
                        >
                          Verificar crédito
                        </Button>
                      )}
                    </Table.Td>
                  </Table.Tr>
                );
              })
            )}
          </Table.Tbody>
        </Table>
      </Paper>

      <Accordion variant="contained">
        <Accordion.Item value="fairness">
          <Accordion.Control>Prova da rodada (provably fair)</Accordion.Control>
          <Accordion.Panel>
            <Stack gap="xs">
              <Text size="xs" c="dimmed">
                O operador publica o compromisso SHA-256 do seed antes da rodada e revela o seed ao
                final. A verificação recalcula o ponto de crash aqui no navegador, com o mesmo
                algoritmo do engine, sem confiar no servidor.
              </Text>
              <Group gap="xs">
                <Text size="sm" fw={500}>
                  Compromisso da rodada atual:
                </Text>
                <Text size="xs" ff="monospace" title={commitmentHash ?? undefined}>
                  {commitmentHash === null ? '—' : `${commitmentHash.slice(0, 16)}…`}
                </Text>
              </Group>
              <Divider />
              {revealed === null ? (
                <Text size="sm" c="dimmed">
                  Nenhuma rodada finalizada desde que esta tela foi aberta.
                </Text>
              ) : (
                <Stack gap="xs">
                  <Group gap="xs">
                    <Text size="sm">
                      Última rodada finalizada:{' '}
                      <Text span ff="monospace" size="sm">
                        {revealed.roundId.slice(0, 8)}…
                      </Text>
                    </Text>
                    <Badge variant="light">{revealed.crashPoint.toFixed(2)}x</Badge>
                    {proof?.status === 'checking' && <Loader size="xs" />}
                    {proof?.status === 'failed' && (
                      <Badge color="yellow" variant="light">
                        não foi possível verificar
                      </Badge>
                    )}
                  </Group>
                  {proof?.status === 'done' && proof.result !== null && (
                    <Group gap="xs">
                      <ProofBadge check={proof.result.commitment} label="Compromisso" />
                      <ProofBadge check={proof.result.result} label="Resultado" />
                      {proof.result.reproducedHundredths !== null && (
                        <Text size="xs" c="dimmed">
                          recalculado: {formatMultiplier(proof.result.reproducedHundredths)}
                        </Text>
                      )}
                    </Group>
                  )}
                  {proof?.status === 'done' &&
                    proof.result !== null &&
                    (proof.result.commitment === 'mismatch' || proof.result.result === 'mismatch') && (
                      <Alert color="red" title="Divergência na prova da rodada">
                        O resultado recalculado não confere com o exibido. Guarde o roundId e evite
                        apostar até entender a diferença.
                      </Alert>
                    )}
                  {revealed.serverSeedHash === null && (
                    <Text size="xs" c="dimmed">
                      O compromisso desta rodada não foi capturado nesta sessão; só o resultado pôde
                      ser recalculado.
                    </Text>
                  )}
                  <div>
                    <Text size="sm">Seed revelado:</Text>
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
                      Verificar novamente
                    </Button>
                  </Group>
                </Stack>
              )}
            </Stack>
          </Accordion.Panel>
        </Accordion.Item>
        <Accordion.Item value="diagnostics">
          <Accordion.Control>Diagnóstico da conexão</Accordion.Control>
          <Accordion.Panel>
            <Stack gap="xs">
              <Text size="xs" c="dimmed">
                Rodada {roundId ?? '—'} · seq {snapshot?.seq ?? '—'} · eventos retidos{' '}
                {stream.events.length}/{MAX_RETAINED_EVENTS}
              </Text>
              <Divider />
              <Code block mah={200} style={{ overflow: 'auto' }}>
                {stream.events.length === 0
                  ? 'nenhum evento recebido'
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
