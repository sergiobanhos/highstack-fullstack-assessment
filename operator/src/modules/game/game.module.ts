import type { FastifyInstance } from 'fastify';
import type { Logger, OperatorConfig } from '../../config';
import type { OperatorDatabase } from '../../db';
import type { AuthModule } from '../auth/auth.module';
import type { FinancialModule } from '../financial/financial.module';
import { registerGameCommandsController } from './game-commands.controller';
import type { BackoffOptions, Scheduler, UpstreamSocketFactory } from './crashsim-stream.client';
import { createGameCommandService } from './game-command.service';
import { GameEventHub } from './game-event-hub';
import { registerGameEventsRoute } from './game-events.controller';
import { CrashsimHttpClient } from './crashsim-http.client';
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

export interface GameModule {
  start(): void;
  stop(): Promise<void>;
}

/** Wires the Crashsim stream, authenticated commands, and downstream SSE route. */
export function createGameModule({ app, db, auth, financial, ...deps }: GameModuleDeps): GameModule {
  const hub = new GameEventHub();
  const stream = createGameStreamService({ ...deps, hub });
  const engine = new CrashsimHttpClient({
    baseUrl: deps.config.engine.httpUrl,
    operatorKey: deps.config.engine.operatorKey,
    fetchImpl: deps.fetchImpl,
  });
  const commands = createGameCommandService({
    db,
    financial,
    engine,
    stream,
    logger: deps.logger,
  });
  registerGameCommandsController({ app, service: commands, requireUser: auth.requireUser, logger: deps.logger });
  registerGameEventsRoute(app, { hub, stream, logger: deps.logger });

  return {
    start: () => stream.start(),
    stop: () => stream.stop(),
  };
}
