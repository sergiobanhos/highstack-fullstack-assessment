import type { FastifyInstance } from 'fastify';
import type { Logger, OperatorConfig } from '../../config';
import type { OperatorDatabase } from '../../db';
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
}

/** Composes the service and its Crashsim webhook routes, matching the other modules. */
export function createFinancialModule({ app, db, config, logger }: FinancialModuleOptions): FinancialModule {
  const service = createFinancialService({ db });
  registerFinancialController({ app, service, webhookSecret: config.engine.webhookSecret, logger });
  return service;
}
