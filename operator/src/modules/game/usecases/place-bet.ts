import type { BetCommandResult, PlaceBetCommandInput } from '../game.contracts';
import type { StoredCommand } from './command-persistence';
import { createHash } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import type { Logger } from '../../../config';
import type { OperatorDatabase } from '../../../db';
import type { FinancialModule } from '../../financial/financial.module';
import { CrashsimHttpClient, CrashsimHttpError, type CrashsimBet } from '../../../integrations/crashsim/http.client';
import { gameBets, gameCommands, type GameEngineBetStatus, type GameSettlementStatus } from '../game.schema';
import { GameCommandError } from '../game.errors';
import { commandProjection } from './command-persistence';
import { unknownResult } from './command-outcomes';

export interface NormalizedBetInput {
  roundId: string;
  amountCents: number;
  autoCashoutHundredths: number | null;
  autoCashout: number | undefined;
  requestHash: string;
}

export interface BetToPersist {
  betId: string;
  status: GameEngineBetStatus;
  multiplierHundredths: number | null;
  payoutCents: number | null;
  payoutPrecision: 'not_provided' | 'safe' | 'unsafe';
}

export interface BetMutationDeps {
  db: OperatorDatabase;
  financial: Pick<FinancialModule, 'findBetDebitForCommand'>;
  engine: Pick<CrashsimHttpClient, 'placeBet' | 'getBet'>;
  logger: Logger;
  sessions: Map<string, string>;
  ensurePlayerSession(playerId: string): Promise<string>;
  resultForCommand(command: StoredCommand): Promise<BetCommandResult>;
  persistUnknown(command: StoredCommand, betId: string | null, resultCode: string): Promise<BetCommandResult>;
  settlementFor(playerId: string, bet: BetToPersist): Promise<GameSettlementStatus>;
}

function safeNumber(value: bigint | null): number | null {
  if (value === null) return null;
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) ? numeric : null;
}

/** Owns persistence and resolution for bets after the reservation exists. */
export function createBetMutationHandlers(deps: BetMutationDeps) {
  const { db, financial, engine, logger, sessions, ensurePlayerSession, resultForCommand, persistUnknown, settlementFor } = deps;

  async function persistRejected(command: StoredCommand, resultCode: string, betId: string | null = null): Promise<BetCommandResult> {
    try {
      const persisted = await db.transaction(async (tx) => {
        const [updated] = await tx.update(gameCommands).set({
          status: 'rejected', resultCode, betId, resolvedAt: new Date(), updatedAt: new Date(),
        }).where(and(eq(gameCommands.id, command.id), inArray(gameCommands.status, ['pending', 'unknown'])))
          .returning(commandProjection);
        if (updated) return updated;
        const [latest] = await tx.select(commandProjection).from(gameCommands)
          .where(eq(gameCommands.id, command.id)).for('update');
        return latest;
      });
      if (!persisted) return unknownResult(command, 'storage_unavailable', betId);
      if (persisted.status === 'rejected') logger.info('game.bet.rejected', {
        commandId: persisted.id, roundId: persisted.roundId, reason: persisted.resultCode ?? resultCode,
      });
      return resultForCommand(persisted);
    } catch {
      logger.error('game.bet.outcome_persistence_failed', { commandId: command.id, category: 'rejected' });
      return persistUnknown(command, betId, 'rejected_result_persistence_failed');
    }
  }

  async function persistAccepted(command: StoredCommand, bet: BetToPersist): Promise<BetCommandResult> {
    const settlementStatus = await settlementFor(command.playerId, bet);
    try {
      const persisted = await db.transaction(async (tx) => {
        const [latest] = await tx.select(commandProjection).from(gameCommands)
          .where(eq(gameCommands.id, command.id)).for('update');
        if (!latest) return undefined;
        if (latest.status !== 'pending' && latest.status !== 'unknown') return latest;
        await tx.update(gameCommands).set({
          status: 'accepted', resultCode: null, betId: bet.betId, resolvedAt: new Date(), updatedAt: new Date(),
        }).where(eq(gameCommands.id, command.id));
        await tx.insert(gameBets).values({
          betId: bet.betId,
          commandId: command.id,
          playerId: command.playerId,
          roundId: latest.roundId ?? command.roundId ?? '',
          amountCents: command.amountCents ?? 0n,
          autoCashoutHundredths: command.autoCashoutHundredths,
          engineStatus: bet.status,
          multiplierHundredths: bet.multiplierHundredths === null ? null : BigInt(bet.multiplierHundredths),
          payoutCents: bet.payoutCents === null ? null : BigInt(bet.payoutCents),
          settlementStatus,
        });
        const [updated] = await tx.select(commandProjection).from(gameCommands).where(eq(gameCommands.id, command.id));
        return updated;
      });
      if (!persisted) return unknownResult(command, 'storage_unavailable', bet.betId);
      if (persisted.status === 'accepted') logger.info('game.bet.accepted', {
        commandId: persisted.id, roundId: persisted.roundId, betId: bet.betId, engineStatus: bet.status,
      });
      return resultForCommand(persisted);
    } catch {
      logger.error('game.bet.outcome_persistence_failed', { commandId: command.id, category: 'accepted' });
      return persistUnknown(command, bet.betId, 'accepted_bet_persistence_failed');
    }
  }

  async function reconcileUnknown(command: StoredCommand): Promise<BetCommandResult> {
    let candidates;
    try {
      candidates = await financial.findBetDebitForCommand({
        playerId: command.playerId,
        roundId: command.roundId ?? '',
        amount: safeNumber(command.amountCents) ?? 0,
        createdAt: command.reservedAt,
      });
    } catch {
      logger.warn('game.bet.reconciliation_incomplete', { commandId: command.id, stage: 'financial_lookup' });
      return persistUnknown(command, null, 'financial_unavailable');
    }
    if (candidates.length !== 1) return persistUnknown(command, null, candidates.length === 0 ? 'debit_not_found' : 'debit_ambiguous');
    const candidate = candidates[0]!;
    if (command.betId !== null && command.betId !== candidate.betId) return persistUnknown(command, command.betId, 'bet_identity_mismatch');
    let engineBet: CrashsimBet;
    try {
      engineBet = await engine.getBet({ betId: candidate.betId, playerId: command.playerId, roundId: command.roundId ?? '' });
    } catch {
      logger.warn('game.bet.reconciliation_incomplete', { commandId: command.id, stage: 'engine_lookup' });
      return persistUnknown(command, candidate.betId, 'engine_unavailable');
    }
    const expectedAmount = safeNumber(command.amountCents);
    if (expectedAmount === null || engineBet.amount !== expectedAmount) return persistUnknown(command, candidate.betId, 'bet_identity_mismatch');
    if (candidate.outcome === 'insufficient_funds') {
      if (engineBet.status === 'rejected') return persistRejected(command, 'insufficient_funds', candidate.betId);
      return persistUnknown(command, candidate.betId, 'debit_outcome_mismatch');
    }
    if (engineBet.status === 'rejected') return persistRejected(command, 'debit_applied_engine_rejected', candidate.betId);
    return persistAccepted(command, {
      betId: engineBet.betId,
      status: engineBet.status,
      multiplierHundredths: engineBet.multiplierHundredths,
      payoutCents: engineBet.payoutCents,
      payoutPrecision: engineBet.payoutPrecision,
    });
  }

  function rejectedCode(error: CrashsimHttpError): string {
    if (error.engineCode === 'insufficient_funds') return 'insufficient_funds';
    if (error.engineCode === 'betting_closed') return 'betting_closed';
    return 'engine_rejected';
  }

  async function postBet(command: StoredCommand, sessionId: string, bet: NormalizedBetInput): Promise<BetCommandResult> {
    try {
      const created = await engine.placeBet({ sessionId, playerId: command.playerId, roundId: bet.roundId, amount: bet.amountCents, autoCashout: bet.autoCashout });
      return persistAccepted(command, { betId: created.betId, status: created.status, multiplierHundredths: null, payoutCents: null, payoutPrecision: 'not_provided' });
    } catch (error) {
      if (error instanceof CrashsimHttpError && error.kind === 'session_not_found') {
        if (sessions.get(command.playerId) === sessionId) sessions.delete(command.playerId);
        let refreshedSession: string;
        try { refreshedSession = await ensurePlayerSession(command.playerId); }
        catch { return persistRejected(command, 'engine_unavailable'); }
        try {
          const retried = await engine.placeBet({ sessionId: refreshedSession, playerId: command.playerId, roundId: bet.roundId, amount: bet.amountCents, autoCashout: bet.autoCashout });
          return persistAccepted(command, { betId: retried.betId, status: retried.status, multiplierHundredths: null, payoutCents: null, payoutPrecision: 'not_provided' });
        } catch (retryError) {
          if (retryError instanceof CrashsimHttpError && retryError.kind === 'session_not_found') return persistRejected(command, 'session_not_found');
          if (retryError instanceof CrashsimHttpError && (retryError.kind === 'rejected' || retryError.kind === 'conflict')) return persistRejected(command, rejectedCode(retryError));
          return reconcileUnknown(command);
        }
      }
      if (error instanceof CrashsimHttpError && (error.kind === 'rejected' || error.kind === 'conflict')) return persistRejected(command, rejectedCode(error));
      return reconcileUnknown(command);
    }
  }

  async function replayOrReconcile(command: StoredCommand, requestHash: string): Promise<BetCommandResult> {
    if (command.commandType !== 'bet' || command.requestHash !== requestHash) throw new GameCommandError('IDEMPOTENCY_KEY_REUSED');
    if (command.status === 'pending' || command.status === 'unknown') return reconcileUnknown(command);
    return resultForCommand(command);
  }

  return { postBet, reconcileUnknown, replayOrReconcile };
}

export interface PlaceBetUseCaseDeps {
  normalize(input: PlaceBetCommandInput): NormalizedBetInput;
  loadByIdempotencyKey(playerId: string, idempotencyKey: string): Promise<StoredCommand | undefined>;
  replayOrReconcile(command: StoredCommand, requestHash: string): Promise<BetCommandResult>;
  assertRoundAcceptingBets(roundId: string): void;
  ensurePlayerSession(playerId: string): Promise<string>;
  reserve(input: PlaceBetCommandInput, bet: NormalizedBetInput): Promise<{ command: StoredCommand; created: boolean }>;
  post(command: StoredCommand, sessionId: string, bet: NormalizedBetInput): Promise<BetCommandResult>;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BET_CENTS = 1_000_000_000;
const MIN_AUTO_CASHOUT_HUNDREDTHS = 101;
const MAX_AUTO_CASHOUT_HUNDREDTHS = 100_000_000;
const ENGINE_ID_PATTERN = /^[A-Za-z0-9_-]{1,255}$/;

export function normalizeBet(input: PlaceBetCommandInput): NormalizedBetInput {
  if (!input.roundId || input.roundId.length > 255 || !ENGINE_ID_PATTERN.test(input.roundId) ||
      !Number.isSafeInteger(input.amount) || input.amount < 1 || input.amount > MAX_BET_CENTS) {
    throw new GameCommandError('INVALID_BET');
  }
  let autoCashoutHundredths: number | null = null;
  let autoCashout: number | undefined;
  if (input.autoCashout !== undefined) {
    if (!Number.isFinite(input.autoCashout)) throw new GameCommandError('INVALID_BET');
    const hundredths = Math.round(input.autoCashout * 100);
    if (!Number.isSafeInteger(hundredths) || Math.abs(input.autoCashout * 100 - hundredths) >= 1e-7 ||
        hundredths < MIN_AUTO_CASHOUT_HUNDREDTHS || hundredths > MAX_AUTO_CASHOUT_HUNDREDTHS) {
      throw new GameCommandError('INVALID_BET');
    }
    autoCashoutHundredths = hundredths;
    autoCashout = hundredths / 100;
  }
  const canonicalInput = JSON.stringify({ commandType: 'bet', roundId: input.roundId, amountCents: input.amount, autoCashoutHundredths });
  return {
    roundId: input.roundId,
    amountCents: input.amount,
    autoCashoutHundredths,
    autoCashout,
    requestHash: createHash('sha256').update(canonicalInput).digest('hex'),
  };
}

/** Coordinates idempotent bet placement and checks synchronization around session setup. */
export function createPlaceBetUseCase(deps: PlaceBetUseCaseDeps) {
  return async (input: PlaceBetCommandInput): Promise<BetCommandResult> => {
    if (!UUID_PATTERN.test(input.idempotencyKey)) throw new GameCommandError('INVALID_IDEMPOTENCY_KEY');
    const bet = deps.normalize(input);
    const existing = await deps.loadByIdempotencyKey(input.playerId, input.idempotencyKey);
    if (existing) return deps.replayOrReconcile(existing, bet.requestHash);

    deps.assertRoundAcceptingBets(bet.roundId);
    let sessionId: string;
    try {
      sessionId = await deps.ensurePlayerSession(input.playerId);
    } catch {
      throw new GameCommandError('SERVICE_UNAVAILABLE');
    }
    deps.assertRoundAcceptingBets(bet.roundId);

    const reservation = await deps.reserve(input, bet);
    if (!reservation.created) return deps.replayOrReconcile(reservation.command, bet.requestHash);
    return deps.post(reservation.command, sessionId, bet);
  };
}
