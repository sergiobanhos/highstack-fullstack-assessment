import { describe, expect, test } from 'bun:test';
import {
  createOperatorApi,
  isTerminalRefusal,
  isUnauthenticated,
  OperatorApiError,
  type BetCommandResult,
} from './operator-api';

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function stubFetch(handler: (request: RecordedRequest) => Response | Promise<Response>) {
  const calls: RecordedRequest[] = [];
  const fetchImpl = async (input: string, init: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    const request: RecordedRequest = {
      url: input,
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : (JSON.parse(String(init.body)) as unknown),
    };
    calls.push(request);
    return handler(request);
  };
  return { api: createOperatorApi(fetchImpl), calls, fetchImpl };
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const text = (status: number, body: string, contentType = 'text/plain'): Response =>
  new Response(body, { status, headers: { 'content-type': contentType } });

const betCommand: BetCommandResult = {
  commandId: 'cmd-1',
  roundId: 'round-1',
  amountCents: 2500,
  autoCashoutHundredths: 250,
  betCommandStatus: 'accepted',
  resultCode: null,
  betId: 'bet-1',
  bet: {
    betId: 'bet-1',
    engineStatus: 'active',
    multiplierHundredths: null,
    payoutCents: null,
    settlementStatus: 'not_applicable',
  },
};

describe('authentication calls', () => {
  test('login sends JSON and maps the session', async () => {
    const { api, calls } = stubFetch(() =>
      json(200, {
        token: 'tok-1',
        expiresAt: '2026-10-06T00:00:00.000Z',
        user: { id: 'p1', name: 'Ana', email: 'ana@example.com' },
      }),
    );
    const session = await api.login({ email: 'ana@example.com', password: 'senha-bem-longa' });

    expect(session.token).toBe('tok-1');
    expect(session.user.name).toBe('Ana');
    expect(calls[0]?.url).toBe('/auth/login');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.headers['content-type']).toBe('application/json');
    expect(calls[0]?.body).toEqual({ email: 'ana@example.com', password: 'senha-bem-longa' });
  });

  test('authenticated calls carry the bearer token', async () => {
    const { api, calls } = stubFetch(() => json(200, { user: { id: 'p1', name: 'Ana', email: 'a@b.c' } }));
    await api.me('tok-1');
    expect(calls[0]?.headers.authorization).toBe('Bearer tok-1');
  });

  test('logout accepts 204 without a body', async () => {
    const { api, calls } = stubFetch(() => new Response(null, { status: 204 }));
    await expect(api.logout('tok-1')).resolves.toBeUndefined();
    expect(calls[0]?.url).toBe('/auth/logout');
  });

  test('maps an unauthenticated response to a typed error', async () => {
    const { api } = stubFetch(() =>
      json(401, { error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } }),
    );
    const failure = api.me('tok-expired').catch((error: unknown) => error);

    const error = await failure;
    expect(error).toBeInstanceOf(OperatorApiError);
    expect(isUnauthenticated(error)).toBe(true);
    expect((error as OperatorApiError).code).toBe('UNAUTHENTICATED');
    expect((error as OperatorApiError).message).toBe('Authentication required');
  });
});

describe('error mapping', () => {
  test('a non-envelope 404 becomes a safe generic message', async () => {
    const { api } = stubFetch(() =>
      text(404, JSON.stringify({ message: 'Route GET:/payouts not found', error: 'Not Found', statusCode: 404 }), 'application/json'),
    );
    const error = (await api.listPayouts('tok').catch((failure: unknown) => failure)) as OperatorApiError;

    expect(error.kind).toBe('http');
    expect(error.status).toBe(404);
    expect(error.code).toBeNull();
    expect(error.message).not.toContain('payouts not found');
    expect(error.message).not.toContain('Route');
  });

  test('network failures are distinguished from HTTP failures', async () => {
    const failing = (_input: string, _init: RequestInit): Promise<Response> =>
      Promise.reject(new TypeError('Failed to fetch'));
    const api = createOperatorApi(failing);
    const error = (await api.getWallet('tok').catch((failure: unknown) => failure)) as OperatorApiError;

    expect(error.kind).toBe('network');
    expect(error.status).toBeNull();
  });

  test('malformed success bodies are rejected instead of trusted', async () => {
    const { api } = stubFetch(() => json(200, { balance: 'lots' }));
    const error = (await api.getWallet('tok').catch((failure: unknown) => failure)) as OperatorApiError;
    expect(error.kind).toBe('invalid-response');
  });
});

describe('isTerminalRefusal', () => {
  const http = (status: number): OperatorApiError =>
    new OperatorApiError('http', status, 'CODE', 'message');

  test('treats definitive pre-commit refusals as terminal', () => {
    for (const status of [400, 402, 404, 409, 422, 429]) {
      expect(isTerminalRefusal(http(status))).toBe(true);
    }
  });

  test('keeps 503 non-terminal because it can arrive after a committed debit', () => {
    // `POST /payouts` commits and then re-reads; a failure there maps to 503.
    expect(isTerminalRefusal(http(503))).toBe(false);
    for (const status of [401, 403, 500, 502, 504]) {
      expect(isTerminalRefusal(http(status))).toBe(false);
    }
  });

  test('network and unparseable responses never consume the key', () => {
    expect(isTerminalRefusal(new OperatorApiError('network', null, null, 'offline'))).toBe(false);
    expect(isTerminalRefusal(new OperatorApiError('invalid-response', null, null, 'weird'))).toBe(false);
    expect(isTerminalRefusal(new Error('boom'))).toBe(false);
    expect(isTerminalRefusal(null)).toBe(false);
  });
});

describe('wallet calls', () => {
  test('reads the wallet balance in cents', async () => {
    const { api } = stubFetch(() => json(200, { balance: 1234, currency: 'USD' }));
    await expect(api.getWallet('tok')).resolves.toEqual({ balanceCents: 1234, currency: 'USD' });
  });

  test('sends cursor pagination and maps ledger items', async () => {
    const { api, calls } = stubFetch(() =>
      json(200, {
        items: [
          {
            id: 'l1',
            operationId: 'o1',
            direction: 'credit',
            source: 'test',
            amountCents: 1000,
            balanceAfterCents: 1000,
            betId: null,
            roundId: null,
            createdAt: '2026-10-05T10:20:30.123456Z',
            currency: 'USD',
          },
        ],
        nextCursor: 'cursor-1',
      }),
    );
    const page = await api.getTransactions('tok', { limit: 25, cursor: 'cursor-0' });

    expect(page.items[0]?.amountCents).toBe(1000);
    expect(page.nextCursor).toBe('cursor-1');
    expect(calls[0]?.url).toBe('/wallet/transactions?limit=25&cursor=cursor-0');
  });

  test('top-up sends the idempotency key and integer cents', async () => {
    const { api, calls } = stubFetch(() =>
      json(201, { transactionId: 'tx-1', balance: 3500, currency: 'USD' }),
    );
    const receipt = await api.requestTopUp('tok', { amountCents: 2500, idempotencyKey: 'key-1' });

    expect(receipt).toEqual({ transactionId: 'tx-1', balanceCents: 3500, currency: 'USD' });
    expect(calls[0]?.headers['idempotency-key']).toBe('key-1');
    expect(calls[0]?.body).toEqual({ amount: 2500 });
  });
});

describe('payout calls', () => {
  test('creates, reads, and lists payouts', async () => {
    const payout = {
      id: 'pay-1',
      amountCents: 500,
      currency: 'USD',
      status: 'processing',
      requestedAt: '2026-10-05T10:20:30.123456Z',
      completedAt: null,
      simulated: true,
    };
    const { api, calls } = stubFetch((request) => {
      if (request.method === 'POST') return json(201, payout);
      if (request.url.startsWith('/payouts/pay-1')) return json(200, { ...payout, status: 'done', completedAt: '2026-10-05T10:20:31.123456Z' });
      return json(200, { items: [payout], nextCursor: null });
    });

    const created = await api.createPayout('tok', { amountCents: 500, idempotencyKey: 'key-2' });
    expect(created.status).toBe('processing');

    const read = await api.getPayout('tok', 'pay-1');
    expect(read.status).toBe('done');

    const page = await api.listPayouts('tok', { limit: 50 });
    expect(page.items).toHaveLength(1);
    expect(calls[0]?.body).toEqual({ amount: 500 });
    expect(calls[1]?.url).toBe('/payouts/pay-1');
    expect(calls[2]?.url).toBe('/payouts?limit=50');
  });

  test('a payout 402 keeps the operator message and code', async () => {
    const { api } = stubFetch(() =>
      json(402, { error: { code: 'INSUFFICIENT_FUNDS', message: 'Wallet balance is insufficient' } }),
    );
    const error = (await api.createPayout('tok', { amountCents: 99, idempotencyKey: 'key-3' })
      .catch((failure: unknown) => failure)) as OperatorApiError;
    expect(error.status).toBe(402);
    expect(error.code).toBe('INSUFFICIENT_FUNDS');
  });
});

describe('game command calls', () => {
  test('place bet sends round, integer cents, and decimal auto-cashout', async () => {
    const { api, calls } = stubFetch(() => json(201, betCommand));
    const outcome = await api.placeBet('tok', {
      roundId: 'round-1',
      amountCents: 2500,
      autoCashoutHundredths: 250,
      idempotencyKey: 'key-4',
    });

    expect(outcome.kind).toBe('accepted');
    if (outcome.kind === 'accepted') expect(outcome.command.betId).toBe('bet-1');
    expect(calls[0]?.body).toEqual({ roundId: 'round-1', amount: 2500, autoCashout: 2.5 });
    expect(calls[0]?.headers['idempotency-key']).toBe('key-4');
  });

  test('omits auto-cashout when not requested', async () => {
    const { api, calls } = stubFetch(() => json(201, betCommand));
    await api.placeBet('tok', { roundId: 'round-1', amountCents: 100, autoCashoutHundredths: null, idempotencyKey: 'key-5' });
    expect(calls[0]?.body).toEqual({ roundId: 'round-1', amount: 100 });
  });

  test('a 202 result is an unknown outcome with the command snapshot', async () => {
    const { api } = stubFetch(() =>
      json(202, {
        error: { code: 'COMMAND_OUTCOME_UNKNOWN', message: 'Command outcome is still being reconciled' },
        command: { ...betCommand, betCommandStatus: 'unknown', bet: null, betId: null },
      }),
    );
    const outcome = await api.placeBet('tok', { roundId: 'round-1', amountCents: 100, autoCashoutHundredths: null, idempotencyKey: 'key-6' });

    expect(outcome.kind).toBe('unknown');
    if (outcome.kind === 'unknown') expect(outcome.command?.commandId).toBe('cmd-1');
  });

  test('a rejected command keeps the error and the command snapshot', async () => {
    const { api } = stubFetch(() =>
      json(402, {
        error: { code: 'INSUFFICIENT_FUNDS', message: 'Wallet balance is insufficient' },
        command: { ...betCommand, betCommandStatus: 'rejected', resultCode: 'insufficient_funds', bet: null, betId: null },
      }),
    );
    const outcome = await api.placeBet('tok', { roundId: 'round-1', amountCents: 100, autoCashoutHundredths: null, idempotencyKey: 'key-7' });

    expect(outcome.kind).toBe('rejected');
    if (outcome.kind === 'rejected') {
      expect(outcome.error.code).toBe('INSUFFICIENT_FUNDS');
      expect(outcome.command?.resultCode).toBe('insufficient_funds');
    }
  });

  test('a 2xx body without a parseable command is treated as unknown, not success', async () => {
    const { api } = stubFetch(() => json(201, { unexpected: true }));
    const outcome = await api.placeBet('tok', { roundId: 'round-1', amountCents: 100, autoCashoutHundredths: null, idempotencyKey: 'key-8' });
    expect(outcome).toEqual({ kind: 'unknown', command: null });
  });

  test('lists bets and maps 404 lookups to null', async () => {
    const { api, calls } = stubFetch((request) => {
      if (request.url.startsWith('/game/commands/')) return json(404, { error: { code: 'COMMAND_NOT_FOUND', message: 'Command was not found' } });
      if (request.url.startsWith('/game/bets/')) return json(404, { error: { code: 'BET_NOT_FOUND', message: 'Bet was not found' } });
      return json(200, [betCommand]);
    });

    const bets = await api.listBets('tok', 10);
    expect(bets).toHaveLength(1);
    expect(calls[0]?.url).toBe('/game/bets?limit=10');

    await expect(api.getCommand('tok', 'cmd-1')).resolves.toBeNull();
    await expect(api.getBet('tok', 'bet-1')).resolves.toBeNull();
  });

  test('cashout posts to the bet path with an idempotency key', async () => {
    const { api, calls } = stubFetch(() => json(200, betCommand));
    const outcome = await api.cashout('tok', { betId: 'bet-1', idempotencyKey: 'key-9' });
    expect(outcome.kind).toBe('accepted');
    expect(calls[0]?.url).toBe('/game/bets/bet-1/cashout');
    expect(calls[0]?.headers['idempotency-key']).toBe('key-9');
  });

  test('session creation requires the ready contract', async () => {
    const { api } = stubFetch(() => json(200, { status: 'starting' }));
    const error = (await api.createSession('tok').catch((failure: unknown) => failure)) as OperatorApiError;
    expect(error.kind).toBe('invalid-response');
  });

  test('url-encodes ids in paths', async () => {
    const { api, calls } = stubFetch(() => json(404, { error: { code: 'BET_NOT_FOUND', message: 'Bet was not found' } }));
    await api.getBet('tok', 'bet/../1');
    expect(calls[0]?.url).toBe('/game/bets/bet%2F..%2F1');
  });
});
