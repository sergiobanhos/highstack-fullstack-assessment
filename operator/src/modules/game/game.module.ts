import type { FastifyInstance } from 'fastify';
import type { Logger, OperatorConfig } from '../../config';
import type { BackoffOptions, Scheduler, UpstreamSocketFactory } from './crashsim-stream.client';
import { GameEventHub } from './game-event-hub';
import { registerGameEventsRoute } from './game-events.controller';
import { createGameStreamService } from './game-stream.service';

export interface GameModuleDeps {
  app: FastifyInstance;
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

/** Wires the one Crashsim stream and the downstream SSE route. */
export function createGameModule({ app, ...deps }: GameModuleDeps): GameModule {
  const hub = new GameEventHub();
  const stream = createGameStreamService({ ...deps, hub });
  registerGameEventsRoute(app, { hub, stream, logger: deps.logger });

  return {
    start: () => stream.start(),
    stop: () => stream.stop(),
  };
}
