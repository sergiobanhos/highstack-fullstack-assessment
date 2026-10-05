import { createHash } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Logger } from '../../config';
import type { OperatorDatabase } from '../../db';
import type { FinancialModule } from '../financial/financial.module';
import { CrashsimHttpClient, CrashsimHttpError, type CrashsimBet } from './crashsim-http.client';
import { gameBets, gameCommands, type GameCommandStatus, type GameEngineBetStatus, type GameSettlementStatus } from './game.schema';
import type { GameStreamService } from './game-stream.service';

const MAX_BET_CENTS = 1_000_000_000;
const MIN_AUTO_CASHOUT_HUNDREDTHS = 101;
const MAX_AUTO_CASHOUT_HUNDREDTHS = 100_000_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ENGINE_ID_PATTERN = /^[A-Za-z0-9_-]{1,255}$/;

export type GameCommandErrorCode =
  | 'INVALID_BET'
  | 'INVALID_IDEMPOTENCY_KEY'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'GAME_NOT_SYNCHRONIZED'
  | 'ROUND_NOT_ACCEPTING_BETS'
  | 'BET_ALREADY_EXISTS'
  | 'BET_OUTCOME_UNKNOWN'
  | 'INVALID_QUERY'
  | 'SERVICE_UNAVAILABLE';

const ERROR_MESSAGES: Record<GameCommandErrorCode, string> = {
  INVALID_BET: 'Bet request is invalid',
  INVALID_IDEMPOTENCY_KEY: 'Idempotency key is invalid',
  IDEMPOTENCY_KEY_REUSED: 'Idempotency key was already used for a different command',
  GAME_NOT_SYNCHRONIZED: 'Game is reconnecting and cannot accept commands',
  ROUND_NOT_ACCEPTING_BETS: 'The current round is not accepting bets',
  BET_ALREADY_EXISTS: 'A bet already exists for this player and round',
  BET_OUTCOME_UNKNOWN: 'A previous bet for this player and round is still being resolved',
  INVALID_QUERY: 'Game query is invalid',
  SERVICE_UNAVAILABLE: 'Game service is unavailable',
};

export class GameCommandError extends Error {
  constructor(readonly code: GameCommandErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'GameCommandError';
  }
}

export interface PlaceBetCommandInput {
  playerId: string;
  idempotencyKey: string;
  roundId: string;
  amount: number;
  autoCashout?: number;
}

export interface GameBetView {
  betId: string;
  engineStatus: GameEngineBetStatus;
  multiplierHundredths: number | null;
  payoutCents: number | null;
  settlementStatus: GameSettlementStatus;
}

export interface BetCommandResult {
  commandId: string;
  roundId: string;
  amountCents: number;
  autoCashoutHundredths: number | null;
  betCommandStatus: GameCommandStatus;
  resultCode: string | null;
  betId: string | null;
  bet: GameBetView | null;
}

export interface ListBetsInput {
  playerId: string;
  limit?: number;
}

export interface GetGameCommandInput {
  playerId: string;
  commandId: string;
}

export interface GetGameBetInput {
  playerId: string;
  betId: string;
}

export interface GameCommandService {
  createSession(playerId: string): Promise<{ status: 'ready' }>;
  placeBet(input: PlaceBetCommandInput): Promise<BetCommandResult>;
  listBets(input: ListBetsInput): Promise<BetCommandResult[]>;
  getCommand(input: GetGameCommandInput): Promise<BetCommandResult | null>;
  getBet(input: GetGameBetInput): Promise<BetCommandResult | null>;
}

export interface GameCommandServiceDeps {
  db: OperatorDatabase;
  financial: Pick<FinancialModule, 'ensureWallet' | 'findBetDebitForCommand' | 'getCashoutCreditStatus'>;
  engine: Pick<CrashsimHttpClient, 'createSession' | 'placeBet' | 'getBet'>;
  stream: Pick<GameStreamService, 'getSnapshot'>;
  logger: Logger;
}

const reservedAt = sql<string>`to_char(${gameCommands.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const commandProjection = {
  id: gameCommands.id,
  playerId: gameCommands.playerId,
  commandType: gameCommands.commandType,
  idempotencyKey: gameCommands.idempotencyKey,
  requestHash: gameCommands.requestHash,
  roundId: gameCommands.roundId,
  betId: gameCommands.betId,
  amountCents: gameCommands.amountCents,
  autoCashoutHundredths: gameCommands.autoCashoutHundredths,
  status: gameCommands.status,
  resultCode: gameCommands.resultCode,
  reservedAt,
};

type StoredCommand = {
  id: string;
  playerId: string;
  commandType: 'bet' | 'cashout';
  idempotencyKey: string;
  requestHash: string;
  roundId: string | null;
  betId: string | null;
  amountCents: bigint | null;
  autoCashoutHundredths: number | null;
  status: GameCommandStatus;
  resultCode: string | null;
  reservedAt: string;
};

type BetReservation = { command: StoredCommand; created: boolean };

interface NormalizedBet {
  roundId: string;
  amountCents: number;
  autoCashoutHundredths: number | null;
  autoCashout: number | undefined;
  requestHash: string;
}

interface BetToPersist {
  betId: string;
  status: GameEngineBetStatus;
  multiplierHundredths: number | null;
  payoutCents: number | null;
  payoutPrecision: 'not_provided' | 'safe' | 'unsafe';
}

function normalizeBet(input: PlaceBetCommandInput): NormalizedBet {
  if (!input.roundId || input.roundId.length > 255 || !ENGINE_ID_PATTERN.test(input.roundId) ||
      !Number.isSafeInteger(input.amount) || input.amount < 1 || input.amount > MAX_BET_CENTS) {
    throw new GameCommandError('INVALID_BET');
  }

  let autoCashoutHundredths: number | null = null;
  let autoCashout: number | undefined;
  if (input.autoCashout !== undefined) {
    if (!Number.isFinite(input.autoCashout)) throw new GameCommandError('INVALID_BET');
    const hundredths = Math.round(input.autoCashout * 100);
    if (!Number.isSafeInteger(hundredths) ||
        Math.abs(input.autoCashout * 100 - hundredths) >= 1e-7 ||
        hundredths < MIN_AUTO_CASHOUT_HUNDREDTHS ||
        hundredths > MAX_AUTO_CASHOUT_HUNDREDTHS) {
      throw new GameCommandError('INVALID_BET');
    }
    autoCashoutHundredths = hundredths;
    autoCashout = hundredths / 100;
  }

  const canonicalInput = JSON.stringify({
    commandType: 'bet',
    roundId: input.roundId,
    amountCents: input.amount,
    autoCashoutHundredths,
  });
  return {
    roundId: input.roundId,
    amountCents: input.amount,
    autoCashoutHundredths,
    autoCashout,
    requestHash: createHash('sha256').update(canonicalInput).digest('hex'),
  };
}

function safeNumber(value: bigint | null): number | null {
  if (value === null) return null;
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) ? numeric : null;
}

function unknownResult(command: StoredCommand, resultCode = 'outcome_unknown', betId = command.betId): BetCommandResult {
  return {
    commandId: command.id,
    roundId: command.roundId ?? '',
    amountCents: safeNumber(command.amountCents) ?? 0,
    autoCashoutHundredths: command.autoCashoutHundredths,
    betCommandStatus: 'unknown',
    resultCode,
    betId,
    bet: null,
  };
}

/** Coordinates the one Crashsim bet flow; session IDs remain process-local. */
export function createGameCommandService({ db, financial, engine, stream, logger }: GameCommandServiceDeps): GameCommandService {
  const sessions = new Map<string, string>();
  const sessionCreations = new Map<string, Promise<string>>();

  async function withStorageErrors<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof GameCommandError) throw error;
      throw new GameCommandError('SERVICE_UNAVAILABLE');
    }
  }

  async function createOrReuseSession(playerId: string): Promise<string> {
    const existing = sessions.get(playerId);
    if (existing) return existing;

    const inFlight = sessionCreations.get(playerId);
    if (inFlight) return inFlight;

    const creation = (async () => {
      try {
        await financial.ensureWallet(playerId);
        const session = await engine.createSession(playerId);
        sessions.set(playerId, session.sessionId);
        return session.sessionId;
      } catch {
        throw new GameCommandError('SERVICE_UNAVAILABLE');
      }
    })();
    sessionCreations.set(playerId, creation);
    try {
      return await creation;
    } finally {
      if (sessionCreations.get(playerId) === creation) sessionCreations.delete(playerId);
    }
  }

  function assertRoundAcceptingBets(roundId: string): void {
    const snapshot = stream.getSnapshot();
    if (snapshot.connection !== 'connected') throw new GameCommandError('GAME_NOT_SYNCHRONIZED');
    if (snapshot.state.state !== 'betting' || snapshot.state.roundId !== roundId) {
      throw new GameCommandError('ROUND_NOT_ACCEPTING_BETS');
    }
  }

  async function loadByIdempotencyKey(playerId: string, idempotencyKey: string): Promise<StoredCommand | undefined> {
    return withStorageErrors(async () => {
      const [command] = await db
        .select(commandProjection)
        .from(gameCommands)
        .where(and(
          eq(gameCommands.playerId, playerId),
          eq(gameCommands.idempotencyKey, idempotencyKey),
        ))
        .limit(1);
      return command;
    });
  }

  function assertMatchingCommand(command: StoredCommand, requestHash: string): void {
    if (command.commandType !== 'bet' || command.requestHash !== requestHash) {
      throw new GameCommandError('IDEMPOTENCY_KEY_REUSED');
    }
  }

  async function reserveBetCommand(
    input: PlaceBetCommandInput,
    bet: NormalizedBet,
  ): Promise<BetReservation> {
    return withStorageErrors(() => db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(gameCommands)
        .values({
          playerId: input.playerId,
          commandType: 'bet',
          idempotencyKey: input.idempotencyKey,
          requestHash: bet.requestHash,
          roundId: bet.roundId,
          amountCents: BigInt(bet.amountCents),
          autoCashoutHundredths: bet.autoCashoutHundredths,
          status: 'pending',
        })
        .onConflictDoNothing()
        .returning(commandProjection);

      if (inserted) return { command: inserted, created: true };

      const [sameKey] = await tx
        .select(commandProjection)
        .from(gameCommands)
        .where(and(
          eq(gameCommands.playerId, input.playerId),
          eq(gameCommands.idempotencyKey, input.idempotencyKey),
        ))
        .for('update');
      if (sameKey) {
        assertMatchingCommand(sameKey, bet.requestHash);
        return { command: sameKey, created: false };
      }

      const [roundSlot] = await tx
        .select(commandProjection)
        .from(gameCommands)
        .where(and(
          eq(gameCommands.playerId, input.playerId),
          eq(gameCommands.roundId, bet.roundId),
          eq(gameCommands.commandType, 'bet'),
          inArray(gameCommands.status, ['pending', 'unknown', 'accepted']),
        ))
        .for('update');
      if (roundSlot?.status === 'accepted') throw new GameCommandError('BET_ALREADY_EXISTS');
      if (roundSlot) throw new GameCommandError('BET_OUTCOME_UNKNOWN');
      throw new GameCommandError('SERVICE_UNAVAILABLE');
    }));
  }

  async function resultForCommand(command: StoredCommand): Promise<BetCommandResult> {
    const base = {
      commandId: command.id,
      roundId: command.roundId ?? '',
      amountCents: safeNumber(command.amountCents) ?? 0,
      autoCashoutHundredths: command.autoCashoutHundredths,
      betCommandStatus: command.status,
      resultCode: command.resultCode,
      betId: command.betId,
    };
    if (command.status !== 'accepted' || !command.betId) return { ...base, bet: null };

    try {
      const [bet] = await db
        .select()
        .from(gameBets)
        .where(and(
          eq(gameBets.betId, command.betId),
          eq(gameBets.playerId, command.playerId),
        ))
        .limit(1);
      if (!bet) return { ...base, betCommandStatus: 'unknown', resultCode: 'accepted_bet_missing', bet: null };
      const amountCents = safeNumber(bet.amountCents);
      if (amountCents === null) return { ...base, betCommandStatus: 'unknown', resultCode: 'unsafe_stored_amount', bet: null };
      return {
        ...base,
        bet: {
          betId: bet.betId,
          engineStatus: bet.engineStatus,
          multiplierHundredths: safeNumber(bet.multiplierHundredths),
          payoutCents: safeNumber(bet.payoutCents),
          settlementStatus: bet.settlementStatus,
        },
      };
    } catch {
      return unknownResult(command, 'storage_unavailable');
    }
  }

  async function currentCommand(playerId: string, commandId: string): Promise<StoredCommand | undefined> {
    return withStorageErrors(async () => {
      const [command] = await db
        .select(commandProjection)
        .from(gameCommands)
        .where(and(
          eq(gameCommands.id, commandId),
          eq(gameCommands.playerId, playerId),
        ))
        .limit(1);
      return command;
    });
  }

  async function listBets(input: ListBetsInput): Promise<BetCommandResult[]> {
    const limit = input.limit ?? 10;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
      throw new GameCommandError('INVALID_QUERY');
    }
    const commands = await withStorageErrors(() => db
      .select(commandProjection)
      .from(gameCommands)
      .where(and(
        eq(gameCommands.playerId, input.playerId),
        eq(gameCommands.commandType, 'bet'),
      ))
      .orderBy(desc(gameCommands.createdAt), desc(gameCommands.id))
      .limit(limit));
    return Promise.all(commands.map((command) => resultForCommand(command)));
  }

  async function getCommand(input: GetGameCommandInput): Promise<BetCommandResult | null> {
    const command = await currentCommand(input.playerId, input.commandId);
    if (!command || command.commandType !== 'bet') return null;
    if (command.status === 'pending' || command.status === 'unknown') {
      return reconcileUnknown(command);
    }
    return resultForCommand(command);
  }

  async function getBet(input: GetGameBetInput): Promise<BetCommandResult | null> {
    const bet = await withStorageErrors(async () => {
      const [ownedBet] = await db
        .select()
        .from(gameBets)
        .where(and(
          eq(gameBets.betId, input.betId),
          eq(gameBets.playerId, input.playerId),
        ))
        .limit(1);
      return ownedBet;
    });
    if (!bet) return null;

    const command = await currentCommand(input.playerId, bet.commandId);
    if (!command || command.status !== 'accepted' || command.commandType !== 'bet') {
      throw new GameCommandError('SERVICE_UNAVAILABLE');
    }

    let current: CrashsimBet;
    try {
      current = await engine.getBet({
        betId: bet.betId,
        playerId: input.playerId,
        roundId: bet.roundId,
      });
    } catch (error) {
      if (error instanceof CrashsimHttpError && error.kind === 'not_found') {
        if (bet.engineStatus === 'cashed_out') {
          const fallbackSettlement = await settlementFor(input.playerId, {
            betId: bet.betId,
            status: bet.engineStatus,
            multiplierHundredths: safeNumber(bet.multiplierHundredths),
            payoutCents: safeNumber(bet.payoutCents),
            payoutPrecision: bet.settlementStatus === 'precision_incident'
              ? 'unsafe'
              : bet.payoutCents === null ? 'not_provided' : 'safe',
          });
          try {
            await db
              .update(gameBets)
              .set({ settlementStatus: fallbackSettlement, updatedAt: new Date() })
              .where(and(
                eq(gameBets.betId, bet.betId),
                eq(gameBets.playerId, input.playerId),
              ));
          } catch {
            throw new GameCommandError('SERVICE_UNAVAILABLE');
          }
        }
        return resultForCommand(command);
      }
      throw new GameCommandError('SERVICE_UNAVAILABLE');
    }

    if (current.betId !== bet.betId || current.playerId !== input.playerId ||
        current.roundId !== bet.roundId || current.amount !== safeNumber(bet.amountCents) ||
        current.status === 'rejected') {
      throw new GameCommandError('SERVICE_UNAVAILABLE');
    }

    const settlementStatus = await settlementFor(input.playerId, {
      betId: current.betId,
      status: current.status,
      multiplierHundredths: current.multiplierHundredths,
      payoutCents: current.payoutCents,
      payoutPrecision: current.payoutPrecision,
    });
    const payoutCents = current.status === 'cashed_out' ? current.payoutCents : null;
    const multiplierHundredths = current.status === 'cashed_out' ? current.multiplierHundredths : null;
    const refreshableStatuses: GameEngineBetStatus[] = current.status === 'active'
      ? ['active']
      : current.status === 'lost'
        ? ['active', 'lost']
        : ['active', 'cashed_out'];

    try {
      await db
        .update(gameBets)
        .set({
          engineStatus: current.status,
          multiplierHundredths: multiplierHundredths === null ? null : BigInt(multiplierHundredths),
          payoutCents: payoutCents === null ? null : BigInt(payoutCents),
          settlementStatus,
          updatedAt: new Date(),
        })
        .where(and(
          eq(gameBets.betId, bet.betId),
          eq(gameBets.playerId, input.playerId),
          inArray(gameBets.engineStatus, refreshableStatuses),
        ));
    } catch {
      throw new GameCommandError('SERVICE_UNAVAILABLE');
    }

    return resultForCommand(command);
  }

  async function persistUnknown(
    command: StoredCommand,
    betId: string | null,
    resultCode: string,
  ): Promise<BetCommandResult> {
    try {
      const persisted = await db.transaction(async (tx) => {
        const [updated] = await tx
          .update(gameCommands)
          .set({
            status: 'unknown',
            resultCode,
            betId,
            resolvedAt: null,
            updatedAt: new Date(),
          })
          .where(and(
            eq(gameCommands.id, command.id),
            inArray(gameCommands.status, ['pending', 'unknown']),
          ))
          .returning(commandProjection);
        if (updated) return updated;
        const [latest] = await tx
          .select(commandProjection)
          .from(gameCommands)
          .where(eq(gameCommands.id, command.id))
          .for('update');
        return latest;
      });
      if (!persisted) return unknownResult(command, 'storage_unavailable', betId);
      if (persisted.status !== 'unknown') return resultForCommand(persisted);
      logger.warn('game.bet.unknown', {
        commandId: persisted.id,
        roundId: persisted.roundId,
        reason: persisted.resultCode ?? resultCode,
      });
      return unknownResult(persisted, persisted.resultCode ?? resultCode);
    } catch {
      logger.error('game.bet.outcome_persistence_failed', { commandId: command.id, category: 'unknown' });
      return unknownResult(command, 'outcome_unknown', betId);
    }
  }

  async function persistRejected(
    command: StoredCommand,
    resultCode: string,
    betId: string | null = null,
  ): Promise<BetCommandResult> {
    try {
      const persisted = await db.transaction(async (tx) => {
        const [updated] = await tx
          .update(gameCommands)
          .set({
            status: 'rejected',
            resultCode,
            betId,
            resolvedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(and(
            eq(gameCommands.id, command.id),
            inArray(gameCommands.status, ['pending', 'unknown']),
          ))
          .returning(commandProjection);
        if (updated) return updated;
        const [latest] = await tx
          .select(commandProjection)
          .from(gameCommands)
          .where(eq(gameCommands.id, command.id))
          .for('update');
        return latest;
      });
      if (!persisted) return unknownResult(command, 'storage_unavailable', betId);
      if (persisted.status === 'rejected') {
        logger.info('game.bet.rejected', {
          commandId: persisted.id,
          roundId: persisted.roundId,
          reason: persisted.resultCode ?? resultCode,
        });
      }
      return resultForCommand(persisted);
    } catch {
      logger.error('game.bet.outcome_persistence_failed', { commandId: command.id, category: 'rejected' });
      return persistUnknown(command, betId, 'rejected_result_persistence_failed');
    }
  }

  async function settlementFor(playerId: string, bet: BetToPersist): Promise<GameSettlementStatus> {
    if (bet.status !== 'cashed_out') return 'not_applicable';
    if (bet.payoutPrecision === 'unsafe') return 'precision_incident';
    try {
      const status = await financial.getCashoutCreditStatus({ playerId, betId: bet.betId });
      return status.status === 'credited' ? 'confirmed' : 'pending';
    } catch {
      return 'pending';
    }
  }

  async function persistAccepted(command: StoredCommand, bet: BetToPersist): Promise<BetCommandResult> {
    const settlementStatus = await settlementFor(command.playerId, bet);
    try {
      const persisted = await db.transaction(async (tx) => {
        const [latest] = await tx
          .select(commandProjection)
          .from(gameCommands)
          .where(eq(gameCommands.id, command.id))
          .for('update');
        if (!latest) return undefined;
        if (latest.status !== 'pending' && latest.status !== 'unknown') return latest;

        await tx
          .update(gameCommands)
          .set({
            status: 'accepted',
            resultCode: null,
            betId: bet.betId,
            resolvedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(gameCommands.id, command.id));

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

        const [updated] = await tx
          .select(commandProjection)
          .from(gameCommands)
          .where(eq(gameCommands.id, command.id));
        return updated;
      });
      if (!persisted) return unknownResult(command, 'storage_unavailable', bet.betId);
      if (persisted.status === 'accepted') {
        logger.info('game.bet.accepted', {
          commandId: persisted.id,
          roundId: persisted.roundId,
          betId: bet.betId,
          engineStatus: bet.status,
        });
      }
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

    if (candidates.length !== 1) {
      return persistUnknown(command, null, candidates.length === 0 ? 'debit_not_found' : 'debit_ambiguous');
    }

    const candidate = candidates[0]!;
    if (command.betId !== null && command.betId !== candidate.betId) {
      return persistUnknown(command, command.betId, 'bet_identity_mismatch');
    }
    let engineBet: CrashsimBet;
    try {
      engineBet = await engine.getBet({
        betId: candidate.betId,
        playerId: command.playerId,
        roundId: command.roundId ?? '',
      });
    } catch {
      logger.warn('game.bet.reconciliation_incomplete', { commandId: command.id, stage: 'engine_lookup' });
      return persistUnknown(command, candidate.betId, 'engine_unavailable');
    }

    const expectedAmount = safeNumber(command.amountCents);
    if (expectedAmount === null || engineBet.amount !== expectedAmount) {
      return persistUnknown(command, candidate.betId, 'bet_identity_mismatch');
    }

    if (candidate.outcome === 'insufficient_funds') {
      if (engineBet.status === 'rejected') {
        return persistRejected(command, 'insufficient_funds', candidate.betId);
      }
      return persistUnknown(command, candidate.betId, 'debit_outcome_mismatch');
    }

    if (engineBet.status === 'rejected') {
      return persistRejected(command, 'debit_applied_engine_rejected', candidate.betId);
    }

    return persistAccepted(command, {
      betId: engineBet.betId,
      status: engineBet.status,
      multiplierHundredths: engineBet.multiplierHundredths,
      payoutCents: engineBet.payoutCents,
      payoutPrecision: engineBet.payoutPrecision,
    });
  }

  async function replayOrReconcile(command: StoredCommand, requestHash: string): Promise<BetCommandResult> {
    assertMatchingCommand(command, requestHash);
    if (command.status === 'pending' || command.status === 'unknown') return reconcileUnknown(command);
    return resultForCommand(command);
  }

  function rejectedCode(error: CrashsimHttpError): string {
    if (error.engineCode === 'insufficient_funds') return 'insufficient_funds';
    if (error.engineCode === 'betting_closed') return 'betting_closed';
    return 'engine_rejected';
  }

  async function postBet(command: StoredCommand, sessionId: string, bet: NormalizedBet): Promise<BetCommandResult> {
    try {
      const created = await engine.placeBet({
        sessionId,
        playerId: command.playerId,
        roundId: bet.roundId,
        amount: bet.amountCents,
        autoCashout: bet.autoCashout,
      });
      return persistAccepted(command, {
        betId: created.betId,
        status: created.status,
        multiplierHundredths: null,
        payoutCents: null,
        payoutPrecision: 'not_provided',
      });
    } catch (error) {
      if (error instanceof CrashsimHttpError && error.kind === 'session_not_found') {
        if (sessions.get(command.playerId) === sessionId) sessions.delete(command.playerId);
        let refreshedSession: string;
        try {
          refreshedSession = await createOrReuseSession(command.playerId);
        } catch {
          return persistRejected(command, 'engine_unavailable');
        }

        try {
          const retried = await engine.placeBet({
            sessionId: refreshedSession,
            playerId: command.playerId,
            roundId: bet.roundId,
            amount: bet.amountCents,
            autoCashout: bet.autoCashout,
          });
          return persistAccepted(command, {
            betId: retried.betId,
            status: retried.status,
            multiplierHundredths: null,
            payoutCents: null,
            payoutPrecision: 'not_provided',
          });
        } catch (retryError) {
          if (retryError instanceof CrashsimHttpError && retryError.kind === 'session_not_found') {
            return persistRejected(command, 'session_not_found');
          }
          if (retryError instanceof CrashsimHttpError &&
              (retryError.kind === 'rejected' || retryError.kind === 'conflict')) {
            return persistRejected(command, rejectedCode(retryError));
          }
          return reconcileUnknown(command);
        }
      }

      if (error instanceof CrashsimHttpError &&
          (error.kind === 'rejected' || error.kind === 'conflict')) {
        return persistRejected(command, rejectedCode(error));
      }
      return reconcileUnknown(command);
    }
  }

  return {
    async createSession(playerId) {
      await createOrReuseSession(playerId);
      return { status: 'ready' };
    },

    async placeBet(input) {
      if (!UUID_PATTERN.test(input.idempotencyKey)) throw new GameCommandError('INVALID_IDEMPOTENCY_KEY');
      const bet = normalizeBet(input);
      const existing = await loadByIdempotencyKey(input.playerId, input.idempotencyKey);
      if (existing) return replayOrReconcile(existing, bet.requestHash);

      assertRoundAcceptingBets(bet.roundId);
      let sessionId: string;
      try {
        sessionId = await createOrReuseSession(input.playerId);
      } catch {
        throw new GameCommandError('SERVICE_UNAVAILABLE');
      }
      assertRoundAcceptingBets(bet.roundId);

      const reservation = await reserveBetCommand(input, bet);
      if (!reservation.created) return replayOrReconcile(reservation.command, bet.requestHash);
      return postBet(reservation.command, sessionId, bet);
    },
    listBets,
    getCommand,
    getBet,
  };
}
