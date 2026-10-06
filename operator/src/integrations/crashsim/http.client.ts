import * as v from 'valibot';
import type { CrashsimRoundSnapshot } from './contracts';

export interface CrashsimHttpClientDeps {
  /** Engine base URL, without a trailing slash. */
  baseUrl: string;
  /** Server-only operator key; sent as `x-operator-key`. */
  operatorKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export type CrashsimBetStatus = 'active' | 'lost' | 'cashed_out' | 'rejected';
export type CrashsimMutationStatus = 'active' | 'lost' | 'cashed_out';
export type CrashsimHttpFailureKind =
  | 'rejected'
  | 'conflict'
  | 'unavailable'
  | 'unknown'
  | 'session_not_found'
  | 'not_found';

export class CrashsimHttpError extends Error {
  constructor(
    readonly kind: CrashsimHttpFailureKind,
    readonly statusCode?: number,
    readonly engineCode?: string,
  ) {
    super(`Crashsim request ${kind.replaceAll('_', ' ')}`);
    this.name = 'CrashsimHttpError';
  }
}

export interface CreateSessionResult {
  sessionId: string;
}

export interface PlaceBetInput {
  /** Server-only Crashsim session; it is never included in a public response. */
  sessionId: string;
  playerId: string;
  roundId: string;
  amount: number;
  autoCashout?: number;
}

export interface PlaceBetResult {
  betId: string;
  status: Extract<CrashsimBetStatus, 'active' | 'lost'>;
}

export interface CrashsimBet {
  betId: string;
  playerId: string;
  roundId: string;
  amount: number;
  status: CrashsimBetStatus;
  autoCashout?: number;
  multiplierHundredths: number | null;
  payoutCents: number | null;
  payoutPrecision: 'not_provided' | 'safe' | 'unsafe';
}

export interface CashoutInput {
  betId: string;
  playerId?: string;
  roundId?: string;
}

export interface CashoutResult {
  betId: string;
  status: 'cashed_out';
  multiplierHundredths: number;
  payoutCents: number | null;
  payoutPrecision: 'safe' | 'unsafe';
}

const DEFAULT_TIMEOUT_MS = 3_000;
const MAX_BET_CENTS = 1_000_000_000;
const MAX_AUTO_CASHOUT = 1_000_000;
const ENGINE_ID_PATTERN = /^[A-Za-z0-9_-]{1,255}$/;
const PLAYER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const isEngineId = (value: string): boolean => ENGINE_ID_PATTERN.test(value);
const isPlayerId = (value: string): boolean => PLAYER_ID_PATTERN.test(value);
const isFiniteNumber = (value: number): boolean => Number.isFinite(value);
const isSafeInteger = (value: number): boolean => Number.isSafeInteger(value);
const hasTwoDecimalPlaces = (value: number): boolean => {
  const hundredths = Math.round(value * 100);
  return Number.isSafeInteger(hundredths) && Math.abs(value * 100 - hundredths) < 1e-7;
};

const engineIdSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(255),
  v.check(isEngineId, 'invalid engine identifier'),
);
const playerIdSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(64),
  v.check(isPlayerId, 'invalid player identifier'),
);
const roundIdSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(255));
const finiteNumberSchema = v.pipe(v.number(), v.check(isFiniteNumber, 'must be finite'));
const multiplierSchema = v.pipe(
  finiteNumberSchema,
  v.minValue(1),
  v.check(hasTwoDecimalPlaces, 'must have at most two decimal places'),
);
const autoCashoutSchema = v.pipe(
  finiteNumberSchema,
  v.minValue(1.01),
  v.maxValue(MAX_AUTO_CASHOUT),
  v.check(hasTwoDecimalPlaces, 'must have at most two decimal places'),
);
const amountSchema = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(1),
  v.maxValue(MAX_BET_CENTS),
  v.check(isSafeInteger, 'must be a safe integer'),
);

const roundStateSchema = v.object({
  roundId: roundIdSchema,
  state: v.picklist(['betting', 'running', 'crashed']),
  seq: v.pipe(v.number(), v.integer(), v.minValue(0), v.check(isSafeInteger)),
  serverSeedHash: v.optional(v.string()),
  bettingEndsAt: v.optional(finiteNumberSchema),
  startedAt: v.optional(finiteNumberSchema),
  multiplier: v.optional(multiplierSchema),
  crashPoint: v.optional(multiplierSchema),
  serverSeed: v.optional(v.string()),
});

const betStatusSchema = v.picklist(['active', 'lost', 'cashed_out', 'rejected']);
const placeBetSuccessSchema = v.object({
  betId: engineIdSchema,
  status: v.picklist(['active', 'lost']),
  playerId: v.optional(playerIdSchema),
  roundId: v.optional(roundIdSchema),
  amount: v.optional(amountSchema),
  autoCashout: v.optional(autoCashoutSchema),
});
const betRecordSchema = v.object({
  betId: engineIdSchema,
  playerId: playerIdSchema,
  roundId: roundIdSchema,
  amount: amountSchema,
  status: betStatusSchema,
  autoCashout: v.optional(autoCashoutSchema),
  multiplier: v.optional(multiplierSchema),
  payout: v.optional(finiteNumberSchema),
});
const cashoutSuccessSchema = v.object({
  betId: engineIdSchema,
  status: v.literal('cashed_out'),
  multiplier: multiplierSchema,
  payout: finiteNumberSchema,
  playerId: v.optional(playerIdSchema),
  roundId: v.optional(roundIdSchema),
});

const errorCodeSchema = v.picklist([
  'unauthorized',
  'invalid_request',
  'body_too_large',
  'not_found',
  'session_not_found',
  'insufficient_funds',
  'wallet_unavailable',
  'betting_closed',
  'bet_not_found',
  'bet_not_active',
  'round_not_running',
  'internal_error',
]);
const errorResponseSchema = v.object({
  error: errorCodeSchema,
  status: v.optional(betStatusSchema),
  betId: v.optional(engineIdSchema),
});

const issuePaths = (issues: readonly v.BaseIssue<unknown>[]): string =>
  issues.map((issue) => issue.path?.map((segment) => String(segment.key)).join('.') ?? '(root)').join(',');

function invalidResponse(kind: 'unavailable' | 'unknown', statusCode?: number, fields?: string): CrashsimHttpError {
  return new CrashsimHttpError(kind, statusCode, fields ? `invalid_response:${fields}` : 'invalid_response');
}

interface PayoutResult {
  payoutCents: number | null;
  payoutPrecision: CrashsimBet['payoutPrecision'];
}

interface ProvidedPayoutResult {
  payoutCents: number | null;
  payoutPrecision: 'safe' | 'unsafe';
}

function payoutResult(payout: number): ProvidedPayoutResult;
function payoutResult(payout: number | undefined): PayoutResult;
function payoutResult(payout: number | undefined): PayoutResult {
  if (payout === undefined) return { payoutCents: null, payoutPrecision: 'not_provided' };
  if (!Number.isInteger(payout) || payout < 0) {
    throw new CrashsimHttpError('unknown', undefined, 'invalid_payout');
  }
  if (!Number.isSafeInteger(payout)) return { payoutCents: null, payoutPrecision: 'unsafe' };
  return { payoutCents: payout, payoutPrecision: 'safe' };
}

function multiplierHundredths(multiplier: number | undefined): number | null {
  if (multiplier === undefined) return null;
  const hundredths = Math.round(multiplier * 100);
  if (!Number.isSafeInteger(hundredths) || Math.abs(multiplier * 100 - hundredths) >= 1e-7) {
    throw new CrashsimHttpError('unknown', undefined, 'invalid_multiplier_precision');
  }
  return hundredths;
}

/** Direct Crashsim HTTP client. The engine key and session IDs stay server-side. */
export class CrashsimHttpClient {
  private readonly timeoutMs: number;
  private readonly baseUrl: string;

  constructor(private readonly deps: CrashsimHttpClientDeps) {
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.baseUrl = deps.baseUrl.replace(/\/+$/, '');
  }

  /** Reads current state only; the engine has no historical replay endpoint. */
  async getCurrentRound(): Promise<CrashsimRoundSnapshot> {
    const { response, payload } = await this.exchange('/rounds/current', 'GET', undefined, 'unavailable');
    if (!response.ok) throw new Error(`engine snapshot request failed with status ${response.status}`);

    const parsed = v.safeParse(roundStateSchema, payload);
    if (!parsed.success) throw new Error(`invalid engine snapshot: ${issuePaths(parsed.issues)}`);
    return parsed.output;
  }

  async createSession(playerId: string): Promise<CreateSessionResult> {
    if (!isPlayerId(playerId)) throw new CrashsimHttpError('rejected', undefined, 'invalid_player_id');
    const { response, payload } = await this.exchange(
      `/players/${encodeURIComponent(playerId)}/session`,
      'POST',
      undefined,
      'unavailable',
    );
    if (response.status !== 200) throw new CrashsimHttpError('unavailable', response.status);

    const parsed = v.safeParse(v.object({ sessionId: engineIdSchema }), payload);
    if (!parsed.success) throw invalidResponse('unavailable', response.status, issuePaths(parsed.issues));
    return { sessionId: parsed.output.sessionId };
  }

  async placeBet(input: PlaceBetInput): Promise<PlaceBetResult> {
    this.validatePlaceBetInput(input);
    const body = {
      sessionId: input.sessionId,
      roundId: input.roundId,
      amount: input.amount,
      ...(input.autoCashout === undefined ? {} : { autoCashout: input.autoCashout }),
    };
    const { response, payload } = await this.exchange('/bets', 'POST', body, 'unknown');

    if (!response.ok) {
      const engineError = v.safeParse(errorResponseSchema, payload);
      if (!engineError.success) throw new CrashsimHttpError('unknown', response.status);
      const { error, status, betId } = engineError.output;

      if (response.status === 404 && error === 'session_not_found') {
        if (status === undefined && betId === undefined) {
          throw new CrashsimHttpError('session_not_found', response.status, error);
        }
        throw new CrashsimHttpError('unknown', response.status);
      }
      if (response.status === 402) {
        if (error === 'insufficient_funds' && status === 'rejected' && betId) {
          throw new CrashsimHttpError('rejected', response.status, error);
        }
        throw new CrashsimHttpError('unknown', response.status);
      }
      if (response.status >= 500) throw new CrashsimHttpError('unknown', response.status);
      if (response.status === 409 && error === 'betting_closed') {
        throw new CrashsimHttpError('conflict', response.status, error);
      }
      if (response.status >= 400 && response.status < 500) {
        throw new CrashsimHttpError('rejected', response.status, error);
      }
      throw new CrashsimHttpError('unknown', response.status);
    }

    const parsed = v.safeParse(placeBetSuccessSchema, payload);
    if (!parsed.success) throw invalidResponse('unknown', response.status, issuePaths(parsed.issues));
    if ((parsed.output.playerId !== undefined && parsed.output.playerId !== input.playerId) ||
        (parsed.output.roundId !== undefined && parsed.output.roundId !== input.roundId) ||
        (parsed.output.amount !== undefined && parsed.output.amount !== input.amount) ||
        (parsed.output.autoCashout !== undefined && parsed.output.autoCashout !== input.autoCashout)) {
      throw new CrashsimHttpError('unknown', response.status, 'bet_identity_mismatch');
    }

    return { betId: parsed.output.betId, status: parsed.output.status };
  }

  async getBet(input: { betId: string; playerId?: string; roundId?: string }): Promise<CrashsimBet> {
    if (!isEngineId(input.betId)) throw new CrashsimHttpError('rejected', undefined, 'invalid_bet_id');
    const { response, payload } = await this.exchange(
      `/bets/${encodeURIComponent(input.betId)}`,
      'GET',
      undefined,
      'unavailable',
    );

    if (!response.ok) {
      const engineError = v.safeParse(errorResponseSchema, payload);
      if (response.status === 404 && engineError.success && engineError.output.error === 'bet_not_found') {
        throw new CrashsimHttpError('not_found', response.status, 'bet_not_found');
      }
      throw new CrashsimHttpError('unavailable', response.status);
    }

    const parsed = v.safeParse(betRecordSchema, payload);
    if (!parsed.success) throw invalidResponse('unavailable', response.status, issuePaths(parsed.issues));
    if (parsed.output.betId !== input.betId ||
        (input.playerId !== undefined && parsed.output.playerId !== input.playerId) ||
        (input.roundId !== undefined && parsed.output.roundId !== input.roundId)) {
      throw new CrashsimHttpError('unavailable', response.status, 'bet_identity_mismatch');
    }

    const payout = payoutResult(parsed.output.payout);
    return {
      betId: parsed.output.betId,
      playerId: parsed.output.playerId,
      roundId: parsed.output.roundId,
      amount: parsed.output.amount,
      status: parsed.output.status,
      ...(parsed.output.autoCashout === undefined ? {} : { autoCashout: parsed.output.autoCashout }),
      multiplierHundredths: multiplierHundredths(parsed.output.multiplier),
      ...payout,
    };
  }

  async cashout(input: CashoutInput): Promise<CashoutResult> {
    if (!isEngineId(input.betId)) throw new CrashsimHttpError('rejected', undefined, 'invalid_bet_id');
    const { response, payload } = await this.exchange(
      `/bets/${encodeURIComponent(input.betId)}/cashout`,
      'POST',
      undefined,
      'unknown',
    );

    if (!response.ok) {
      const engineError = v.safeParse(errorResponseSchema, payload);
      if (!engineError.success) throw new CrashsimHttpError('unknown', response.status);
      const { error } = engineError.output;
      if (response.status === 404 && error === 'bet_not_found') {
        throw new CrashsimHttpError('not_found', response.status, error);
      }
      if (response.status >= 500) throw new CrashsimHttpError('unknown', response.status);
      if (response.status === 409 && ['bet_not_active', 'round_not_running'].includes(error)) {
        throw new CrashsimHttpError('conflict', response.status, error);
      }
      if (response.status >= 400 && response.status < 500) {
        throw new CrashsimHttpError('rejected', response.status, error);
      }
      throw new CrashsimHttpError('unknown', response.status);
    }

    const parsed = v.safeParse(cashoutSuccessSchema, payload);
    if (!parsed.success) throw invalidResponse('unknown', response.status, issuePaths(parsed.issues));
    if (parsed.output.betId !== input.betId ||
        (input.playerId !== undefined && parsed.output.playerId !== undefined && parsed.output.playerId !== input.playerId) ||
        (input.roundId !== undefined && parsed.output.roundId !== undefined && parsed.output.roundId !== input.roundId)) {
      throw new CrashsimHttpError('unknown', response.status, 'bet_identity_mismatch');
    }

    const payout = payoutResult(parsed.output.payout);
    return {
      betId: parsed.output.betId,
      status: parsed.output.status,
      multiplierHundredths: multiplierHundredths(parsed.output.multiplier)!,
      ...payout,
    };
  }

  private validatePlaceBetInput(input: PlaceBetInput): void {
    if (!isEngineId(input.sessionId) || !isPlayerId(input.playerId) || !isEngineId(input.roundId) ||
        !Number.isSafeInteger(input.amount) || input.amount < 1 || input.amount > MAX_BET_CENTS ||
        (input.autoCashout !== undefined && (
          !Number.isFinite(input.autoCashout) ||
          input.autoCashout < 1.01 ||
          input.autoCashout > MAX_AUTO_CASHOUT ||
          !hasTwoDecimalPlaces(input.autoCashout)
        ))) {
      throw new CrashsimHttpError('rejected', undefined, 'invalid_bet_input');
    }
  }

  private async exchange(
    path: string,
    method: 'GET' | 'POST',
    body: Record<string, unknown> | undefined,
    failureKind: 'unavailable' | 'unknown',
  ): Promise<{ response: Response; payload: unknown }> {
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    let response: Response;
    try {
      response = await fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          'x-operator-key': this.deps.operatorKey,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new CrashsimHttpError(failureKind);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new CrashsimHttpError(failureKind, response.status);
    }
    return { response, payload };
  }
}
