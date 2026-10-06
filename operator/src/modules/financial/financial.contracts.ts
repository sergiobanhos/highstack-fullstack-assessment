export type FinancialOutcome = 'applied' | 'insufficient_funds' | 'balance_limit';
export type FinancialSource = 'engine' | 'reconciliation' | 'test' | 'payout';

export type FinancialErrorCode =
  | 'INVALID_AMOUNT'
  | 'INVALID_IDEMPOTENCY_KEY'
  | 'WALLET_NOT_FOUND'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INVALID_PAGE'
  | 'INVALID_LOOKUP'
  | 'STORAGE_UNAVAILABLE';

export class FinancialServiceError extends Error {
  constructor(readonly code: FinancialErrorCode) {
    super(code);
    this.name = 'FinancialServiceError';
  }
}

export interface WalletBalance {
  playerId: string;
  balanceCents: bigint;
}

export interface FinancialResult {
  operationId: string;
  outcome: FinancialOutcome;
  balanceCents: bigint;
  replayed: boolean;
}

export interface LedgerCursor {
  createdAt: string;
  id: string;
}

export interface LedgerPageInput {
  limit: number;
  before?: LedgerCursor;
}

export interface LedgerEntry {
  id: string;
  operationId: string;
  direction: 'debit' | 'credit';
  source: FinancialSource;
  amountCents: bigint;
  balanceAfterCents: bigint;
  betId: string | null;
  roundId: string | null;
  createdAt: string;
}

export interface LedgerPage {
  items: LedgerEntry[];
  hasMore: boolean;
}

export interface DebitInput {
  txId: string;
  playerId: string;
  amount: number;
  betId?: string | null;
  roundId?: string | null;
}

export interface CreditCashoutInput {
  playerId: string;
  amount: number;
  betId: string;
  roundId?: string | null;
  source: 'engine' | 'reconciliation';
  txId?: string;
}

export interface TopUpInput {
  playerId: string;
  amount: number;
  idempotencyKey: string;
}

export interface PayoutRequestInput {
  playerId: string;
  amount: number;
  idempotencyKey: string;
}

export interface PayoutRecord {
  id: string;
  amountCents: bigint;
  status: 'processing' | 'done';
  requestedAt: string;
  completedAt: string | null;
}

export interface PayoutCursor {
  requestedAt: string;
  id: string;
}

export interface PayoutPageInput {
  limit: number;
  before?: PayoutCursor;
}

export interface PayoutPage {
  items: PayoutRecord[];
  hasMore: boolean;
}

export interface PayoutRequestResult extends FinancialResult {
  payout: PayoutRecord | null;
}

export interface BetDebitLookupInput {
  playerId: string;
  roundId: string;
  amount: number;
  createdAt: string;
}

export interface BetDebitCandidate {
  betId: string;
  outcome: 'applied' | 'insufficient_funds';
}

export type CashoutCreditStatus =
  | { status: 'credited' }
  | { status: 'pending' }
  | { status: 'incident'; reason: 'balance_limit' | 'ledger_missing' | 'unexpected_outcome' };

export interface FinancialService {
  ensureWallet(playerId: string): Promise<WalletBalance>;
  getBalance(playerId: string): Promise<WalletBalance>;
  listEntries(playerId: string, page: LedgerPageInput): Promise<LedgerPage>;
  debit(input: DebitInput): Promise<FinancialResult>;
  creditCashoutOnce(input: CreditCashoutInput): Promise<FinancialResult>;
  findBetDebitForCommand(input: BetDebitLookupInput): Promise<BetDebitCandidate[]>;
  getCashoutCreditStatus(input: { playerId: string; betId: string }): Promise<CashoutCreditStatus>;
  topUp(input: TopUpInput): Promise<FinancialResult>;
  requestPayout(input: PayoutRequestInput): Promise<PayoutRequestResult>;
  getPayout(input: { playerId: string; payoutId: string }): Promise<PayoutRecord | null>;
  listPayouts(playerId: string, page: PayoutPageInput): Promise<PayoutPage>;
  completeDuePayouts(): Promise<string[]>;
}
