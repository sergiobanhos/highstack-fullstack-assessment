import type { OperatorDatabase } from '../../db';
import type { FinancialService } from './financial.contracts';
import { createApplyDebit } from './usecases/apply-debit';
import { createCompleteDuePayouts } from './usecases/complete-due-payouts';
import { createCreditCashout } from './usecases/credit-cashout';
import { createEnsureWallet } from './usecases/ensure-wallet';
import { createFindBetDebit } from './usecases/find-bet-debit';
import { createGetCashoutCreditStatus } from './usecases/get-cashout-credit-status';
import { createGetPayout } from './usecases/get-payout';
import { createGetWallet } from './usecases/get-wallet';
import { createListLedger } from './usecases/list-ledger';
import { createListPayouts } from './usecases/list-payouts';
import { createRequestPayout } from './usecases/request-payout';
import { createTopUpWallet } from './usecases/top-up-wallet';

export { FinancialServiceError } from './financial.contracts';
export type {
  BetDebitCandidate,
  BetDebitLookupInput,
  CashoutCreditStatus,
  CreditCashoutInput,
  DebitInput,
  FinancialErrorCode,
  FinancialOutcome,
  FinancialResult,
  FinancialService,
  FinancialSource,
  LedgerCursor,
  LedgerEntry,
  LedgerPage,
  LedgerPageInput,
  PayoutCursor,
  PayoutPage,
  PayoutPageInput,
  PayoutRecord,
  PayoutRequestInput,
  PayoutRequestResult,
  TopUpInput,
  WalletBalance,
} from './financial.contracts';

/** Public financial facade: compose the module's wallet, ledger, and payout flows. */
export function createFinancialService({ db }: { db: OperatorDatabase }): FinancialService {
  return {
    ensureWallet: createEnsureWallet({ db }),
    getBalance: createGetWallet({ db }),
    listEntries: createListLedger({ db }),
    debit: createApplyDebit({ db }),
    creditCashoutOnce: createCreditCashout({ db }),
    findBetDebitForCommand: createFindBetDebit({ db }),
    getCashoutCreditStatus: createGetCashoutCreditStatus({ db }),
    topUp: createTopUpWallet({ db }),
    requestPayout: createRequestPayout({ db }),
    getPayout: createGetPayout({ db }),
    listPayouts: createListPayouts({ db }),
    completeDuePayouts: createCompleteDuePayouts({ db }),
  };
}
