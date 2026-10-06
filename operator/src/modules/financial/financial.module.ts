import type { FastifyInstance } from 'fastify';
import type { Logger, OperatorConfig } from '../../config';
import type { OperatorDatabase } from '../../db';
import type { AuthModule } from '../auth/auth.module';
import { registerEngineWebhookController } from './controllers/engine-webhook.controller';
import { registerWalletController } from './controllers/wallet.controller';
import { createFinancialService, type FinancialService } from './financial.service';

export type {
  BetDebitCandidate,
  BetDebitLookupInput,
  CashoutCreditStatus,
} from './financial.service';

/** Public financial contract for game and authenticated API modules. */
export type FinancialModule = FinancialService;

/** Called after an engine cashout credit was applied to the wallet. */
export type CashoutCreditListener = (credit: {
  betId: string;
  playerId: string;
  payoutCents: number;
  roundId: string;
}) => Promise<unknown>;

/** Composes the financial service without exposing schema or persistence details. */
export interface FinancialModuleOptions {
  app: FastifyInstance;
  db: OperatorDatabase;
  config: OperatorConfig;
  logger: Logger;
  auth: Pick<AuthModule, 'requireUser'>;
  /**
   * The game module records the cashout on the bet itself. Failures surface as
   * a 503 so the engine retries the idempotent webhook instead of leaving the
   * wallet credited while the bet still looks active.
   */
  onCashoutCredited?: CashoutCreditListener;
  /** Optional override for focused module tests. */
  payoutMockEnabled?: boolean;
}

/** Composes the service and its Crashsim webhook routes, matching the other modules. */
export function createFinancialModule({
  app,
  db,
  config,
  logger,
  auth,
  onCashoutCredited,
  payoutMockEnabled = config.payoutMockEnabled,
}: FinancialModuleOptions): FinancialModule {
  const service = createFinancialService({ db });
  registerWalletController({
    app,
    service,
    walletTestTopupEnabled: config.walletTestTopupEnabled,
    payoutMockEnabled,
    requireUser: auth.requireUser,
    logger,
  });
  registerEngineWebhookController({
    app,
    service,
    webhookSecret: config.engine.webhookSecret,
    onCashoutCredited,
    logger,
  });

  if (payoutMockEnabled) {
    let timer: ReturnType<typeof setInterval> | undefined;
    let activeSweep: Promise<void> | undefined;

    const runSweep = (): Promise<void> => {
      if (activeSweep) return activeSweep;
      activeSweep = service.completeDuePayouts()
        .then((payoutIds) => {
          for (const payoutId of payoutIds) {
            logger.info('financial payout completed', {
              event: 'financial.payout.completed', payoutId,
            });
          }
        })
        .catch(() => {
          logger.warn('financial payout processing sweep failed', {
            event: 'financial.payout.processing_failed', reason: 'storage_unavailable',
          });
        })
        .finally(() => {
          activeSweep = undefined;
        });
      return activeSweep;
    };

    app.addHook('onReady', async () => {
      await runSweep();
      timer = setInterval(() => void runSweep(), 500);
      timer.unref?.();
    });
    app.addHook('onClose', async () => {
      if (timer) clearInterval(timer);
      await activeSweep;
    });
  }

  return service;
}
