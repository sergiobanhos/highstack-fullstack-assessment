import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { createLogger, createRedactor, type LoggerSink } from '../../../config';
import { GameEventFanout } from '../realtime/event-fanout';
import {
  applySnapshot,
  type GameEvent,
  type ConnectionState,
  type OperatorMessage,
  type OperatorSnapshot,
  type RoundState,
} from '../realtime/round-state';
import type { GameEventSubscription } from '../realtime/contracts';
import { GAME_EVENTS_ROUTE, handleGameEvents, registerGameEventsRoute } from './events.controller';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const waitFor = async (predicate: () => boolean, timeoutMs = 1_000): Promise<void> => {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('condition not met in time');
    await flush();
  }
};

const asRecord = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;

const buildState = (overrides: Partial<Parameters<typeof applySnapshot>[0]> = {}): RoundState =>
  applySnapshot({
    roundId: 'r1',
    state: 'running',
    seq: 5,
    startedAt: 100,
    multiplier: 1.2,
    serverSeedHash: 'h1',
    ...overrides,
  });

const tickEvent = (seq: number, multiplier: number): GameEvent => ({
  type: 'tick',
  seq,
  roundId: 'r1',
  multiplier,
  t: seq * 100,
});

const makeRuntime = (
  state: RoundState,
  connection: ConnectionState,
  hub: GameEventFanout,
  onSnapshot?: () => void,
): { subscribe(): GameEventSubscription } => ({
  subscribe: () => hub.subscribeWithSnapshot((): OperatorSnapshot => {
      onSnapshot?.();
      return { state, connection };
    }),
});

const captureLogger = () => {
  const logs: string[] = [];
  const logger = createLogger({
    level: 'debug',
    redactor: createRedactor([]),
    sink: {
      debug: (line: string) => logs.push(line),
      info: (line: string) => logs.push(line),
      warn: (line: string) => logs.push(line),
      error: (line: string) => logs.push(line),
    } satisfies LoggerSink,
  });
  return { logger, logs };
};

interface SseFrame {
  event?: string;
  data: unknown;
}

/** Structural read loop so the test does not depend on a specific stream lib type. */
interface SseBodyReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
}

/** Minimal SSE frame reader over a fetch response body. */
class SseReader {
  private readonly reader: SseBodyReader;
  private readonly decoder = new TextDecoder();
  private buffer = '';

  constructor(response: Response) {
    if (!response.body) throw new Error('response has no body');
    this.reader = response.body.getReader() as SseBodyReader;
  }

  async next(): Promise<SseFrame> {
    for (;;) {
      const end = this.buffer.indexOf('\n\n');
      if (end !== -1) {
        const frame = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 2);
        return parseFrame(frame);
      }
      const chunk = await this.reader.read();
      if (chunk.done) throw new Error('sse stream ended');
      this.buffer += this.decoder.decode(chunk.value, { stream: true });
    }
  }
}

const parseFrame = (frame: string): SseFrame => {
  let event: string | undefined;
  let data = '';
  for (const line of frame.split('\n')) {
    if (line.startsWith('event: ')) event = line.slice('event: '.length);
    else if (line.startsWith('data: ')) data += line.slice('data: '.length);
  }
  return { event, data: data ? JSON.parse(data) : undefined };
};

interface TestServer {
  app: FastifyInstance;
  url: string;
}

const startServer = async (deps: {
  stream: { subscribe(): GameEventSubscription };
  logger: ReturnType<typeof captureLogger>['logger'];
}): Promise<TestServer> => {
  const app = Fastify({ logger: false });
  registerGameEventsRoute(app, deps);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('server has no port');
  return { app, url: `http://127.0.0.1:${address.port}${GAME_EVENTS_ROUTE}` };
};

const stopServer = async (app: FastifyInstance): Promise<void> => {
  app.server.closeAllConnections();
  await app.close();
};

describe('crashsim SSE endpoint', () => {
  test('serves the route at /game/events', () => {
    expect(GAME_EVENTS_ROUTE).toBe('/game/events');
  });

  test('writes the captured snapshot first, then live events', async () => {
    const hub = new GameEventFanout();
    const { logger } = captureLogger();
    const { app, url } = await startServer({
      stream: makeRuntime(buildState(), 'connected', hub),
      logger,
    });

    const controller = new AbortController();
    const response = await fetch(url, { signal: controller.signal });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    const reader = new SseReader(response);
    const snapshot = await reader.next();
    expect(snapshot.event).toBe('snapshot');
    const snapshotData = asRecord(snapshot.data);
    expect(snapshotData.kind).toBe('snapshot');
    expect(snapshotData.seq).toBe(5);
    expect(snapshotData.connection).toBe('connected');
    expect(asRecord(snapshotData.state).roundId).toBe('r1');
    expect(asRecord(snapshotData.state).multiplier).toBe(1.2);

    hub.publish({ kind: 'game-event', seq: 6, event: tickEvent(6, 1.3) });
    const event = await reader.next();
    expect(event.event).toBe('game-event');
    expect(asRecord(event.data).seq).toBe(6);
    expect(asRecord(event.data).roundId).toBeUndefined();

    controller.abort();
    await waitFor(() => hub.subscriberCount === 0);
    await stopServer(app);
  });

  test('keeps an event published during subscription, after the snapshot, and drops stale ones', async () => {
    const hub = new GameEventFanout();
    const { logger } = captureLogger();

    let publishedDuringCapture = false;
    const runtime = makeRuntime(buildState(), 'connected', hub, () => {
      if (publishedDuringCapture) return;
      publishedDuringCapture = true;
      // Simulates an engine event landing while the snapshot is captured.
      hub.publish({ kind: 'game-event', seq: 4, event: tickEvent(4, 1.1) });
      hub.publish({ kind: 'game-event', seq: 6, event: tickEvent(6, 1.3) });
    });

    const { app, url } = await startServer({ stream: runtime, logger });
    const controller = new AbortController();
    const response = await fetch(url, { signal: controller.signal });
    const reader = new SseReader(response);

    const snapshot = await reader.next();
    expect(snapshot.event).toBe('snapshot');
    expect(asRecord(snapshot.data).seq).toBe(5);

    const firstEvent = await reader.next();
    expect(firstEvent.event).toBe('game-event');
    expect(asRecord(firstEvent.data).seq).toBe(6);

    // seq 4 was at or below the baseline and must never arrive.
    hub.publish({ kind: 'game-event', seq: 7, event: tickEvent(7, 1.4) });
    const nextEvent = await reader.next();
    expect(asRecord(nextEvent.data).seq).toBe(7);

    controller.abort();
    await waitFor(() => hub.subscriberCount === 0);
    await stopServer(app);
  });

  test('publishes upstream connection health', async () => {
    const hub = new GameEventFanout();
    const { logger } = captureLogger();
    const { app, url } = await startServer({
      stream: makeRuntime(buildState(), 'connected', hub),
      logger,
    });

    const controller = new AbortController();
    const response = await fetch(url, { signal: controller.signal });
    const reader = new SseReader(response);
    await reader.next();

    hub.publish({ kind: 'connection', connection: 'reconnecting' });
    const frame = await reader.next();
    expect(frame.event).toBe('connection');
    expect(asRecord(frame.data).connection).toBe('reconnecting');

    controller.abort();
    await waitFor(() => hub.subscriberCount === 0);
    await stopServer(app);
  });

  test('removes only the disconnected client and keeps the others streaming', async () => {
    const hub = new GameEventFanout();
    const { logger } = captureLogger();
    const { app, url } = await startServer({
      stream: makeRuntime(buildState(), 'connected', hub),
      logger,
    });

    const first = new AbortController();
    const second = new AbortController();
    const firstReader = new SseReader(await fetch(url, { signal: first.signal }));
    const secondReader = new SseReader(await fetch(url, { signal: second.signal }));
    await firstReader.next();
    await secondReader.next();
    expect(hub.subscriberCount).toBe(2);

    first.abort();
    await waitFor(() => hub.subscriberCount === 1);

    hub.publish({ kind: 'game-event', seq: 9, event: tickEvent(9, 1.5) });
    const frame = await secondReader.next();
    expect(asRecord(frame.data).seq).toBe(9);
    expect(hub.subscriberCount).toBe(1);

    second.abort();
    await waitFor(() => hub.subscriberCount === 0);
    expect(logger).toBeDefined();
    await stopServer(app);
  });

  test('unsubscribes and closes the response when the snapshot write is backpressured', () => {
    const { logger } = captureLogger();
    const raw = Object.assign(new EventEmitter(), {
      destroyed: false,
      wroteHead: false,
      ended: false,
      writeHead() { this.wroteHead = true; },
      write() { return false; },
      end() { this.ended = true; },
      destroy() { this.destroyed = true; },
    });
    const requestRaw = new EventEmitter();
    const reply = {
      raw,
      request: { raw: requestRaw },
      hijack() {},
    } as unknown as FastifyReply;
    let activated = false;
    let unsubscribed = false;

    handleGameEvents(reply, {
      stream: {
        subscribe: () => ({
          snapshot: { state: buildState(), connection: 'connected' },
          seq: 5,
          activate: () => { activated = true; },
          unsubscribe: () => { unsubscribed = true; },
        }),
      },
      logger,
    });

    expect(raw.wroteHead).toBe(true);
    expect(raw.ended).toBe(true);
    expect(activated).toBe(false);
    expect(unsubscribed).toBe(true);
  });
});
