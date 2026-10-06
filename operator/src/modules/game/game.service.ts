import { createGameCommandService } from './usecases/game-command-runtime';
import type { GameCommandService, GameCommandServiceDeps } from './usecases/game-command-runtime';

export { GameCommandError } from './game.errors';
export type { GameCommandErrorCode } from './game.errors';
export type {
  BetCommandResult,
  CashoutCommandInput,
  GameBetView,
  GetGameBetInput,
  GetGameCommandInput,
  ListBetsInput,
  PlaceBetCommandInput,
  RecordCashoutCreditInput,
  ReconcileClosedBetsInput,
} from './usecases/game-command-runtime';

/** Public game-module API; its implementation remains private to the module. */
export type GameService = GameCommandService;

export function createGameService(deps: GameCommandServiceDeps): GameService {
  return createGameCommandService(deps);
}
