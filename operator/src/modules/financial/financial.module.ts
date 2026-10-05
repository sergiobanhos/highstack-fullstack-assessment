import type { FastifyInstance } from 'fastify';
import type { Logger, OperatorConfig } from '../../config';
import type { OperatorDatabase } from '../../db';
import type { AuthModule } from '../auth/auth.module';
import { registerFinancialController } from './financial.controller';
import { createFinancialService, type FinancialService } from './financial.service';

/** Public financial contract for game and authenticated API modules. */
export type FinancialModule = FinancialService;

/** Composes the financial service without exposing schema or persistence details. */
export interface FinancialModuleOptions {
  app: FastifyInstance;
  db: OperatorDatabase;
  config: OperatorConfig;
  logger: Logger;
  auth: Pick<AuthModule, 'requireUser'>;
}

/** Composes the service and its Crashsim webhook routes, matching the other modules. */
export function createFinancialModule({ app, db, config, logger, auth }: FinancialModuleOptions): FinancialModule {
  const service = createFinancialService({ db });
  registerFinancialController({
    app,
    service,
    webhookSecret: config.engine.webhookSecret,
    walletTestTopupEnabled: config.walletTestTopupEnabled,
    requireUser: auth.requireUser,
    logger,
  });
  return service;
}
