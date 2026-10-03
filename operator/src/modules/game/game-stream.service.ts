import type { Logger, OperatorConfig } from '../../config';
import type { GameEventHub } from './game-event-hub';
import { CrashsimHttpClient } from './crashsim-http.client';
import {
  backoffDelay,
  type BackoffOptions,
  type Scheduler,
  type TimerHandle,
  realScheduler,
  CrashsimStreamClient,
  type UpstreamSocketFactory,
} from './crashsim-stream.client';
import {
  applyEvent,
  applySnapshot,
  emptyRoundState,
  type ConnectionState,
  type GameEvent,
  type OperatorMessage,
  type OperatorSnapshot,
  type RoundState,
} from './round-state';

export interface GameStreamService {
  start(): void;
  stop(): Promise<void>;
  getSnapshot(): OperatorSnapshot;
}

export interface GameStreamServiceDeps {
  config: OperatorConfig;
  logger: Logger;
  hub: GameEventHub;
  socketFactory?: UpstreamSocketFactory;
  scheduler?: Scheduler;
  random?: () => number;
  streamBackoff?: Partial<BackoffOptions>;
  resyncBackoff?: Partial<BackoffOptions>;
  fetchImpl?: typeof fetch;
  snapshotTimeoutMs?: number;
}

const DEFAULT_RESYNC_BACKOFF: BackoffOptions = {
  baseDelayMs: 500,
  maxDelayMs: 15_000,
  jitterRatio: 0.3,
  stableAfterMs: 5_000,
};

type IngestOutcome = 'applied' | 'ignored' | 'gap';

/** Owns the one Crashsim stream, current round, snapshot resync, and publication. */
export function createGameStreamService(deps: GameStreamServiceDeps): GameStreamService {
  const { config, logger, hub } = deps;
  const scheduler = deps.scheduler ?? realScheduler;
  const random = deps.random ?? Math.random;
  const resyncBackoff: BackoffOptions = { ...DEFAULT_RESYNC_BACKOFF, ...deps.resyncBackoff };
  const http = new CrashsimHttpClient({
    baseUrl: config.engine.httpUrl,
    operatorKey: config.engine.operatorKey,
    fetchImpl: deps.fetchImpl,
    timeoutMs: deps.snapshotTimeoutMs,
  });
  const stream = new CrashsimStreamClient({
    streamUrl: config.engine.streamUrl,
    operatorKey: config.engine.operatorKey,
    logger,
    socketFactory: deps.socketFactory,
    scheduler,
    random,
    backoff: deps.streamBackoff,
  });

  let state: RoundState = emptyRoundState();
  let connection: ConnectionState = 'reconnecting';
  let syncing = false;
  let buffer: GameEvent[] = [];
  let generation = 0;
  let resyncAttempt = 0;
  let resyncTimer: TimerHandle | null = null;
  let started = false;
  let stopped = false;

  const setConnection = (next: ConnectionState): void => {
    if (connection === next) return;
    connection = next;
    hub.publish({ kind: 'connection', connection: next });
  };

  const clearResyncTimer = (): void => {
    if (!resyncTimer) return;
    scheduler.clearTimeout(resyncTimer);
    resyncTimer = null;
  };

  const ingest = (event: GameEvent): IngestOutcome => {
    if (event.seq <= state.seq) return 'ignored';
    if (event.seq > state.seq + 1) return 'gap';

    const next = applyEvent(state, event);
    if (next === state) return 'ignored';

    state = next;
    const message: OperatorMessage = { kind: 'game-event', seq: event.seq, event };
    hub.publish(message);
    return 'applied';
  };

  const scheduleResync = (reason: string): void => {
    if (stopped || resyncTimer) return;
    const delay = backoffDelay(resyncAttempt, resyncBackoff, random);
    resyncAttempt += 1;
    logger.warn('engine snapshot retry scheduled', { reason, attempt: resyncAttempt, delayMs: delay });
    resyncTimer = scheduler.setTimeout(() => {
      resyncTimer = null;
      void synchronize('retry');
    }, delay);
  };

  const synchronize = async (reason: string): Promise<void> => {
    if (stopped || !stream.hasOpenSocket) return;
    clearResyncTimer();

    const myGeneration = ++generation;
    syncing = true;
    buffer = [];
    setConnection('synchronizing');
    logger.info('engine snapshot synchronization started', { reason, roundId: state.roundId });

    let snapshot;
    try {
      snapshot = await http.getCurrentRound();
    } catch (error) {
      if (stopped || myGeneration !== generation) return;
      syncing = false;
      setConnection('reconnecting');
      logger.error('engine snapshot synchronization failed', { reason, error });
      scheduleResync('snapshot-failed');
      return;
    }

    if (stopped || myGeneration !== generation || !stream.hasOpenSocket) return;

    state = applySnapshot(snapshot);
    const buffered = [...buffer].sort((left, right) => left.seq - right.seq);
    buffer = [];
    syncing = false;
    resyncAttempt = 0;
    logger.info('engine snapshot synchronized', {
      reason,
      roundId: state.roundId,
      seq: state.seq,
      bufferedEvents: buffered.length,
    });

    hub.publish({ kind: 'snapshot', seq: state.seq, state, connection });

    for (const event of buffered) {
      if (stopped || myGeneration !== generation) return;
      const outcome = ingest(event);
      if (outcome === 'gap') {
        logger.warn('engine sequence gap detected while applying buffered events', {
          roundId: event.roundId,
          lastSeq: state.seq,
          eventSeq: event.seq,
        });
        void synchronize('sequence-gap');
        return;
      }
    }

    setConnection('connected');
  };

  const start = (): void => {
    if (started || stopped) return;
    started = true;
    logger.info('subscribing to Crashsim engine stream');
    stream.start({
      onOpen: () => {
        void synchronize('stream-open');
      },
      onEvent: (event) => {
        if (syncing) {
          buffer.push(event);
          return;
        }
        const outcome = ingest(event);
        if (outcome === 'gap') {
          logger.warn('engine sequence gap detected', {
            roundId: event.roundId,
            lastSeq: state.seq,
            eventSeq: event.seq,
          });
          void synchronize('sequence-gap');
        } else if (outcome === 'ignored') {
          logger.debug('engine event ignored as stale or out of order', { roundId: event.roundId, seq: event.seq });
        }
      },
      onClose: (reason) => {
        generation += 1;
        syncing = false;
        buffer = [];
        clearResyncTimer();
        logger.warn('engine stream disconnected', { reason });
        setConnection('reconnecting');
      },
      onError: (error) => {
        generation += 1;
        syncing = false;
        buffer = [];
        logger.error('engine stream error', { error });
        setConnection('reconnecting');
      },
    });
  };

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    generation += 1;
    clearResyncTimer();
    stream.close();
  };

  return { start, stop, getSnapshot: () => ({ state, connection }) };
}
