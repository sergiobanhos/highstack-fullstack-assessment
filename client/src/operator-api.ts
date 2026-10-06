/**
 * Typed same-origin transport to the operator.
 *
 * Every call goes to a relative path served by the operator (directly or
 * through the local proxy); the browser never talks to the engine. Responses
 * are validated with Valibot and failures are mapped to safe, typed errors
 * that never echo raw bodies, credentials, or stack traces.
 */

import * as v from 'valibot';

// ---------------------------------------------------------------------------
// Types mirroring the operator's public contracts
// ---------------------------------------------------------------------------

export interface AuthUser {
  id: string;
  name: string;
  email: string;
}

export interface SessionInfo {
  token: string;
  expiresAt: string;
  user: AuthUser;
}

export interface WalletBalance {
  balanceCents: number;
  currency: string;
}

export interface LedgerEntry {
  id: string;
  operationId: string;
  direction: 'debit' | 'credit';
  source: string;
  amountCents: number;
  balanceAfterCents: number;
  betId: string | null;
  roundId: string | null;
  createdAt: string;
  currency: string;
}

export interface LedgerPage {
  items: LedgerEntry[];
  nextCursor: string | null;
}

export interface TopUpReceipt {
  transactionId: string;
  balanceCents: number;
  currency: string;
}

export type PayoutStatus = 'processing' | 'done';

export interface Payout {
  id: string;
  amountCents: number;
  currency: string;
  status: PayoutStatus;
  requestedAt: string;
  completedAt: string | null;
  simulated: boolean;
}

export interface PayoutPage {
  items: Payout[];
  nextCursor: string | null;
}

export type BetCommandStatus = 'pending' | 'accepted' | 'rejected' | 'unknown';
export type EngineBetStatus = 'active' | 'lost' | 'cashed_out';
export type SettlementStatus = 'not_applicable' | 'pending' | 'confirmed' | 'precision_incident';

export interface BetView {
  betId: string;
  engineStatus: EngineBetStatus;
  multiplierHundredths: number | null;
  payoutCents: number | null;
  settlementStatus: SettlementStatus;
}

export interface BetCommandResult {
  commandId: string;
  roundId: string;
  amountCents: number;
  autoCashoutHundredths: number | null;
  betCommandStatus: BetCommandStatus;
  resultCode: string | null;
  betId: string | null;
  bet: BetView | null;
}

/**
 * Outcome of a game command POST:
 * - `accepted`: the operator confirmed the command;
 * - `unknown`: the outcome is still being reconciled; never resend with a new key;
 * - `rejected`: a terminal refusal with a safe error.
 */
export type CommandOutcome =
  | { kind: 'accepted'; command: BetCommandResult }
  | { kind: 'unknown'; command: BetCommandResult | null }
  | { kind: 'rejected'; error: OperatorApiError; command: BetCommandResult | null };

// ---------------------------------------------------------------------------
// Typed transport errors
// ---------------------------------------------------------------------------

export type OperatorApiErrorKind = 'http' | 'network' | 'invalid-response';

export class OperatorApiError extends Error {
  readonly kind: OperatorApiErrorKind;
  readonly status: number | null;
  readonly code: string | null;

  constructor(
    kind: OperatorApiErrorKind,
    status: number | null,
    code: string | null,
    message: string,
  ) {
    super(message);
    this.name = 'OperatorApiError';
    this.kind = kind;
    this.status = status;
    this.code = code;
  }
}

/** True when the failure means the browser session is no longer valid. */
export function isUnauthenticated(error: unknown): boolean {
  return error instanceof OperatorApiError && error.status === 401;
}

/**
 * Status codes that only happen before the operator mutates anything, so the
 * idempotency key is definitively consumed and a new attempt needs a new key.
 *
 * `503` is deliberately absent: `POST /payouts` commits the debit and then
 * re-reads the row, and a failure in that read maps to `SERVICE_UNAVAILABLE`
 * *after* the commit. Treating it as terminal would let the player start a
 * second payout with a fresh key. Anything not listed here keeps the key.
 */
const TERMINAL_REFUSAL_STATUSES = new Set([400, 402, 404, 409, 422, 429]);

/** True when the operator's answer is a definitive, pre-commit refusal. */
export function isTerminalRefusal(error: unknown): boolean {
  return (
    error instanceof OperatorApiError &&
    error.kind === 'http' &&
    error.status !== null &&
    TERMINAL_REFUSAL_STATUSES.has(error.status)
  );
}

function fallbackMessage(status: number): string {
  if (status === 401) return 'Sua sessão expirou. Entre novamente.';
  if (status === 404) return 'O recurso pedido não existe no operador.';
  if (status === 429) return 'Muitas tentativas em pouco tempo. Aguarde e tente novamente.';
  if (status >= 500) return 'O operador está indisponível no momento.';
  return `A solicitação falhou (HTTP ${status}).`;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** Maps an operator response into a typed error without echoing raw bodies. */
function errorFor(status: number, payload: unknown): OperatorApiError {
  const envelope = asRecord(asRecord(payload)?.error);
  const code = typeof envelope?.code === 'string' ? envelope.code : null;
  const message = typeof envelope?.message === 'string' && envelope.message.length > 0
    ? envelope.message
    : fallbackMessage(status);
  return new OperatorApiError('http', status, code, message);
}

const invalidResponse = (): OperatorApiError =>
  new OperatorApiError('invalid-response', null, null, 'O operador respondeu em um formato inesperado.');

// ---------------------------------------------------------------------------
// Wire schemas
// ---------------------------------------------------------------------------

const authUserSchema = v.strictObject({
  id: v.string(),
  name: v.string(),
  email: v.string(),
});

const sessionSchema = v.strictObject({
  token: v.string(),
  expiresAt: v.string(),
  user: authUserSchema,
});

const walletSchema = v.strictObject({
  balance: v.pipe(v.number(), v.integer()),
  currency: v.string(),
});

const ledgerEntrySchema = v.strictObject({
  id: v.string(),
  operationId: v.string(),
  direction: v.picklist(['debit', 'credit']),
  source: v.string(),
  amountCents: v.pipe(v.number(), v.integer()),
  balanceAfterCents: v.pipe(v.number(), v.integer()),
  betId: v.nullable(v.string()),
  roundId: v.nullable(v.string()),
  createdAt: v.string(),
  currency: v.string(),
});

const ledgerPageSchema = v.strictObject({
  items: v.array(ledgerEntrySchema),
  nextCursor: v.nullable(v.string()),
});

const topUpReceiptSchema = v.strictObject({
  transactionId: v.string(),
  balance: v.pipe(v.number(), v.integer()),
  currency: v.string(),
});

const payoutSchema = v.strictObject({
  id: v.string(),
  amountCents: v.pipe(v.number(), v.integer()),
  currency: v.string(),
  status: v.picklist(['processing', 'done']),
  requestedAt: v.string(),
  completedAt: v.nullable(v.string()),
  simulated: v.boolean(),
});

const payoutPageSchema = v.strictObject({
  items: v.array(payoutSchema),
  nextCursor: v.nullable(v.string()),
});

const betViewSchema = v.strictObject({
  betId: v.string(),
  engineStatus: v.picklist(['active', 'lost', 'cashed_out']),
  multiplierHundredths: v.nullable(v.pipe(v.number(), v.integer())),
  payoutCents: v.nullable(v.pipe(v.number(), v.integer())),
  settlementStatus: v.picklist(['not_applicable', 'pending', 'confirmed', 'precision_incident']),
});

const betCommandResultSchema = v.strictObject({
  commandId: v.string(),
  roundId: v.string(),
  amountCents: v.pipe(v.number(), v.integer()),
  autoCashoutHundredths: v.nullable(v.pipe(v.number(), v.integer())),
  betCommandStatus: v.picklist(['pending', 'accepted', 'rejected', 'unknown']),
  resultCode: v.nullable(v.string()),
  betId: v.nullable(v.string()),
  bet: v.nullable(betViewSchema),
});

const sessionReadySchema = v.strictObject({ status: v.literal('ready') });

function parseOrThrow<T>(schema: v.GenericSchema<T>, payload: unknown): T {
  const result = v.safeParse(schema, payload);
  if (!result.success) throw invalidResponse();
  return result.output;
}

/** Reads a `BetCommandResult` from either the result body or a `{ command }` envelope. */
function readBetCommand(payload: unknown): BetCommandResult | null {
  const record = asRecord(payload);
  if (!record) return null;
  const candidate = 'command' in record ? record.command : record;
  const result = v.safeParse(betCommandResultSchema, candidate);
  return result.success ? result.output : null;
}

function interpretCommand(status: number, payload: unknown): CommandOutcome {
  if (status === 202) {
    return { kind: 'unknown', command: readBetCommand(asRecord(payload)?.command) };
  }
  if (status >= 200 && status < 300) {
    const command = readBetCommand(payload);
    if (!command) return { kind: 'unknown', command: null };
    return command.betCommandStatus === 'accepted'
      ? { kind: 'accepted', command }
      : { kind: 'unknown', command };
  }
  return {
    kind: 'rejected',
    error: errorFor(status, payload),
    command: readBetCommand(asRecord(payload)?.command),
  };
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

interface SendOptions {
  method?: 'GET' | 'POST';
  token?: string | null;
  body?: unknown;
  idempotencyKey?: string;
  query?: Record<string, string | number | undefined>;
}

interface TransportResponse {
  status: number;
  payload: unknown;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

function buildQuery(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  return search.toString();
}

async function send(fetchImpl: FetchLike, path: string, options: SendOptions = {}): Promise<TransportResponse> {
  const query = options.query ? buildQuery(options.query) : '';
  const url = query.length > 0 ? `${path}?${query}` : path;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch {
    throw new OperatorApiError(
      'network',
      null,
      null,
      'Não foi possível falar com o operador. Verifique a conexão e tente novamente.',
    );
  }

  if (response.status === 204) return { status: 204, payload: undefined };

  let payload: unknown = null;
  try {
    const text = await response.text();
    payload = text.length > 0 ? (JSON.parse(text) as unknown) : null;
  } catch {
    payload = null;
  }
  return { status: response.status, payload };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface BetRequestInput {
  roundId: string;
  amountCents: number;
  autoCashoutHundredths: number | null;
  idempotencyKey: string;
}

export interface CashoutRequestInput {
  betId: string;
  idempotencyKey: string;
}

export interface HistoryQuery {
  limit?: number;
  cursor?: string;
}

export interface OperatorApi {
  register(input: { name: string; email: string; password: string }): Promise<AuthUser>;
  login(input: { email: string; password: string }): Promise<SessionInfo>;
  me(token: string): Promise<AuthUser>;
  logout(token: string): Promise<void>;

  getWallet(token: string): Promise<WalletBalance>;
  getTransactions(token: string, query?: HistoryQuery): Promise<LedgerPage>;
  requestTopUp(
    token: string,
    input: { amountCents: number; idempotencyKey: string },
  ): Promise<TopUpReceipt>;

  createPayout(
    token: string,
    input: { amountCents: number; idempotencyKey: string },
  ): Promise<Payout>;
  getPayout(token: string, payoutId: string): Promise<Payout>;
  listPayouts(token: string, query?: HistoryQuery): Promise<PayoutPage>;

  createSession(token: string): Promise<void>;
  placeBet(token: string, input: BetRequestInput): Promise<CommandOutcome>;
  cashout(token: string, input: CashoutRequestInput): Promise<CommandOutcome>;
  listBets(token: string, limit?: number): Promise<BetCommandResult[]>;
  getCommand(token: string, commandId: string): Promise<BetCommandResult | null>;
  getBet(token: string, betId: string): Promise<BetCommandResult | null>;
}

/** Stable UUID for one logical action; retries reuse it, new actions get a new one. */
export function createIdempotencyKey(): string {
  return crypto.randomUUID();
}

export function createOperatorApi(fetchImpl: FetchLike = fetch): OperatorApi {
  async function requestJson<T>(
    schema: v.GenericSchema<T>,
    path: string,
    options: SendOptions = {},
  ): Promise<T> {
    const { status, payload } = await send(fetchImpl, path, options);
    if (status < 200 || status >= 300) throw errorFor(status, payload);
    return parseOrThrow(schema, payload);
  }

  return {
    async register(input) {
      const body = await requestJson(
        v.strictObject({ user: authUserSchema }),
        '/auth/register',
        { method: 'POST', body: input },
      );
      return body.user;
    },

    async login(input) {
      return requestJson(sessionSchema, '/auth/login', { method: 'POST', body: input });
    },

    async me(token) {
      const body = await requestJson(v.strictObject({ user: authUserSchema }), '/auth/me', { token });
      return body.user;
    },

    async logout(token) {
      const { status, payload } = await send(fetchImpl, '/auth/logout', { method: 'POST', token });
      if (status < 200 || status >= 300) throw errorFor(status, payload);
    },

    async getWallet(token) {
      const body = await requestJson(walletSchema, '/wallet', { token });
      return { balanceCents: body.balance, currency: body.currency };
    },

    async getTransactions(token, query = {}) {
      return requestJson(ledgerPageSchema, '/wallet/transactions', {
        token,
        query: { limit: query.limit, cursor: query.cursor },
      });
    },

    async requestTopUp(token, input) {
      const body = await requestJson(topUpReceiptSchema, '/wallet/top-ups', {
        method: 'POST',
        token,
        idempotencyKey: input.idempotencyKey,
        body: { amount: input.amountCents },
      });
      return { transactionId: body.transactionId, balanceCents: body.balance, currency: body.currency };
    },

    async createPayout(token, input) {
      return requestJson(payoutSchema, '/payouts', {
        method: 'POST',
        token,
        idempotencyKey: input.idempotencyKey,
        body: { amount: input.amountCents },
      });
    },

    async getPayout(token, payoutId) {
      return requestJson(payoutSchema, `/payouts/${encodeURIComponent(payoutId)}`, { token });
    },

    async listPayouts(token, query = {}) {
      return requestJson(payoutPageSchema, '/payouts', {
        token,
        query: { limit: query.limit, cursor: query.cursor },
      });
    },

    async createSession(token) {
      await requestJson(sessionReadySchema, '/game/session', { method: 'POST', token });
    },

    async placeBet(token, input) {
      const { status, payload } = await send(fetchImpl, '/game/bets', {
        method: 'POST',
        token,
        idempotencyKey: input.idempotencyKey,
        body: {
          roundId: input.roundId,
          amount: input.amountCents,
          ...(input.autoCashoutHundredths === null
            ? {}
            : { autoCashout: input.autoCashoutHundredths / 100 }),
        },
      });
      return interpretCommand(status, payload);
    },

    async cashout(token, input) {
      const { status, payload } = await send(
        fetchImpl,
        `/game/bets/${encodeURIComponent(input.betId)}/cashout`,
        { method: 'POST', token, idempotencyKey: input.idempotencyKey },
      );
      return interpretCommand(status, payload);
    },

    async listBets(token, limit = 10) {
      const { status, payload } = await send(fetchImpl, '/game/bets', {
        token,
        query: { limit },
      });
      if (status < 200 || status >= 300) throw errorFor(status, payload);
      return parseOrThrow(v.array(betCommandResultSchema), payload);
    },

    async getCommand(token, commandId) {
      const { status, payload } = await send(
        fetchImpl,
        `/game/commands/${encodeURIComponent(commandId)}`,
        { token },
      );
      if (status === 404) return null;
      if (status < 200 || status >= 300) throw errorFor(status, payload);
      return parseOrThrow(betCommandResultSchema, payload);
    },

    async getBet(token, betId) {
      const { status, payload } = await send(
        fetchImpl,
        `/game/bets/${encodeURIComponent(betId)}`,
        { token },
      );
      if (status === 404) return null;
      if (status < 200 || status >= 300) throw errorFor(status, payload);
      return parseOrThrow(betCommandResultSchema, payload);
    },
  };
}
