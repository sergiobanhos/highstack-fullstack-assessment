import { createHash } from 'node:crypto';
import { GameCommandError } from '../game.errors';
import type { Logger } from '../../../config';
import type { BetCommandResult, CashoutCommandInput, StoredCommand } from './game-command-runtime';
import type { OperatorSnapshot } from '../realtime/round-state';
import type { gameBets } from '../game.schema';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ENGINE_ID_PATTERN = /^[A-Za-z0-9_-]{1,255}$/;

export interface CashoutBetUseCaseDeps {
  requests: Map<string, Promise<BetCommandResult | null>>;
  run(input: CashoutCommandInput): Promise<BetCommandResult | null>;
}

type OwnedBet = typeof gameBets.$inferSelect;

export interface RunCashoutBetDeps {
  loadByIdempotencyKey(playerId: string, key: string): Promise<StoredCommand | undefined>;
  assertMatchingCommand(command: StoredCommand, type: 'cashout', requestHash: string): void;
  reconcileCashout(command: StoredCommand): Promise<BetCommandResult>;
  cashoutInFlight: Map<string, Promise<BetCommandResult>>;
  loadOwnedBet(playerId: string, betId: string): Promise<OwnedBet | undefined>;
  getSnapshot(): OperatorSnapshot;
  reserve(input: CashoutCommandInput, requestHash: string, roundId: string): Promise<{ command: StoredCommand; created: boolean }>;
  resultForCommand(command: StoredCommand): Promise<BetCommandResult>;
  post(command: StoredCommand, bet: OwnedBet): Promise<BetCommandResult>;
  logger: Logger;
}

/** Applies ownership and round checks, reserves one cashout, and reconciles ambiguous outcomes. */
export function createRunCashoutBetUseCase(deps: RunCashoutBetDeps) {
  return async (input: CashoutCommandInput): Promise<BetCommandResult | null> => {
    const requestHash = createHash('sha256')
      .update(JSON.stringify({ commandType: 'cashout', betId: input.betId }))
      .digest('hex');
    const existing = await deps.loadByIdempotencyKey(input.playerId, input.idempotencyKey);
    if (existing) {
      deps.assertMatchingCommand(existing, 'cashout', requestHash);
      if (existing.status === 'pending' || existing.status === 'unknown') {
        return deps.cashoutInFlight.get(existing.id) ?? deps.reconcileCashout(existing);
      }
      return deps.resultForCommand(existing);
    }

    const bet = await deps.loadOwnedBet(input.playerId, input.betId);
    if (!bet) return null;

    const snapshot = deps.getSnapshot();
    if (snapshot.connection !== 'connected') throw new GameCommandError('GAME_NOT_SYNCHRONIZED');
    if (snapshot.state.state !== 'running' || snapshot.state.roundId !== bet.roundId) {
      throw new GameCommandError('ROUND_NOT_RUNNING');
    }
    if (bet.engineStatus !== 'active') throw new GameCommandError('BET_NOT_ACTIVE');

    const reservation = await deps.reserve(input, requestHash, bet.roundId);
    if (!reservation.created) {
      if (reservation.command.status === 'pending' || reservation.command.status === 'unknown') {
        return deps.cashoutInFlight.get(reservation.command.id) ?? deps.reconcileCashout(reservation.command);
      }
      return deps.resultForCommand(reservation.command);
    }

    const operation = deps.post(reservation.command, bet);
    deps.logger.info('game.cashout.requested', {
      commandId: reservation.command.id,
      betId: bet.betId,
      roundId: bet.roundId,
    });
    deps.cashoutInFlight.set(reservation.command.id, operation);
    try {
      return await operation;
    } finally {
      if (deps.cashoutInFlight.get(reservation.command.id) === operation) {
        deps.cashoutInFlight.delete(reservation.command.id);
      }
    }
  };
}

/** Validates and coalesces concurrent duplicate requests before running cashout reconciliation. */
export function createCashoutBetUseCase({ requests, run }: CashoutBetUseCaseDeps) {
  return async (input: CashoutCommandInput): Promise<BetCommandResult | null> => {
    if (!UUID_PATTERN.test(input.idempotencyKey)) throw new GameCommandError('INVALID_IDEMPOTENCY_KEY');
    if (!ENGINE_ID_PATTERN.test(input.betId)) throw new GameCommandError('INVALID_BET');
    const requestKey = `${input.playerId}:${input.idempotencyKey}`;
    const existing = requests.get(requestKey);
    if (existing) return existing;
    const operation = run(input);
    requests.set(requestKey, operation);
    try {
      return await operation;
    } finally {
      if (requests.get(requestKey) === operation) requests.delete(requestKey);
    }
  };
}
