import { describe, expect, test } from 'bun:test';
import { createLogger, createRedactor, loadConfig, type LoggerSink } from '../../config';
import { GameEventHub } from './game-event-hub';
import type { GameStreamService } from './game-stream.service';
import { createGameStreamService } from './game-stream.service';
import type { ConnectionState, GameEvent, OperatorMessage, OperatorSnapshot } from './round-state';
import type { Scheduler, TimerHandle, UpstreamSocket, UpstreamSocketCloseInfo } from './crashsim-stream.client';

const OPERATOR_KEY = 'test-operator-key';
const STREAM_URL = 'ws://engine:4000/stream';
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

class FakeSocket implements UpstreamSocket {
  closeCalls = 0;
  private openListener: (() => void) | null = null;
  private messageListener: ((raw: string) => void) | null = null;
  private closeListener: ((info: UpstreamSocketCloseInfo) => void) | null = null;
  private errorListener: ((error: Error) => void) | null = null;

  close(): void {
    this.closeCalls += 1;
  }
  onOpen(listener: () => void): void {
    this.openListener = listener;
  }
  onMessage(listener: (raw: string) => void): void {
    this.messageListener = listener;
  }
  onClose(listener: (info: UpstreamSocketCloseInfo) => void): void {
    this.closeListener = listener;
  }
  onError(listener: (error: Error) => void): void {
    this.errorListener = listener;
  }

  emitOpen(): void {
    this.openListener?.();
  }
  emitMessage(raw: string): void {
    this.messageListener?.(raw);
  }
  emitClose(code = 1006, reason = ''): void {
    this.closeListener?.({ code, reason });
  }
  emitError(message: string): void {
    this.errorListener?.(new Error(message));
  }
}

class ManualScheduler implements Scheduler {
  private now = 0;
  private counter = 0;
  private readonly timers = new Map<number, { at: number; handler: () => void }>();

  setTimeout(handler: () => void, delayMs: number): TimerHandle {
    const id = ++this.counter;
    this.timers.set(id, { at: this.now + delayMs, handler });
    return id as unknown as TimerHandle;
  }

  clearTimeout(handle: TimerHandle): void {
    this.timers.delete(handle as unknown as number);
  }

  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (!next) break;
      this.timers.delete(next[0]);
      this.now = next[1].at;
      next[1].handler();
    }
    this.now = target;
  }
}

interface Harness {
  hub: GameEventHub;
  service: GameStreamService;
  sockets: FakeSocket[];
  socketUrls: string[];
  logs: string[];
  scheduler: ManualScheduler;
  fetchCount(): number;
  requestHeaders: Headers[];
  crashReconciliations: string[];
  snapshotReconciliations: string[];
  events(): GameEvent[];
  connections(): ConnectionState[];
}

function createHarness(
  snapshotBodies: unknown[] = [
    { roundId: 'r1', state: 'running', seq: 5, startedAt: 100, multiplier: 1.2, serverSeedHash: 'h1' },
  ],
  callbacks: {
    onRoundCrashed?: (roundId: string) => Promise<void>;
    onSnapshotSynchronized?: (snapshot: OperatorSnapshot) => Promise<void>;
  } = {},
): Harness {
  const logs: string[] = [];
  const logger = createLogger({
    level: 'debug',
    redactor: createRedactor([OPERATOR_KEY]),
    sink: {
      debug: (line: string) => logs.push(line),
      info: (line: string) => logs.push(line),
      warn: (line: string) => logs.push(line),
      error: (line: string) => logs.push(line),
    } satisfies LoggerSink,
  });

  const sockets: FakeSocket[] = [];
  const socketUrls: string[] = [];
  const scheduler = new ManualScheduler();
  const requestHeaders: Headers[] = [];
  let fetchCount = 0;
  const crashReconciliations: string[] = [];
  const snapshotReconciliations: string[] = [];
  const hub = new GameEventHub();
  const messages: OperatorMessage[] = [];
  const collector = hub.subscribeWithSnapshot(() => ({
    state: {
      roundId: null,
      state: null,
      seq: -1,
      serverSeedHash: null,
      bettingEndsAt: null,
      startedAt: null,
      multiplier: null,
      crashPoint: null,
      serverSeed: null,
    },
    connection: 'reconnecting',
  }));
  collector.activate((message) => messages.push(message));

  const service = createGameStreamService({
    config: loadConfig({
      DATABASE_URL: 'postgres://operator:local-password@127.0.0.1:5432/operator_test',
      APP_ENV: 'test',
      ENGINE_WEBHOOK_SECRET: 'test-webhook-secret',
      ENGINE_OPERATOR_KEY: OPERATOR_KEY,
      ENGINE_STREAM_URL: STREAM_URL,
    }),
    logger,
    hub,
    onRoundCrashed: async (roundId) => {
      crashReconciliations.push(roundId);
      await callbacks.onRoundCrashed?.(roundId);
    },
    onSnapshotSynchronized: async (snapshot) => {
      snapshotReconciliations.push(snapshot.state.roundId ?? '');
      await callbacks.onSnapshotSynchronized?.(snapshot);
    },
    scheduler,
    random: () => 0.5,
    streamBackoff: { baseDelayMs: 100, maxDelayMs: 800, jitterRatio: 0, stableAfterMs: 0 },
    resyncBackoff: { baseDelayMs: 100, maxDelayMs: 800, jitterRatio: 0, stableAfterMs: 0 },
    fetchImpl: (async (_input, init) => {
      const body = snapshotBodies[Math.min(fetchCount, snapshotBodies.length - 1)];
      fetchCount += 1;
      requestHeaders.push(new Headers(init?.headers));
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch,
    socketFactory: (url) => {
      const socket = new FakeSocket();
      sockets.push(socket);
      socketUrls.push(url);
      return socket;
    },
  });

  return {
    hub,
    service,
    sockets,
    socketUrls,
    logs,
    scheduler,
    requestHeaders,
    crashReconciliations,
    snapshotReconciliations,
    fetchCount: () => fetchCount,
    events: () => messages.flatMap((message) => (message.kind === 'game-event' ? [message.event] : [])),
    connections: () => messages.flatMap((message) => (message.kind === 'connection' ? [message.connection] : [])),
  };
}

const tick = (seq: number, multiplier: number, roundId = 'r1'): string =>
  JSON.stringify({ type: 'tick', seq, data: { roundId, multiplier, t: seq * 100 } });
const crashed = (seq: number, roundId = 'r1'): string =>
  JSON.stringify({ type: 'round.crashed', seq, data: { roundId, crashPoint: 2.5, serverSeed: 's1' } });

describe('Crashsim stream service', () => {
  test('opens one upstream socket and reports reconnecting until synchronized', () => {
    const harness = createHarness();
    harness.service.start();

    expect(harness.sockets).toHaveLength(1);
    expect(harness.fetchCount()).toBe(0);
    expect(harness.service.getSnapshot().connection).toBe('reconnecting');
    expect(harness.service.getSnapshot().state.roundId).toBeNull();
  });

  test('buffers events during snapshot sync and applies only newer events', async () => {
    const harness = createHarness([
      { roundId: 'r1', state: 'running', seq: 5, startedAt: 100, multiplier: 1.1, serverSeedHash: 'h1' },
    ]);
    harness.service.start();
    const socket = harness.sockets[0]!;
    socket.emitOpen();
    socket.emitMessage(tick(3, 1.05));
    socket.emitMessage(tick(6, 1.3));
    await flush();

    expect(harness.service.getSnapshot().connection).toBe('connected');
    expect(harness.service.getSnapshot().state.seq).toBe(6);
    expect(harness.service.getSnapshot().state.multiplier).toBe(1.3);
    expect(harness.events().map((event) => event.seq)).toEqual([6]);
    expect(harness.requestHeaders[0]?.get('x-operator-key')).toBe(OPERATOR_KEY);
    expect(harness.logs.join('\n')).not.toMatch(/replay/i);
  });

  test('rejects an invalid snapshot and retries synchronization while the socket stays open', async () => {
    const harness = createHarness([
      { roundId: 'r1', state: 'paused', seq: 5 },
      { roundId: 'r1', state: 'running', seq: 8, multiplier: 1.4 },
    ]);
    harness.service.start();
    harness.sockets[0]!.emitOpen();
    await flush();

    expect(harness.service.getSnapshot().connection).toBe('reconnecting');
    expect(harness.logs.join('\n')).toContain('invalid engine snapshot');
    expect(harness.service.getSnapshot().state.roundId).toBeNull();

    harness.scheduler.advance(100);
    await flush();
    expect(harness.fetchCount()).toBe(2);
    expect(harness.service.getSnapshot().connection).toBe('connected');
    expect(harness.service.getSnapshot().state.seq).toBe(8);
    await harness.service.stop();
  });

  test('keeps a crashed round terminal against a late tick with either sequence position', async () => {
    const harness = createHarness([
      { roundId: 'r1', state: 'running', seq: 3, startedAt: 100, multiplier: 1.1, serverSeedHash: 'h1' },
    ]);
    harness.service.start();
    const socket = harness.sockets[0]!;
    socket.emitOpen();
    await flush();

    socket.emitMessage(crashed(4));
    socket.emitMessage(tick(3, 2.4));
    socket.emitMessage(tick(5, 2.6));

    const state = harness.service.getSnapshot().state;
    expect(state.state).toBe('crashed');
    expect(state.multiplier).toBe(2.5);
    expect(state.seq).toBe(4);
    expect(harness.events().map((event) => event.seq)).toEqual([4]);
  });

  test('reconciles an applied crash in background without delaying event publication', async () => {
    const harness = createHarness(
      [{ roundId: 'r1', state: 'running', seq: 5, startedAt: 100, multiplier: 1.2, serverSeedHash: 'h1' }],
      { onRoundCrashed: () => new Promise<void>(() => {}) },
    );
    harness.service.start();
    const socket = harness.sockets[0]!;
    socket.emitOpen();
    await flush();

    socket.emitMessage(crashed(6, 'r1'));

    expect(harness.events().map((event) => event.type)).toEqual(['round.crashed']);
    expect(harness.crashReconciliations).toEqual(['r1']);
    expect(harness.service.getSnapshot().state.state).toBe('crashed');
    expect(harness.service.getSnapshot().connection).toBe('connected');
    await harness.service.stop();
  });

  test('starts snapshot reconciliation in background and reaches connected despite callback failure', async () => {
    const harness = createHarness(
      [{ roundId: 'r2', state: 'running', seq: 8, startedAt: 200, multiplier: 1.1, serverSeedHash: 'h2' }],
      { async onSnapshotSynchronized() { throw new Error('private callback detail'); } },
    );
    harness.service.start();
    harness.sockets[0]!.emitOpen();
    await flush();

    expect(harness.snapshotReconciliations).toEqual(['r2']);
    expect(harness.service.getSnapshot().connection).toBe('connected');
    expect(harness.logs.join('\n')).toContain('snapshot.bet_reconciliation_failed');
    expect(harness.logs.join('\n')).not.toContain('private callback detail');
    await harness.service.stop();
  });

  test('resynchronizes from a fresh snapshot on a sequence gap without opening another socket', async () => {
    const harness = createHarness([
      { roundId: 'r1', state: 'running', seq: 5, startedAt: 100, multiplier: 1.2, serverSeedHash: 'h1' },
      { roundId: 'r1', state: 'running', seq: 9, startedAt: 100, multiplier: 1.6, serverSeedHash: 'h1' },
    ]);
    harness.service.start();
    harness.sockets[0]!.emitOpen();
    await flush();
    expect(harness.service.getSnapshot().state.seq).toBe(5);

    harness.sockets[0]!.emitMessage(tick(8, 1.5));
    await flush();
    expect(harness.fetchCount()).toBe(2);
    expect(harness.service.getSnapshot().state.seq).toBe(9);
    expect(harness.sockets).toHaveLength(1);
    expect(harness.logs.join('\n')).toContain('sequence gap');
    expect(harness.connections()).toEqual(['synchronizing', 'connected', 'synchronizing', 'connected']);
  });

  test('reports reconnecting and reconnects sequentially with growing backoff', async () => {
    const harness = createHarness();
    harness.service.start();
    const first = harness.sockets[0]!;
    first.emitOpen();
    await flush();
    expect(harness.service.getSnapshot().connection).toBe('connected');

    first.emitClose(1006, 'engine restart');
    expect(harness.service.getSnapshot().connection).toBe('reconnecting');
    expect(harness.sockets).toHaveLength(1);

    harness.scheduler.advance(1_000);
    expect(harness.sockets).toHaveLength(2);
    const second = harness.sockets[1]!;
    second.emitOpen();
    await flush();
    expect(harness.service.getSnapshot().connection).toBe('connected');

    second.emitClose(1006, 'engine restart');
    harness.scheduler.advance(1_000);
    expect(harness.sockets).toHaveLength(3);
    const reconnectLogs = harness.logs.filter((line) => line.includes('reconnect scheduled'));
    expect(reconnectLogs[0]).toContain('"delayMs":100');
    expect(reconnectLogs[1]).toContain('"delayMs":200');
  });

  test('rejects malformed and unsupported engine events before state mutation', async () => {
    const harness = createHarness();
    harness.service.start();
    const socket = harness.sockets[0]!;
    socket.emitOpen();
    await flush();

    socket.emitMessage('not-json');
    socket.emitMessage(JSON.stringify({ type: 'mystery.event', seq: 99, data: {} }));
    socket.emitMessage(JSON.stringify({ type: 'tick', seq: 7, data: { roundId: 'r1', multiplier: 'high' } }));

    expect(harness.logs.join('\n')).toContain('engine event rejected');
    expect(harness.events()).toEqual([]);
    expect(harness.service.getSnapshot().state.seq).toBe(5);
  });

  test('keeps the operator key server-side and out of logs', async () => {
    const harness = createHarness();
    harness.service.start();
    const socket = harness.sockets[0]!;
    socket.emitOpen();
    await flush();
    socket.emitError(OPERATOR_KEY);
    socket.emitClose(1006, '');
    harness.scheduler.advance(5_000);
    await flush();

    expect(harness.socketUrls[0]).toContain(`key=${OPERATOR_KEY}`);
    const joined = harness.logs.join('\n');
    expect(joined).not.toContain(OPERATOR_KEY);
    expect(joined).not.toContain('target');
    expect(joined).toContain('engine stream transport error');
  });

  test('does not open an additional upstream socket for downstream clients', () => {
    const harness = createHarness();
    harness.service.start();
    for (let index = 0; index < 3; index += 1) {
      const subscription = harness.hub.subscribeWithSnapshot(() => harness.service.getSnapshot());
      subscription.activate(() => {});
    }
    expect(harness.hub.subscriberCount).toBe(4);
    expect(harness.sockets).toHaveLength(1);
  });

  test('stays alive and reconnects when the engine is unreachable at startup', async () => {
    const harness = createHarness();
    harness.service.start();
    harness.sockets[0]!.emitError('ECONNREFUSED');
    harness.sockets[0]!.emitClose(1006, 'refused');
    harness.scheduler.advance(1_000);
    await flush();

    expect(harness.sockets.length).toBeGreaterThanOrEqual(2);
    expect(harness.service.getSnapshot().connection).toBe('reconnecting');
    expect(harness.service.getSnapshot().state.roundId).toBeNull();
    await harness.service.stop();
  });
});
