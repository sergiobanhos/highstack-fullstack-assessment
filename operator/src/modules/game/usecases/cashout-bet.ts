import type { BetCommandResult, CashoutCommandInput } from '../game.contracts';
import type { StoredCommand } from './command-persistence';
import { and, eq, inArray } from 'drizzle-orm';
import type { OperatorDatabase } from '../../../db';
import type { CrashsimHttpClient } from '../../../integrations/crashsim/http.client';
import { CrashsimHttpError } from '../../../integrations/crashsim/http.client';
import { gameBets, gameCommands, type GameEngineBetStatus } from '../game.schema';
import type { BetToPersist } from './place-bet';
import { commandProjection } from './command-persistence';
import { createHash } from 'node:crypto';
import { GameCommandError } from '../game.errors';
import type { Logger } from '../../../config';
import type { OperatorSnapshot } from '../realtime/round-state';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ENGINE_ID_PATTERN = /^[A-Za-z0-9_-]{1,255}$/;

export interface CashoutBetUseCaseDeps {
  requests: Map<string, Promise<BetCommandResult | null>>;
  run(input: CashoutCommandInput): Promise<BetCommandResult | null>;
}

type OwnedBet = typeof gameBets.$inferSelect;

export interface CashoutMutationDeps {
  db: OperatorDatabase;
  engine: Pick<CrashsimHttpClient, 'cashout' | 'getBet'>;
  logger: Logger;
  settlementFor(playerId: string, bet: BetToPersist): Promise<'not_applicable' | 'pending' | 'confirmed' | 'precision_incident'>;
  resultForCommand(command: StoredCommand): Promise<BetCommandResult>;
  persistUnknown(command: StoredCommand, betId: string | null, resultCode: string): Promise<BetCommandResult>;
}

function safeNumber(value: bigint | null): number | null {
  if (value === null) return null;
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) ? numeric : null;
}

/** Persists cashout outcomes and resolves unknown outcomes using read-only GET. */
export function createCashoutMutationHandlers(deps: CashoutMutationDeps) {
  const { db, engine, logger, settlementFor, resultForCommand, persistUnknown } = deps;

  async function persistOutcome(
    command: StoredCommand,
    commandStatus: 'accepted' | 'rejected',
    resultCode: string | null,
    currentBet?: BetToPersist,
  ): Promise<BetCommandResult> {
    const settlementStatus = currentBet ? await settlementFor(command.playerId, currentBet) : undefined;
    try {
      const persisted = await db.transaction(async (tx) => {
        const [latest] = await tx.select(commandProjection).from(gameCommands)
          .where(eq(gameCommands.id, command.id)).for('update');
        if (!latest) return undefined;
        if (latest.status !== 'pending' && latest.status !== 'unknown') return latest;
        if (currentBet && latest.betId) {
          const refreshableStatuses: GameEngineBetStatus[] = currentBet.status === 'active'
            ? ['active'] : currentBet.status === 'lost' ? ['active', 'lost'] : ['active', 'cashed_out'];
          await tx.update(gameBets).set({
            engineStatus: currentBet.status,
            multiplierHundredths: currentBet.multiplierHundredths === null ? null : BigInt(currentBet.multiplierHundredths),
            payoutCents: currentBet.payoutCents === null ? null : BigInt(currentBet.payoutCents),
            settlementStatus: settlementStatus ?? 'not_applicable',
            updatedAt: new Date(),
          }).where(and(
            eq(gameBets.betId, latest.betId),
            eq(gameBets.playerId, latest.playerId),
            inArray(gameBets.engineStatus, refreshableStatuses),
          ));
        }
        await tx.update(gameCommands).set({
          status: commandStatus, resultCode, resolvedAt: new Date(), updatedAt: new Date(),
        }).where(eq(gameCommands.id, command.id));
        const [updated] = await tx.select(commandProjection).from(gameCommands).where(eq(gameCommands.id, command.id));
        return updated;
      });
      if (!persisted) return persistUnknown(command, command.betId, 'storage_unavailable');
      if (persisted.status === 'accepted') logger.info('game.cashout.confirmed', {
        commandId: persisted.id, betId: persisted.betId, roundId: command.roundId,
      });
      else if (persisted.status === 'rejected') logger.info('game.cashout.rejected', {
        commandId: persisted.id, betId: persisted.betId, reason: persisted.resultCode,
      });
      return resultForCommand(persisted);
    } catch {
      logger.error('game.cashout.outcome_persistence_failed', { commandId: command.id, category: commandStatus });
      return persistUnknown(command, command.betId, 'cashout_result_persistence_failed');
    }
  }

  async function reconcile(command: StoredCommand, activeResultCode = 'cashout_not_applied'): Promise<BetCommandResult> {
    if (!command.betId) return persistUnknown(command, null, 'cashout_bet_missing');
    let bet: OwnedBet | undefined;
    try {
      [bet] = await db.select().from(gameBets).where(and(
        eq(gameBets.betId, command.betId), eq(gameBets.playerId, command.playerId),
      )).limit(1);
    } catch {
      throw new GameCommandError('SERVICE_UNAVAILABLE');
    }
    if (!bet) return persistUnknown(command, command.betId, 'cashout_bet_missing');
    let current;
    try {
      current = await engine.getBet({ betId: bet.betId, playerId: command.playerId, roundId: bet.roundId });
    } catch (error) {
      if (error instanceof CrashsimHttpError && error.kind === 'not_found') return persistOutcome(command, 'rejected', 'bet_not_found');
      logger.warn('game.cashout.reconciliation_incomplete', { commandId: command.id, stage: 'engine_lookup' });
      return persistUnknown(command, command.betId, 'engine_unavailable');
    }
    if (current.betId !== bet.betId || current.playerId !== command.playerId || current.roundId !== bet.roundId ||
        current.amount !== safeNumber(bet.amountCents)) return persistUnknown(command, command.betId, 'bet_identity_mismatch');
    if (current.status === 'cashed_out') return persistOutcome(command, 'accepted', null, {
      betId: current.betId,
      status: current.status,
      multiplierHundredths: current.multiplierHundredths,
      payoutCents: current.payoutCents,
      payoutPrecision: current.payoutPrecision,
    });
    if (current.status === 'active') return persistOutcome(command, 'rejected', activeResultCode, {
      betId: current.betId, status: current.status, multiplierHundredths: null, payoutCents: null, payoutPrecision: 'not_provided',
    });
    if (current.status === 'lost') return persistOutcome(command, 'rejected', 'bet_not_active', {
      betId: current.betId, status: current.status, multiplierHundredths: null, payoutCents: null, payoutPrecision: 'not_provided',
    });
    return persistOutcome(command, 'rejected', 'bet_not_active');
  }

  async function post(command: StoredCommand, bet: OwnedBet): Promise<BetCommandResult> {
    try {
      const result = await engine.cashout({ betId: bet.betId, playerId: command.playerId, roundId: bet.roundId });
      return persistOutcome(command, 'accepted', null, result);
    } catch (error) {
      const rejectionCode = error instanceof CrashsimHttpError
        ? error.engineCode === 'bet_not_active' || error.engineCode === 'round_not_running'
          ? error.engineCode
          : error.kind === 'not_found' ? 'bet_not_found'
            : error.kind === 'rejected' || error.kind === 'conflict' ? 'cashout_rejected' : 'cashout_not_applied'
        : 'cashout_not_applied';
      return reconcile(command, rejectionCode);
    }
  }

  return { persistOutcome, reconcile, post };
}

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
