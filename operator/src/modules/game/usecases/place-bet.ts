import { GameCommandError } from '../game.errors';
import type { BetCommandResult, PlaceBetCommandInput, StoredCommand } from './game-command-runtime';

export interface NormalizedBetInput {
  roundId: string;
  amountCents: number;
  autoCashoutHundredths: number | null;
  autoCashout: number | undefined;
  requestHash: string;
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
