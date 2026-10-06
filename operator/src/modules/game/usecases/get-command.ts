import type { BetCommandResult, GetGameCommandInput } from '../game.contracts';
import type { StoredCommand } from './command-persistence';

export interface GetGameCommandDeps {
  load(playerId: string, commandId: string): Promise<StoredCommand | undefined>;
  cashoutInFlight: Map<string, Promise<BetCommandResult>>;
  reconcileCashout(command: StoredCommand): Promise<BetCommandResult>;
  reconcileBet(command: StoredCommand): Promise<BetCommandResult>;
  resultForCommand(command: StoredCommand): Promise<BetCommandResult>;
}

/** Reads an owned command and reconciles unresolved mutations before returning. */
export function createGetGameCommand(deps: GetGameCommandDeps) {
  return async (input: GetGameCommandInput): Promise<BetCommandResult | null> => {
    const command = await deps.load(input.playerId, input.commandId);
    if (!command) return null;
    if (command.status === 'pending' || command.status === 'unknown') {
      if (command.commandType === 'cashout') {
        return deps.cashoutInFlight.get(command.id) ?? deps.reconcileCashout(command);
      }
      return deps.reconcileBet(command);
    }
    return deps.resultForCommand(command);
  };
}
