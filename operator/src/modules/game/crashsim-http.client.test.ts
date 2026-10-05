import { describe, expect, test } from 'bun:test';
import {
  CrashsimHttpClient,
  CrashsimHttpError,
  type CrashsimHttpFailureKind,
} from './crashsim-http.client';

interface FetchCall {
  input: string | URL | Request;
  init?: RequestInit;
}

type FetchHandler = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function stubFetch(handler: FetchHandler): typeof fetch {
  return Object.assign(handler, { preconnect: () => undefined }) as unknown as typeof fetch;
}

function jsonFetch(status: number, payload: unknown) {
  const calls: FetchCall[] = [];
  const fetchImpl = stubFetch(async (input, init) => {
    calls.push({ input, init });
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
  return { fetchImpl, calls };
}

async function expectClientError(promise: Promise<unknown>, kind: CrashsimHttpFailureKind): Promise<CrashsimHttpError> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(CrashsimHttpError);
  expect((caught as CrashsimHttpError).kind).toBe(kind);
  return caught as CrashsimHttpError;
}

const client = (fetchImpl: typeof fetch) => new CrashsimHttpClient({
  baseUrl: 'http://crashsim.test/',
  operatorKey: 'server-only-operator-key',
  fetchImpl,
  timeoutMs: 25,
});

describe('Crashsim HTTP client', () => {
  test('creates a server-side session and sends bet fields without an idempotency header', async () => {
    const sessionResponse = jsonFetch(200, { sessionId: 'session_123' });
    const createdSession = await client(sessionResponse.fetchImpl).createSession('player-123');
    expect(createdSession).toEqual({ sessionId: 'session_123' });
    expect(String(sessionResponse.calls[0]?.input)).toBe('http://crashsim.test/players/player-123/session');
    expect(sessionResponse.calls[0]?.init?.method).toBe('POST');

    const betResponse = jsonFetch(200, {
      betId: 'bet_123',
      status: 'active',
      playerId: 'player-123',
      roundId: 'round-123',
      amount: 500,
      autoCashout: 1.5,
    });
    const result = await client(betResponse.fetchImpl).placeBet({
      sessionId: 'session_123',
      playerId: 'player-123',
      roundId: 'round-123',
      amount: 500,
      autoCashout: 1.5,
    });

    expect(result).toEqual({ betId: 'bet_123', status: 'active' });
    const call = betResponse.calls[0]!;
    const headers = new Headers(call.init?.headers);
    expect(String(call.input)).toBe('http://crashsim.test/bets');
    expect(headers.get('x-operator-key')).toBe('server-only-operator-key');
    expect(headers.has('idempotency-key')).toBe(false);
    expect(JSON.parse(String(call.init?.body))).toEqual({
      sessionId: 'session_123',
      roundId: 'round-123',
      amount: 500,
      autoCashout: 1.5,
    });
    expect(String(call.init?.body)).not.toContain('playerId');
    expect(call.init?.signal).toBeInstanceOf(AbortSignal);
  });

  test('validates bet identity and converts multiplier and safe payout to fixed-point values', async () => {
    const response = jsonFetch(200, {
      betId: 'bet_456',
      playerId: 'player-123',
      roundId: 'round-123',
      amount: 250,
      autoCashout: 1.25,
      status: 'cashed_out',
      multiplier: 1.5,
      payout: 375,
    });
    const bet = await client(response.fetchImpl).getBet({
      betId: 'bet_456',
      playerId: 'player-123',
      roundId: 'round-123',
    });

    expect(bet).toEqual({
      betId: 'bet_456',
      playerId: 'player-123',
      roundId: 'round-123',
      amount: 250,
      autoCashout: 1.25,
      status: 'cashed_out',
      multiplierHundredths: 150,
      payoutCents: 375,
      payoutPrecision: 'safe',
    });
    expect(String(response.calls[0]?.input)).toBe('http://crashsim.test/bets/bet_456');
  });

  test('cashout returns safe payout or explicitly marks unsafe payout without rounding', async () => {
    const safeResponse = jsonFetch(200, {
      betId: 'bet_789', status: 'cashed_out', multiplier: 2.25, payout: 1_125,
    });
    const safe = await client(safeResponse.fetchImpl).cashout({
      betId: 'bet_789', playerId: 'player-123', roundId: 'round-123',
    });
    expect(safe).toEqual({
      betId: 'bet_789',
      status: 'cashed_out',
      multiplierHundredths: 225,
      payoutCents: 1_125,
      payoutPrecision: 'safe',
    });
    expect(safeResponse.calls[0]?.init?.method).toBe('POST');

    const unsafeResponse = jsonFetch(200, {
      betId: 'bet_789', status: 'cashed_out', multiplier: 2.25, payout: Number.MAX_SAFE_INTEGER + 1,
    });
    const unsafe = await client(unsafeResponse.fetchImpl).cashout({ betId: 'bet_789' });
    expect(unsafe).toEqual({
      betId: 'bet_789',
      status: 'cashed_out',
      multiplierHundredths: 225,
      payoutCents: null,
      payoutPrecision: 'unsafe',
    });
  });

  test('recognizes only a validated session_not_found and insufficient-funds response', async () => {
    const missingSession = jsonFetch(404, { error: 'session_not_found' });
    await expectClientError(client(missingSession.fetchImpl).placeBet({
      sessionId: 'session_123', playerId: 'player-123', roundId: 'round-123', amount: 100,
    }), 'session_not_found');

    const malformedSessionError = jsonFetch(404, { error: 'session_not_found', status: 'mystery' });
    await expectClientError(client(malformedSessionError.fetchImpl).placeBet({
      sessionId: 'session_123', playerId: 'player-123', roundId: 'round-123', amount: 100,
    }), 'unknown');

    const inconsistentSessionError = jsonFetch(404, { error: 'session_not_found', status: 'active' });
    await expectClientError(client(inconsistentSessionError.fetchImpl).placeBet({
      sessionId: 'session_123', playerId: 'player-123', roundId: 'round-123', amount: 100,
    }), 'unknown');

    const insufficient = jsonFetch(402, {
      error: 'insufficient_funds', status: 'rejected', betId: 'bet_rejected',
    });
    await expectClientError(client(insufficient.fetchImpl).placeBet({
      sessionId: 'session_123', playerId: 'player-123', roundId: 'round-123', amount: 100,
    }), 'rejected');

    const incompleteDecline = jsonFetch(402, { error: 'insufficient_funds' });
    await expectClientError(client(incompleteDecline.fetchImpl).placeBet({
      sessionId: 'session_123', playerId: 'player-123', roundId: 'round-123', amount: 100,
    }), 'unknown');
  });

  test('keeps mutation outcomes unknown after timeout, 5xx, malformed JSON, or mismatched response', async () => {
    const sessionId = 'session-sensitive-value';
    const timeoutClient = client(stubFetch(async () => {
      throw new Error(`network failed with server-only-operator-key and ${sessionId}`);
    }));
    const timeout = await expectClientError(timeoutClient.placeBet({
      sessionId, playerId: 'player-123', roundId: 'round-123', amount: 100,
    }), 'unknown');
    expect(timeout.message).not.toContain('server-only-operator-key');
    expect(timeout.message).not.toContain(sessionId);

    await expectClientError(client(jsonFetch(502, {
      error: 'wallet_unavailable', message: `sensitive ${sessionId}`,
    }).fetchImpl).placeBet({
      sessionId, playerId: 'player-123', roundId: 'round-123', amount: 100,
    }), 'unknown');

    const invalidJsonFetch = stubFetch(async () => new Response('not json', { status: 200 }));
    await expectClientError(client(invalidJsonFetch).placeBet({
      sessionId, playerId: 'player-123', roundId: 'round-123', amount: 100,
    }), 'unknown');

    const mismatched = jsonFetch(200, {
      betId: 'bet_123', status: 'active', playerId: 'another-player', roundId: 'round-123',
    });
    await expectClientError(client(mismatched.fetchImpl).placeBet({
      sessionId, playerId: 'player-123', roundId: 'round-123', amount: 100,
    }), 'unknown');
  });

  test('classifies structured cashout conflicts and missing bets; malformed result remains unknown', async () => {
    const conflict = jsonFetch(409, { error: 'bet_not_active', status: 'lost' });
    await expectClientError(client(conflict.fetchImpl).cashout({ betId: 'bet_123' }), 'conflict');

    const missing = jsonFetch(404, { error: 'bet_not_found' });
    await expectClientError(client(missing.fetchImpl).getBet({ betId: 'bet_123' }), 'not_found');

    const invalidPayout = jsonFetch(200, {
      betId: 'bet_123', status: 'cashed_out', multiplier: 1.25, payout: 250.5,
    });
    await expectClientError(client(invalidPayout.fetchImpl).cashout({ betId: 'bet_123' }), 'unknown');

    const identityMismatch = jsonFetch(200, {
      betId: 'other-bet', playerId: 'player-123', roundId: 'round-123', amount: 250, status: 'active',
    });
    await expectClientError(client(identityMismatch.fetchImpl).getBet({ betId: 'bet_123' }), 'unavailable');
  });

  test('rejects invalid local inputs before any engine request', async () => {
    const response = jsonFetch(200, { betId: 'bet_123', status: 'active' });
    const httpClient = client(response.fetchImpl);
    await expectClientError(httpClient.createSession('player/id'), 'rejected');
    await expectClientError(httpClient.placeBet({
      sessionId: 'session_123', playerId: 'player-123', roundId: 'round-123', amount: Number.MAX_SAFE_INTEGER + 1,
    }), 'rejected');
    await expectClientError(httpClient.placeBet({
      sessionId: 'session_123', playerId: 'player-123', roundId: 'round-123', amount: 100, autoCashout: 1.001,
    }), 'rejected');
    expect(response.calls).toHaveLength(0);
  });
});
