import type { FastifyInstance } from 'fastify';
import type { Logger, OperatorConfig } from '../../config';
import type { OperatorDatabase } from '../../db';
import type { AuthModule } from '../auth/auth.module';
import type { FinancialModule } from '../financial/financial.module';
import { CrashsimHttpClient } from '../../integrations/crashsim/http.client';
import { registerGameCommandsController } from './game-commands.controller';
import type { BackoffOptions, Scheduler, UpstreamSocketFactory } from '../../integrations/crashsim/stream.client';
import { createGameCommandService, type GameCommandService, type RecordCashoutCreditInput } from './game-command.service';
import { GameEventHub } from './game-event-hub';
import { registerGameEventsRoute } from './game-events.controller';
import { createGameStreamService } from './game-stream.service';

export interface GameModuleDeps {
  app: FastifyInstance;
  db: OperatorDatabase;
  auth: Pick<AuthModule, 'requireUser'>;
  financial: FinancialModule;
  config: OperatorConfig;
  logger: Logger;
  /** Test seams for the concrete Crashsim clients and retry timers. */
  socketFactory?: UpstreamSocketFactory;
  scheduler?: Scheduler;
  random?: () => number;
  streamBackoff?: Partial<BackoffOptions>;
  resyncBackoff?: Partial<BackoffOptions>;
  fetchImpl?: typeof fetch;
}

export type { RecordCashoutCreditInput };

export interface GameModule {
  start(): void;
  stop(): Promise<void>;
  /**
   * Records an engine cashout credit the financial module already applied, so
   * the bet reflects the cashout without waiting for an engine reconciliation.
   */
  recordCashoutCredit(input: RecordCashoutCreditInput): Promise<'applied' | 'ignored'>;
}

/** Wires the Crashsim stream, authenticated commands, and downstream SSE route. */
export function createGameModule({ app, db, auth, financial, ...deps }: GameModuleDeps): GameModule {
  const hub = new GameEventHub();
  let commands: GameCommandService | null = null;
  const stream = createGameStreamService({
    ...deps,
    hub,
    onRoundCrashed: (roundId) => commands?.reconcileBetsForRound(roundId) ?? Promise.resolve(),
    onSnapshotSynchronized: ({ state }) => {
      if (!state.roundId || !state.state) return Promise.resolve();
      return commands?.reconcileClosedBets({
        currentRoundId: state.roundId,
        currentRoundState: state.state,
      }) ?? Promise.resolve();
    },
  });
  const engine = new CrashsimHttpClient({
    baseUrl: deps.config.engine.httpUrl,
    operatorKey: deps.config.engine.operatorKey,
    fetchImpl: deps.fetchImpl,
  });
  const commandService = createGameCommandService({
    db,
    financial,
    engine,
    stream,
    logger: deps.logger,
  });
  commands = commandService;
  registerGameCommandsController({ app, service: commandService, requireUser: auth.requireUser, logger: deps.logger });
  registerGameEventsRoute(app, { hub, stream, logger: deps.logger });

  return {
    start: () => stream.start(),
    stop: () => stream.stop(),
    recordCashoutCredit: (input) => commandService.recordCashoutCredit(input),
  };
}
