import type { BetCommandResult, ListBetsInput } from '../game.contracts';
import type { StoredCommand } from './command-persistence';
import { GameCommandError } from '../game.errors';

export interface ListBetsDeps {
  load(playerId: string, limit: number): Promise<StoredCommand[]>;
  resultForCommand(command: StoredCommand): Promise<BetCommandResult>;
}

/** Lists a player's latest bet commands and resolves each persisted view. */
export function createListBets({ load, resultForCommand }: ListBetsDeps) {
  return async (input: ListBetsInput): Promise<BetCommandResult[]> => {
    const limit = input.limit ?? 10;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
      throw new GameCommandError('INVALID_QUERY');
    }
    const commands = await load(input.playerId, limit);
    return Promise.all(commands.map((command) => resultForCommand(command)));
  };
}
