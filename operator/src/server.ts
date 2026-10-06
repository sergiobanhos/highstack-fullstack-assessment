import Fastify, { type FastifyInstance } from "fastify";
import {
  createLogger,
  createRedactor,
  loadConfig,
  operatorSecrets,
  type Logger,
  type OperatorConfig,
} from "./config";
import { createDatabase, type DatabaseConnection } from "./db";
import { createAuthModule, type AuthModule } from "./modules/auth/auth.module";
import {
  createFinancialModule,
  type FinancialModule,
} from "./modules/financial/financial.module";
import {
  createGameModule,
  type GameModule,
  type GameModuleDeps,
} from "./modules/game/game.module";

export interface OperatorApp {
  app: FastifyInstance;
  config: OperatorConfig;
  logger: Logger;
  game: GameModule;
  auth: AuthModule;
  financial: FinancialModule;
  database: DatabaseConnection;
}

export type OperatorAppOverrides = Omit<
  GameModuleDeps,
  "app" | "config" | "logger" | "db" | "auth" | "financial"
> & {
  databaseConnection?: DatabaseConnection;
};

/**
 * Composition root: builds the Fastify instance and wires module composition
 * functions. Modules own their workflows; this file only assembles them.
 * Importing this file never opens a socket, so it stays testable.
 */
export function buildOperatorApp(
  config: OperatorConfig,
  overrides: OperatorAppOverrides = {},
): OperatorApp {
  const logger = createLogger({
    level: config.logLevel,
    redactor: createRedactor(operatorSecrets(config)),
  });

  const app = Fastify({ logger: false });
  const { databaseConnection, ...gameOverrides } = overrides;
  const database = databaseConnection ?? createDatabase(config.databaseUrl);
  const auth = createAuthModule({
    app,
    db: database.db,
    sessionTtlSeconds: config.authSessionTtlSeconds,
    logger,
  });
  // The game module is created after the financial one, so the engine's cashout
  // credit reaches the bet through this late-bound contract (no module cycle).
  let gameRef: GameModule | null = null;
  const financial = createFinancialModule({
    app,
    db: database.db,
    config,
    logger,
    auth,
    onCashoutCredited: (credit) => gameRef?.recordCashoutCredit(credit) ?? Promise.resolve(),
  });
  const game = createGameModule({
    app,
    db: database.db,
    auth,
    financial,
    config,
    logger,
    ...gameOverrides,
  });
  gameRef = game;

  app.get("/health", async () => ({ status: "ok" }));
  app.get("/ready", async (_request, reply) => {
    try {
      await checkOperatorReadiness({ database });
      return { status: "ready" };
    } catch {
      return reply.code(503).send({ status: "not_ready" });
    }
  });
  // Closing the HTTP server also releases the game stream and database pool.
  app.addHook("onClose", async () => {
    try {
      await game.stop();
    } finally {
      await database.close();
    }
  });

  return { app, config, logger, game, auth, financial, database };
}

export async function checkOperatorReadiness({
  database,
}: Pick<OperatorApp, "database">): Promise<void> {
  await database.check();
  await database.checkSchema();
}

async function main(): Promise<void> {
  let operator: OperatorApp | undefined;
  let stage = "configuration";
  try {
    const config = loadConfig(process.env);
    operator = buildOperatorApp(config);
    const { app, game, logger } = operator;

    let shuttingDown = false;
    const shutdown = async (signal: string): Promise<void> => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info("operator shutting down", { signal });
      try {
        await app.close();
      } catch {
        logger.error("operator shutdown failed");
        process.exitCode = 1;
      }
    };

    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.on(signal, () => void shutdown(signal));
    }

    stage = "route-registration";
    await app.ready();
    stage = "database-readiness";
    await checkOperatorReadiness(operator);
    stage = "http-listen";
    await app.listen({ port: config.port, host: config.host });
    logger.info("operator listening", { port: config.port, host: config.host });
    game.start();
  } catch (error) {
    if (operator) {
      operator.logger.error("operator failed to start", { stage });
      try {
        await operator.app.close();
      } catch {
        operator.logger.error("operator startup cleanup failed", { stage });
      }
    } else {
      if (
        error instanceof Error &&
        error.message.startsWith("Invalid operator configuration at: ")
      ) {
        console.error(error.message);
      } else {
        console.error(
          "Operator configuration is invalid. Check the required environment variables.",
        );
      }
    }
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  void main().catch(() => {
    console.error(
      "Operator startup failed. Check configuration and database readiness.",
    );
    process.exitCode = 1;
  });
}
