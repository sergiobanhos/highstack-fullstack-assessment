import type { FinancialModule } from '../financial/financial.module';
import type { CrashsimHttpClient } from '../../integrations/crashsim/http.client';
import type { GameCommandStatus, GameEngineBetStatus, GameSettlementStatus } from './game.schema';
import type { GameStreamService } from './realtime/stream.service';
import type { Logger } from '../../config';
import type { OperatorDatabase } from '../../db';

export interface PlaceBetCommandInput {
  playerId: string;
  idempotencyKey: string;
  roundId: string;
  amount: number;
  autoCashout?: number;
}

export interface CashoutCommandInput {
  playerId: string;
  idempotencyKey: string;
  betId: string;
}

export interface GameBetView {
  betId: string;
  engineStatus: GameEngineBetStatus;
  multiplierHundredths: number | null;
  payoutCents: number | null;
  settlementStatus: GameSettlementStatus;
}

export interface BetCommandResult {
  commandId: string;
  roundId: string;
  amountCents: number;
  autoCashoutHundredths: number | null;
  betCommandStatus: GameCommandStatus;
  resultCode: string | null;
  betId: string | null;
  bet: GameBetView | null;
}

export interface ListBetsInput {
  playerId: string;
  limit?: number;
}

export interface GetGameCommandInput {
  playerId: string;
  commandId: string;
}

export interface GetGameBetInput {
  playerId: string;
  betId: string;
}

export interface ReconcileClosedBetsInput {
  currentRoundId: string;
  currentRoundState: 'betting' | 'running' | 'crashed';
}

/** Input from financial after the idempotent cashout credit was committed. */
export interface RecordCashoutCreditInput {
  betId: string;
  playerId: string;
  payoutCents: number;
  roundId: string;
}

export interface GameService {
  createSession(playerId: string): Promise<{ status: 'ready' }>;
  placeBet(input: PlaceBetCommandInput): Promise<BetCommandResult>;
  cashout(input: CashoutCommandInput): Promise<BetCommandResult | null>;
  listBets(input: ListBetsInput): Promise<BetCommandResult[]>;
  getCommand(input: GetGameCommandInput): Promise<BetCommandResult | null>;
  getBet(input: GetGameBetInput): Promise<BetCommandResult | null>;
  reconcileBetsForRound(roundId: string): Promise<void>;
  reconcileClosedBets(input: ReconcileClosedBetsInput): Promise<void>;
  recordCashoutCredit(input: RecordCashoutCreditInput): Promise<'applied' | 'ignored'>;
}

export interface GameServiceDeps {
  db: OperatorDatabase;
  financial: Pick<FinancialModule, 'ensureWallet' | 'findBetDebitForCommand' | 'getCashoutCreditStatus'>;
  engine: Pick<CrashsimHttpClient, 'createSession' | 'placeBet' | 'getBet' | 'cashout'>;
  stream: Pick<GameStreamService, 'getSnapshot'>;
  logger: Logger;
}
