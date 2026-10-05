import type { OperatorDatabase } from '../../db';
import { createFinancialService, type FinancialService } from './financial.service';

/** Public financial contract for game and authenticated API modules. */
export type FinancialModule = FinancialService;

/** Composes the financial service without exposing schema or persistence details. */
export function createFinancialModule({ db }: { db: OperatorDatabase }): FinancialModule {
  return createFinancialService({ db });
}
