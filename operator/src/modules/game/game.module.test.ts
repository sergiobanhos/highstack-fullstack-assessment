import { describe, expect, test } from 'bun:test';
import Fastify from 'fastify';
import { createLogger, loadConfig, type LoggerSink } from '../../config';
import type { OperatorDatabase } from '../../db';
import { UnauthenticatedError, type AuthModule } from '../auth/auth.module';
import type { FinancialModule } from '../financial/financial.module';
import { createGameModule } from './game.module';
import { GAME_EVENTS_ROUTE } from './game-events.controller';
import type { UpstreamSocket } from './crashsim-stream.client';

class InertSocket implements UpstreamSocket {
  closeCalls = 0;
  private openListener: (() => void) | null = null;
  private messageListener: ((raw: string) => void) | null = null;
  close(): void {
    this.closeCalls += 1;
  }
  onOpen(listener: () => void): void { this.openListener = listener; }
  onMessage(listener: (raw: string) => void): void { this.messageListener = listener; }
  onClose(): void {}
  onError(): void {}
  emitOpen(): void { this.openListener?.(); }
  emitMessage(raw: string): void { this.messageListener?.(raw); }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const silentLogger = () =>
  createLogger({
    level: 'error',
    sink: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    } satisfies LoggerSink,
  });

describe('createGameModule', () => {
  test('composes authenticated game commands and the Crashsim SSE route', async () => {
    const sockets: InertSocket[] = [];
    let betLookups = 0;
    const db = {
      select() {
        const query = {
          from() { return this; },
          where() { return this; },
          then(onFulfilled: (value: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) {
            betLookups += 1;
            return Promise.resolve([]).then(onFulfilled, onRejected);
          },
        };
        return query;
      },
    } as unknown as OperatorDatabase;
    const app = Fastify({ logger: false });
    const game = createGameModule({
      app,
      db,
      auth: {
        async requireUser() { throw new UnauthenticatedError(); },
      } satisfies Pick<AuthModule, 'requireUser'>,
      financial: {} as FinancialModule,
      config: loadConfig({
        DATABASE_URL: 'postgres://operator:local-password@127.0.0.1:5432/operator_test',
        APP_ENV: 'test',
        ENGINE_WEBHOOK_SECRET: 'test-webhook-secret',
      }),
      logger: silentLogger(),
      fetchImpl: (async () => new Response(JSON.stringify({
        roundId: 'r1', state: 'running', seq: 5, startedAt: 100, multiplier: 1.1, serverSeedHash: 'hash-r1',
      }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch,
      socketFactory: () => {
        const socket = new InertSocket();
        sockets.push(socket);
        return socket;
      },
    });
    expect(Object.keys(game).sort()).toEqual(['start', 'stop']);
    await app.ready();
    expect(app.hasRoute({ method: 'GET', url: GAME_EVENTS_ROUTE })).toBe(true);
    expect(app.hasRoute({ method: 'POST', url: '/game/session' })).toBe(true);
    expect(app.hasRoute({ method: 'POST', url: '/game/bets' })).toBe(true);
    expect(app.hasRoute({ method: 'GET', url: '/game/bets' })).toBe(true);
    expect(app.hasRoute({ method: 'GET', url: '/game/commands/:commandId' })).toBe(true);
    expect(app.hasRoute({ method: 'GET', url: '/game/bets/:betId' })).toBe(true);
    expect(app.hasRoute({ method: 'POST', url: '/game/bets/:betId/cashout' })).toBe(true);
    const unauthorized = await app.inject({ method: 'POST', url: '/game/session' });
    expect(unauthorized.statusCode).toBe(401);
    expect(sockets).toHaveLength(0);

    game.start();
    game.start();
    expect(sockets).toHaveLength(1);
    sockets[0]!.emitOpen();
    await flush();
    expect(betLookups).toBe(1);

    sockets[0]!.emitMessage(JSON.stringify({
      type: 'round.crashed', seq: 6,
      data: { roundId: 'r1', crashPoint: 2.5, serverSeed: 'seed-r1' },
    }));
    await flush();
    expect(betLookups).toBe(2);

    await game.stop();
    expect(sockets[0]?.closeCalls).toBe(1);
    await app.close();
  });
});
