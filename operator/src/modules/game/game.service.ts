import { and, desc, eq, inArray } from 'drizzle-orm';
import { gameBets, gameCommands } from './game.schema';
import { GameCommandError } from './game.errors';
export { GameCommandError } from './game.errors';
export type { GameCommandErrorCode } from './game.errors';
export type * from './game.contracts';
import { createEnsurePlayerSession } from './usecases/ensure-player-session';
import { createBetMutationHandlers, createPlaceBetUseCase, normalizeBet } from './usecases/place-bet';
import { createCashoutBetUseCase, createRunCashoutBetUseCase, createCashoutMutationHandlers } from './usecases/cashout-bet';
import { createGetGameBet } from './usecases/get-bet';
import { createGetGameCommand } from './usecases/get-command';
import { createListBets } from './usecases/list-bets';
import { createRecordCashoutCredit } from './usecases/record-cashout-credit';
import { createReconcileBets } from './usecases/reconcile-bets';
import { createCommandOutcomes } from './usecases/command-outcomes';
import type { BetCommandResult, GameService, GameServiceDeps } from './game.contracts';
import { createGameCommandStore } from './usecases/command-store';
import { commandProjection } from './usecases/command-persistence';

/** Coordinates the one Crashsim bet flow; session IDs remain process-local. */
export function createGameService({ db, financial, engine, stream, logger }: GameServiceDeps): GameService {
  const sessions = new Map<string, string>();
  const sessionCreations = new Map<string, Promise<string>>();
  const cashoutRequests = new Map<string, Promise<BetCommandResult | null>>();
  const cashoutInFlight = new Map<string, Promise<BetCommandResult>>();
  const ensurePlayerSession = createEnsurePlayerSession({ financial, engine, sessions, sessionCreations });

  const commandStore = createGameCommandStore({ db, stream });
  const {
    withStorageErrors,
    assertRoundAcceptingBets,
    loadByIdempotencyKey,
    assertMatchingCommand,
    reserveBet,
    reserveCashout,
    currentCommand,
  } = commandStore;

  const { resultForCommand, persistUnknown, settlementFor } = createCommandOutcomes({ db, financial, logger });

  const cashoutMutations = createCashoutMutationHandlers({
    db,
    engine,
    logger,
    settlementFor,
    resultForCommand,
    persistUnknown,
  });
  const reconcileCashout = cashoutMutations.reconcile;

  const betMutations = createBetMutationHandlers({
    db,
    financial,
    engine,
    logger,
    sessions,
    ensurePlayerSession,
    resultForCommand,
    persistUnknown,
    settlementFor,
  });

  const listBets = createListBets({
    load: (playerId, limit) => withStorageErrors(() => db
      .select(commandProjection)
      .from(gameCommands)
      .where(and(eq(gameCommands.playerId, playerId), eq(gameCommands.commandType, 'bet')))
      .orderBy(desc(gameCommands.createdAt), desc(gameCommands.id))
      .limit(limit)),
    resultForCommand,
  });
  const getCommand = createGetGameCommand({
    load: currentCommand,
    cashoutInFlight,
    reconcileCashout,
    reconcileBet: betMutations.reconcileUnknown,
    resultForCommand,
  });
  const getBet = createGetGameBet({
    db,
    engine,
    cashoutInFlight,
    loadBet: (playerId, betId) => withStorageErrors(async () => {
      const [bet] = await db.select().from(gameBets)
        .where(and(eq(gameBets.betId, betId), eq(gameBets.playerId, playerId))).limit(1);
      return bet;
    }),
    loadUnresolvedCashout: (playerId, betId) => withStorageErrors(async () => {
      const [command] = await db.select(commandProjection).from(gameCommands).where(and(
        eq(gameCommands.playerId, playerId),
        eq(gameCommands.betId, betId),
        eq(gameCommands.commandType, 'cashout'),
        inArray(gameCommands.status, ['pending', 'unknown']),
      )).limit(1);
      return command;
    }),
    currentCommand,
    reconcileCashout,
    resultForCommand,
    settlementFor,
  });
  const recordCashoutCredit = createRecordCashoutCredit({ db, logger });
  const { reconcileBetsForRound, reconcileClosedBets } = createReconcileBets({ db, logger, getBet });

  const runCashout = createRunCashoutBetUseCase({
    loadByIdempotencyKey,
    assertMatchingCommand,
    reconcileCashout,
    cashoutInFlight,
    loadOwnedBet: (playerId, betId) => withStorageErrors(async () => {
      const [bet] = await db
        .select()
        .from(gameBets)
        .where(and(eq(gameBets.betId, betId), eq(gameBets.playerId, playerId)))
        .limit(1);
      return bet;
    }),
    getSnapshot: () => stream.getSnapshot(),
    reserve: reserveCashout,
    resultForCommand,
    post: cashoutMutations.post,
    logger,
  });

  const cashout = createCashoutBetUseCase({ requests: cashoutRequests, run: runCashout });

  const placeBet = createPlaceBetUseCase({
    normalize: normalizeBet,
    loadByIdempotencyKey,
    replayOrReconcile: betMutations.replayOrReconcile,
    assertRoundAcceptingBets,
    ensurePlayerSession,
    reserve: reserveBet,
    post: betMutations.postBet,
  });

  return {
    async createSession(playerId) {
      try {
        await ensurePlayerSession(playerId);
      } catch {
        throw new GameCommandError('SERVICE_UNAVAILABLE');
      }
      return { status: 'ready' };
    },
    placeBet,
    cashout,
    listBets,
    getCommand,
    getBet,
    reconcileBetsForRound,
    reconcileClosedBets,
    recordCashoutCredit,
  };
}
