import { describe, expect, test } from 'bun:test';
import Fastify from 'fastify';
import { createLogger, loadConfig, type LoggerSink } from '../../config';
import { createGameModule } from './game.module';
import { GAME_EVENTS_ROUTE } from './game-events.controller';
import type { UpstreamSocket } from './crashsim-stream.client';

class InertSocket implements UpstreamSocket {
  closeCalls = 0;
  close(): void {
    this.closeCalls += 1;
  }
  onOpen(): void {}
  onMessage(): void {}
  onClose(): void {}
  onError(): void {}
}

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
  test('exposes only the Crashsim lifecycle and registers /game/events', async () => {
    const sockets: InertSocket[] = [];
    const app = Fastify({ logger: false });
    const game = createGameModule({
      app,
      config: loadConfig({
        DATABASE_URL: 'postgres://operator:local-password@127.0.0.1:5432/operator_test',
        APP_ENV: 'test',
        ENGINE_WEBHOOK_SECRET: 'test-webhook-secret',
      }),
      logger: silentLogger(),
      socketFactory: () => {
        const socket = new InertSocket();
        sockets.push(socket);
        return socket;
      },
    });
    expect(Object.keys(game).sort()).toEqual(['start', 'stop']);
    await app.ready();
    expect(app.hasRoute({ method: 'GET', url: GAME_EVENTS_ROUTE })).toBe(true);
    expect(sockets).toHaveLength(0);

    game.start();
    game.start();
    expect(sockets).toHaveLength(1);

    await game.stop();
    expect(sockets[0]?.closeCalls).toBe(1);
    await app.close();
  });
});
