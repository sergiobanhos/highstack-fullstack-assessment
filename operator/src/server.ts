import Fastify, { type FastifyInstance } from 'fastify';
import {
  createLogger,
  createRedactor,
  loadConfig,
  operatorSecrets,
  type Logger,
  type OperatorConfig,
} from './config';
import { createGameModule, type GameModule, type GameModuleDeps } from './modules/game/game.module';

export interface OperatorApp {
  app: FastifyInstance;
  config: OperatorConfig;
  logger: Logger;
  game: GameModule;
}

export type OperatorAppOverrides = Omit<GameModuleDeps, 'config' | 'logger'>;

/**
 * Composition root: builds the Fastify instance and wires module composition
 * functions. Modules own their workflows; this file only assembles them.
 * Importing this file never opens a socket, so it stays testable.
 */
export function buildOperatorApp(config: OperatorConfig, overrides: OperatorAppOverrides = {}): OperatorApp {
  const logger = createLogger({
    level: config.logLevel,
    redactor: createRedactor(operatorSecrets(config)),
  });

  const app = Fastify({ logger: false });
  const game = createGameModule({ config, logger, ...overrides });

  app.get('/health', async () => ({ status: 'ok' }));
  game.registerRoutes(app);

  // Closing the HTTP server also releases the upstream engine stream.
  app.addHook('onClose', async () => {
    await game.stop();
  });

  return { app, config, logger, game };
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const { app, game, logger } = buildOperatorApp(config);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('operator shutting down', { signal });
    try {
      await app.close();
      process.exit(0);
    } catch (error) {
      logger.error('operator shutdown failed', { error });
      process.exit(1);
    }
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => void shutdown(signal));
  }

  try {
    await app.listen({ port: config.port, host: config.host });
    logger.info('operator listening', { port: config.port, host: config.host });
    game.start();
  } catch (error) {
    logger.error('operator failed to start', { error });
    process.exit(1);
  }
}

if (import.meta.main) void main();