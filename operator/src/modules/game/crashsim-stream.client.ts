import * as v from 'valibot';
import type { Logger } from '../../config';
import type { GameEvent } from './round-state';

export interface UpstreamSocketCloseInfo {
  code: number;
  reason: string;
}

/** Small test seam around Bun's native WebSocket. */
export interface UpstreamSocket {
  close(code?: number, reason?: string): void;
  onOpen(listener: () => void): void;
  onMessage(listener: (raw: string) => void): void;
  onClose(listener: (info: UpstreamSocketCloseInfo) => void): void;
  onError(listener: (error: Error) => void): void;
}

export type UpstreamSocketFactory = (url: string) => UpstreamSocket;

export const defaultSocketFactory: UpstreamSocketFactory = (url) => {
  const socket = new WebSocket(url);
  return {
    close: (code, reason) => socket.close(code, reason),
    onOpen: (listener) => socket.addEventListener('open', () => listener()),
    onMessage: (listener) =>
      socket.addEventListener('message', (event) => {
        listener(typeof event.data === 'string' ? event.data : String(event.data));
      }),
    onClose: (listener) =>
      socket.addEventListener('close', (event) => listener({ code: event.code, reason: event.reason })),
    onError: (listener) =>
      socket.addEventListener('error', () => listener(new Error('engine stream transport error'))),
  };
};

export type TimerHandle = ReturnType<typeof setTimeout>;

/** Timer injection keeps reconnect behavior deterministic in the service tests. */
export interface Scheduler {
  setTimeout(handler: () => void, delayMs: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

export const realScheduler: Scheduler = {
  setTimeout: (handler, delayMs) => setTimeout(handler, delayMs),
  clearTimeout: (handle) => clearTimeout(handle),
};

export interface BackoffOptions {
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
  stableAfterMs: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = {
  baseDelayMs: 500,
  maxDelayMs: 15_000,
  jitterRatio: 0.3,
  stableAfterMs: 5_000,
};

export function backoffDelay(attempt: number, options: BackoffOptions, random: () => number): number {
  const capped = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** attempt);
  const jitter = capped * options.jitterRatio * (random() * 2 - 1);
  return Math.max(0, Math.round(capped + jitter));
}

export interface CrashsimStreamHandlers {
  onOpen(): void;
  onEvent(event: GameEvent): void;
  onClose(reason: string): void;
  onError(error: Error): void;
}

export interface CrashsimStreamClientDeps {
  streamUrl: string;
  operatorKey: string;
  logger: Logger;
  socketFactory?: UpstreamSocketFactory;
  scheduler?: Scheduler;
  random?: () => number;
  backoff?: Partial<BackoffOptions>;
}

const seqSchema = v.pipe(v.number(), v.integer(), v.minValue(0));
const crashsimEventSchema = v.variant('type', [
  v.object({
    type: v.literal('round.betting'),
    seq: seqSchema,
    data: v.object({ roundId: v.string(), serverSeedHash: v.string(), bettingEndsAt: v.number() }),
  }),
  v.object({ type: v.literal('round.started'), seq: seqSchema, data: v.object({ roundId: v.string(), startedAt: v.number() }) }),
  v.object({
    type: v.literal('tick'),
    seq: seqSchema,
    data: v.object({ roundId: v.string(), multiplier: v.number(), t: v.number() }),
  }),
  v.object({
    type: v.literal('round.crashed'),
    seq: seqSchema,
    data: v.object({ roundId: v.string(), crashPoint: v.number(), serverSeed: v.string() }),
  }),
]);

type CrashsimEngineEvent = v.InferOutput<typeof crashsimEventSchema>;
type ParseResult = { ok: true; event: GameEvent } | { ok: false; reason: string };

const issuePaths = (issues: readonly v.BaseIssue<unknown>[]): string =>
  issues.map((issue) => issue.path?.map((segment) => String(segment.key)).join('.') ?? '(root)').join(',');

function parseEvent(raw: string): ParseResult {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'not-json' };
  }

  const parsed = v.safeParse(crashsimEventSchema, body);
  if (!parsed.success) return { ok: false, reason: `invalid-event:${issuePaths(parsed.issues)}` };

  const event: CrashsimEngineEvent = parsed.output;
  switch (event.type) {
    case 'round.betting':
      return { ok: true, event: { type: event.type, seq: event.seq, ...event.data } };
    case 'round.started':
      return { ok: true, event: { type: event.type, seq: event.seq, ...event.data } };
    case 'tick':
      return { ok: true, event: { type: event.type, seq: event.seq, ...event.data } };
    case 'round.crashed':
      return { ok: true, event: { type: event.type, seq: event.seq, ...event.data } };
  }
}

/** Owns the single Crashsim WebSocket and validates frames before publication. */
export class CrashsimStreamClient {
  private readonly socketFactory: UpstreamSocketFactory;
  private readonly scheduler: Scheduler;
  private readonly random: () => number;
  private readonly backoff: BackoffOptions;
  private readonly url: string;

  private socket: UpstreamSocket | null = null;
  private handlers: CrashsimStreamHandlers | null = null;
  private reconnectTimer: TimerHandle | null = null;
  private stableTimer: TimerHandle | null = null;
  private attempt = 0;
  private running = false;

  constructor(private readonly deps: CrashsimStreamClientDeps) {
    this.socketFactory = deps.socketFactory ?? defaultSocketFactory;
    this.scheduler = deps.scheduler ?? realScheduler;
    this.random = deps.random ?? Math.random;
    this.backoff = { ...DEFAULT_BACKOFF, ...deps.backoff };
    const streamUrl = new URL(deps.streamUrl);
    streamUrl.searchParams.set('key', deps.operatorKey);
    this.url = streamUrl.toString();
  }

  get reconnectAttempt(): number {
    return this.attempt;
  }

  get hasOpenSocket(): boolean {
    return this.socket !== null;
  }

  start(handlers: CrashsimStreamHandlers): void {
    if (this.running) return;
    this.running = true;
    this.handlers = handlers;
    this.connect();
  }

  close(): void {
    if (!this.running) return;
    this.running = false;
    this.clearTimer('reconnect');
    this.clearTimer('stable');
    const socket = this.socket;
    this.socket = null;
    this.handlers = null;
    socket?.close(1000, 'operator shutting down');
  }

  private connect(): void {
    if (!this.running || !this.handlers) return;
    if (this.socket) {
      const stale = this.socket;
      this.socket = null;
      stale.close(1000, 'replaced by reconnect');
    }

    this.deps.logger.debug('engine stream connecting', { attempt: this.attempt });

    let socket: UpstreamSocket;
    try {
      socket = this.socketFactory(this.url);
    } catch {
      this.handlers.onError(new Error('engine stream connection failed'));
      this.handlers.onClose('connection failed');
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    const handlers = this.handlers;

    socket.onOpen(() => {
      if (socket !== this.socket) return;
      this.deps.logger.info('engine stream connection opened', { attempt: this.attempt });
      this.scheduleStableReset();
      handlers.onOpen();
    });

    socket.onMessage((raw) => {
      if (socket !== this.socket) return;
      const parsed = parseEvent(raw);
      if (!parsed.ok) {
        this.deps.logger.warn('engine event rejected', { reason: parsed.reason });
        return;
      }
      handlers.onEvent(parsed.event);
    });

    socket.onError(() => {
      if (socket !== this.socket) return;
      handlers.onError(new Error('engine stream transport error'));
      socket.close(1011, 'stream transport error');
    });

    socket.onClose((info) => {
      if (socket !== this.socket) return;
      this.socket = null;
      this.clearTimer('stable');
      if (!this.running) return;
      this.deps.logger.warn('engine stream connection closed', {
        code: info.code,
        reason: info.reason || 'none',
      });
      handlers.onClose(info.reason || `code=${info.code}`);
      this.scheduleReconnect();
    });
  }

  private scheduleStableReset(): void {
    this.clearTimer('stable');
    this.stableTimer = this.scheduler.setTimeout(() => {
      this.stableTimer = null;
      this.attempt = 0;
    }, this.backoff.stableAfterMs);
  }

  private scheduleReconnect(): void {
    if (!this.running || this.reconnectTimer) return;
    const delay = backoffDelay(this.attempt, this.backoff, this.random);
    this.attempt += 1;
    this.deps.logger.warn('engine stream reconnect scheduled', { attempt: this.attempt, delayMs: delay });
    this.reconnectTimer = this.scheduler.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private clearTimer(which: 'reconnect' | 'stable'): void {
    const handle = which === 'reconnect' ? this.reconnectTimer : this.stableTimer;
    if (handle) this.scheduler.clearTimeout(handle);
    if (which === 'reconnect') this.reconnectTimer = null;
    else this.stableTimer = null;
  }
}
