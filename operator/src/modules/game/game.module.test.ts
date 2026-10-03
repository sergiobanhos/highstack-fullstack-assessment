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
    const game = createGameModule({
      config: loadConfig({}),
      logger: silentLogger(),
      socketFactory: () => {
        const socket = new InertSocket();
        sockets.push(socket);
        return socket;
      },
    });
    const app = Fastify({ logger: false });

    expect(Object.keys(game).sort()).toEqual(['registerRoutes', 'start', 'stop']);
    game.registerRoutes(app);
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
