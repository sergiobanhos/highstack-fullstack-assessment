import { describe, expect, test } from 'bun:test';
import {
  initialStreamState,
  isSnapshotStale,
  MAX_RETAINED_EVENTS,
  parseOperatorFrame,
  streamReducer,
  type ClientGameEvent,
  type OperatorStreamState,
} from './operator-events.client';

const snapshotFrame = (seq: number, upstream = 'connected'): string =>
  JSON.stringify({
    kind: 'snapshot',
    seq,
    connection: upstream,
    state: {
      roundId: 'r1',
      state: 'running',
      seq,
      multiplier: 1.2,
      crashPoint: null,
      serverSeed: null,
      serverSeedHash: 'h1',
      bettingEndsAt: null,
      startedAt: 100,
    },
  });

const eventFrame = (seq: number, type = 'tick'): string =>
  JSON.stringify({
    kind: 'game-event',
    seq,
    event: { type, seq, roundId: 'r1', multiplier: 1.1 + seq / 100, t: seq * 100 },
  });

const event = (seq: number): ClientGameEvent => ({
  type: 'tick',
  seq,
  roundId: 'r1',
  payload: { type: 'tick', seq, roundId: 'r1' },
});

const withSnapshot = (seq = 5): OperatorStreamState =>
  streamReducer(initialStreamState, {
    type: 'snapshot',
    upstream: 'connected',
    snapshot: {
      roundId: 'r1',
      state: 'running',
      seq,
      multiplier: 1.2,
      crashPoint: null,
      serverSeed: null,
      serverSeedHash: 'h1',
      bettingEndsAt: null,
      startedAt: 100,
    },
  });

describe('parseOperatorFrame', () => {
  test('parses snapshot, game-event, and connection frames', () => {
    expect(parseOperatorFrame(snapshotFrame(5))?.type).toBe('snapshot');
    expect(parseOperatorFrame(eventFrame(6))?.type).toBe('game-event');
    expect(parseOperatorFrame(JSON.stringify({ kind: 'connection', connection: 'reconnecting' }))).toEqual({
      type: 'connection',
      upstream: 'reconnecting',
    });
  });

  test('rejects malformed or unknown frames without throwing', () => {
    expect(parseOperatorFrame('not-json')).toBeNull();
    expect(parseOperatorFrame('[]')).toBeNull();
    expect(parseOperatorFrame(JSON.stringify({ kind: 'mystery' }))).toBeNull();
    expect(parseOperatorFrame(JSON.stringify({ kind: 'snapshot', state: {}, connection: 'bogus' }))).toBeNull();
    expect(parseOperatorFrame(JSON.stringify({ kind: 'game-event', seq: 1, event: { type: 'tick' } }))).toBeNull();
  });
});

describe('streamReducer', () => {
  test('updates the displayed snapshot as the round lifecycle events arrive', () => {
    const snapshotAction = parseOperatorFrame(JSON.stringify({
      kind: 'snapshot',
      seq: 5,
      connection: 'connected',
      state: {
        roundId: 'r1',
        state: 'betting',
        seq: 5,
        multiplier: null,
        crashPoint: null,
        serverSeed: null,
        serverSeedHash: 'h1',
        bettingEndsAt: 200,
        startedAt: null,
      },
    }));
    const startedAction = parseOperatorFrame(JSON.stringify({
      kind: 'game-event',
      seq: 6,
      event: { type: 'round.started', seq: 6, roundId: 'r1', startedAt: 200 },
    }));
    const tickAction = parseOperatorFrame(JSON.stringify({
      kind: 'game-event',
      seq: 7,
      event: { type: 'tick', seq: 7, roundId: 'r1', multiplier: 1.75, t: 300 },
    }));
    const crashedAction = parseOperatorFrame(JSON.stringify({
      kind: 'game-event',
      seq: 8,
      event: { type: 'round.crashed', seq: 8, roundId: 'r1', crashPoint: 1.82, serverSeed: 'seed-1' },
    }));
    const lateTickAction = parseOperatorFrame(JSON.stringify({
      kind: 'game-event',
      seq: 9,
      event: { type: 'tick', seq: 9, roundId: 'r1', multiplier: 1.9, t: 400 },
    }));
    const nextBettingAction = parseOperatorFrame(JSON.stringify({
      kind: 'game-event',
      seq: 10,
      event: {
        type: 'round.betting',
        seq: 10,
        roundId: 'r2',
        serverSeedHash: 'h2',
        bettingEndsAt: 500,
      },
    }));
    expect(snapshotAction?.type).toBe('snapshot');
    expect(startedAction?.type).toBe('game-event');
    expect(tickAction?.type).toBe('game-event');
    expect(crashedAction?.type).toBe('game-event');
    expect(lateTickAction?.type).toBe('game-event');
    expect(nextBettingAction?.type).toBe('game-event');
    if (!snapshotAction || snapshotAction.type !== 'snapshot' ||
        !startedAction || startedAction.type !== 'game-event' ||
        !tickAction || tickAction.type !== 'game-event' ||
        !crashedAction || crashedAction.type !== 'game-event' ||
        !lateTickAction || lateTickAction.type !== 'game-event' ||
        !nextBettingAction || nextBettingAction.type !== 'game-event') throw new Error('invalid fixture');

    const initial = streamReducer(initialStreamState, snapshotAction);
    const started = streamReducer(initial, startedAction);
    expect(started.snapshot?.state).toBe('running');

    const ticked = streamReducer(started, tickAction);
    expect(ticked.snapshot?.multiplier).toBe(1.75);

    const crashed = streamReducer(ticked, crashedAction);
    expect(crashed.snapshot?.state).toBe('crashed');
    expect(crashed.snapshot?.crashPoint).toBe(1.82);
    expect(crashed.snapshot?.seq).toBe(8);

    const afterLateTick = streamReducer(crashed, lateTickAction);
    expect(afterLateTick.snapshot?.state).toBe('crashed');
    expect(afterLateTick.snapshot?.seq).toBe(8);

    const nextRound = streamReducer(afterLateTick, nextBettingAction);
    expect(nextRound.snapshot?.roundId).toBe('r2');
    expect(nextRound.snapshot?.state).toBe('betting');
    expect(nextRound.snapshot?.crashPoint).toBeNull();
  });

  test('a snapshot replaces state and drops log entries at or below its seq', () => {
    let state = withSnapshot(5);
    state = streamReducer(state, { type: 'game-event', event: event(6) });
    state = streamReducer(state, { type: 'game-event', event: event(7) });

    const resynced = streamReducer(state, {
      type: 'snapshot',
      upstream: 'connected',
      snapshot: { ...state.snapshot!, seq: 9, multiplier: 1.6 },
    });

    expect(resynced.snapshot?.seq).toBe(9);
    expect(resynced.events).toEqual([]);
  });

  test('ignores events at or below the snapshot seq and deduplicates by seq', () => {
    let state = withSnapshot(5);
    state = streamReducer(state, { type: 'game-event', event: event(5) });
    state = streamReducer(state, { type: 'game-event', event: event(4) });
    expect(state.events).toEqual([]);

    state = streamReducer(state, { type: 'game-event', event: event(6) });
    state = streamReducer(state, { type: 'game-event', event: event(6) });
    expect(state.events.map((entry) => entry.seq)).toEqual([6]);
  });

  test('keeps only the most recent events', () => {
    let state = withSnapshot(0);
    for (let seq = 1; seq <= MAX_RETAINED_EVENTS + 20; seq += 1) {
      state = streamReducer(state, { type: 'game-event', event: event(seq) });
    }
    expect(state.events).toHaveLength(MAX_RETAINED_EVENTS);
    expect(state.events[0]?.seq).toBe(21);
    expect(state.events.at(-1)?.seq).toBe(MAX_RETAINED_EVENTS + 20);
  });

  test('tracks downstream and upstream health separately', () => {
    let state = initialStreamState;
    expect(isSnapshotStale(state)).toBe(true);

    state = streamReducer(state, { type: 'downstream-open' });
    expect(state.downstream).toBe('open');
    // Upstream is still reconnecting: the snapshot stays frozen.
    expect(isSnapshotStale(state)).toBe(true);

    state = streamReducer(state, { type: 'connection', upstream: 'connected' });
    expect(isSnapshotStale(state)).toBe(false);

    state = streamReducer(state, { type: 'downstream-error' });
    expect(state.downstream).toBe('error');
    expect(isSnapshotStale(state)).toBe(true);
  });
});
