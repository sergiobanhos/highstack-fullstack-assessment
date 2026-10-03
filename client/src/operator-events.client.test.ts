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
