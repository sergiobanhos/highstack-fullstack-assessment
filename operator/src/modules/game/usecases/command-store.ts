import { and, eq, inArray } from 'drizzle-orm';
import type { OperatorDatabase } from '../../../db';
import type { GameStreamService } from '../realtime/stream.service';
import { gameCommands } from '../game.schema';
import { GameCommandError } from '../game.errors';
import type { CashoutCommandInput, PlaceBetCommandInput } from '../game.contracts';
import type { NormalizedBetInput } from './place-bet';
import { commandProjection, type StoredCommand } from './command-persistence';

export interface CommandReservation {
  command: StoredCommand;
  created: boolean;
}

export function createGameCommandStore({ db, stream }: {
  db: OperatorDatabase;
  stream: Pick<GameStreamService, 'getSnapshot'>;
}) {
  async function withStorageErrors<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof GameCommandError) throw error;
      throw new GameCommandError('SERVICE_UNAVAILABLE');
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
      const [command] = await db.select(commandProjection).from(gameCommands).where(and(
        eq(gameCommands.playerId, playerId), eq(gameCommands.idempotencyKey, idempotencyKey),
      )).limit(1);
      return command;
    });
  }

  function assertMatchingCommand(command: StoredCommand, commandType: 'bet' | 'cashout', requestHash: string): void {
    if (command.commandType !== commandType || command.requestHash !== requestHash) {
      throw new GameCommandError('IDEMPOTENCY_KEY_REUSED');
    }
  }

  async function reserveBet(input: PlaceBetCommandInput, bet: NormalizedBetInput): Promise<CommandReservation> {
    return withStorageErrors(() => db.transaction(async (tx) => {
      const [inserted] = await tx.insert(gameCommands).values({
        playerId: input.playerId,
        commandType: 'bet',
        idempotencyKey: input.idempotencyKey,
        requestHash: bet.requestHash,
        roundId: bet.roundId,
        amountCents: BigInt(bet.amountCents),
        autoCashoutHundredths: bet.autoCashoutHundredths,
        status: 'pending',
      }).onConflictDoNothing().returning(commandProjection);
      if (inserted) return { command: inserted, created: true };

      const [sameKey] = await tx.select(commandProjection).from(gameCommands).where(and(
        eq(gameCommands.playerId, input.playerId), eq(gameCommands.idempotencyKey, input.idempotencyKey),
      )).for('update');
      if (sameKey) {
        assertMatchingCommand(sameKey, 'bet', bet.requestHash);
        return { command: sameKey, created: false };
      }

      const [roundSlot] = await tx.select(commandProjection).from(gameCommands).where(and(
        eq(gameCommands.playerId, input.playerId),
        eq(gameCommands.roundId, bet.roundId),
        eq(gameCommands.commandType, 'bet'),
        inArray(gameCommands.status, ['pending', 'unknown', 'accepted']),
      )).for('update');
      if (roundSlot?.status === 'accepted') throw new GameCommandError('BET_ALREADY_EXISTS');
      if (roundSlot) throw new GameCommandError('BET_OUTCOME_UNKNOWN');
      throw new GameCommandError('SERVICE_UNAVAILABLE');
    }));
  }

  async function reserveCashout(input: CashoutCommandInput, requestHash: string, roundId: string): Promise<CommandReservation> {
    return withStorageErrors(() => db.transaction(async (tx) => {
      const [inserted] = await tx.insert(gameCommands).values({
        playerId: input.playerId,
        commandType: 'cashout',
        idempotencyKey: input.idempotencyKey,
        requestHash,
        roundId,
        betId: input.betId,
        status: 'pending',
      }).onConflictDoNothing().returning(commandProjection);
      if (inserted) return { command: inserted, created: true };

      const [sameKey] = await tx.select(commandProjection).from(gameCommands).where(and(
        eq(gameCommands.playerId, input.playerId), eq(gameCommands.idempotencyKey, input.idempotencyKey),
      )).for('update');
      if (sameKey) {
        assertMatchingCommand(sameKey, 'cashout', requestHash);
        return { command: sameKey, created: false };
      }
      const [betSlot] = await tx.select(commandProjection).from(gameCommands).where(and(
        eq(gameCommands.betId, input.betId),
        eq(gameCommands.commandType, 'cashout'),
        inArray(gameCommands.status, ['pending', 'unknown']),
      )).for('update');
      if (betSlot) throw new GameCommandError('CASHOUT_OUTCOME_UNKNOWN');
      throw new GameCommandError('SERVICE_UNAVAILABLE');
    }));
  }

  async function currentCommand(playerId: string, commandId: string): Promise<StoredCommand | undefined> {
    return withStorageErrors(async () => {
      const [command] = await db.select(commandProjection).from(gameCommands).where(and(
        eq(gameCommands.id, commandId), eq(gameCommands.playerId, playerId),
      )).limit(1);
      return command;
    });
  }

  return { withStorageErrors, assertRoundAcceptingBets, loadByIdempotencyKey, assertMatchingCommand, reserveBet, reserveCashout, currentCommand };
}
