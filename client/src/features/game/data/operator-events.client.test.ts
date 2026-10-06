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

    state = streamReducer(state, { type: 'snapshot', upstream: 'connected', snapshot: {
      roundId: 'r1',
      state: 'running',
      seq: 5,
      multiplier: 1.2,
      crashPoint: null,
      serverSeed: null,
      serverSeedHash: 'h1',
      bettingEndsAt: null,
      startedAt: 100,
    } });
    expect(isSnapshotStale(state)).toBe(false);

    state = streamReducer(state, { type: 'downstream-error' });
    expect(state.downstream).toBe('error');
    expect(isSnapshotStale(state)).toBe(true);
  });

  test('a reopened stream stays stale until the operator sends a fresh snapshot', () => {
    let state = streamReducer(initialStreamState, { type: 'downstream-open' });
    state = streamReducer(state, { type: 'snapshot', upstream: 'connected', snapshot: {
      roundId: 'r1',
      state: 'running',
      seq: 5,
      multiplier: 1.2,
      crashPoint: null,
      serverSeed: null,
      serverSeedHash: 'h1',
      bettingEndsAt: null,
      startedAt: 100,
    } });
    expect(isSnapshotStale(state)).toBe(false);

    // The stream drops; the last multiplier remains visible but frozen.
    state = streamReducer(state, { type: 'downstream-error' });
    expect(isSnapshotStale(state)).toBe(true);

    // Reopening alone must not re-enable actions on the old snapshot.
    state = streamReducer(state, { type: 'downstream-open' });
    expect(state.snapshot?.multiplier).toBe(1.2);
    expect(isSnapshotStale(state)).toBe(true);

    // The snapshot the operator writes on connect restores confidence.
    state = streamReducer(state, { type: 'snapshot', upstream: 'connected', snapshot: {
      roundId: 'r1',
      state: 'running',
      seq: 9,
      multiplier: 1.9,
      crashPoint: null,
      serverSeed: null,
      serverSeedHash: 'h1',
      bettingEndsAt: null,
      startedAt: 100,
    } });
    expect(isSnapshotStale(state)).toBe(false);
    expect(state.snapshot?.multiplier).toBe(1.9);
  });

  test('an upstream resync freezes the screen until the operator reports connected', () => {
    // Exact frame order published by the operator while it resynchronizes
    // after an engine stream drop (`connection` -> `snapshot` -> `connection`).
    let state = streamReducer(initialStreamState, { type: 'downstream-open' });
    state = streamReducer(state, { type: 'snapshot', upstream: 'connected', snapshot: {
      roundId: 'r1',
      state: 'running',
      seq: 5,
      multiplier: 1.2,
      crashPoint: null,
      serverSeed: null,
      serverSeedHash: 'h1',
      bettingEndsAt: null,
      startedAt: 100,
    } });
    expect(isSnapshotStale(state)).toBe(false);

    state = streamReducer(state, { type: 'connection', upstream: 'reconnecting' });
    expect(isSnapshotStale(state)).toBe(true);

    // The snapshot taken during the resync reports `synchronizing`: the state
    // is current but not yet live, so actions stay blocked.
    state = streamReducer(state, { type: 'snapshot', upstream: 'synchronizing', snapshot: {
      roundId: 'r1',
      state: 'running',
      seq: 7,
      multiplier: 1.5,
      crashPoint: null,
      serverSeed: null,
      serverSeedHash: 'h1',
      bettingEndsAt: null,
      startedAt: 100,
    } });
    expect(state.snapshot?.multiplier).toBe(1.5);
    expect(isSnapshotStale(state)).toBe(true);

    // The resync finished: the screen is live again instead of staying frozen.
    state = streamReducer(state, { type: 'connection', upstream: 'connected' });
    expect(isSnapshotStale(state)).toBe(false);
  });

  test('a connection notice without any snapshot cannot un-freeze the screen', () => {
    let state = streamReducer(initialStreamState, { type: 'downstream-open' });
    state = streamReducer(state, { type: 'connection', upstream: 'connected' });

    expect(state.snapshot).toBeNull();
    expect(isSnapshotStale(state)).toBe(true);
  });

  test('a snapshot taken while the upstream is reconnecting is stale', () => {
    const state = streamReducer(initialStreamState, {
      type: 'snapshot',
      upstream: 'reconnecting',
      snapshot: {
        roundId: 'r1',
        state: 'running',
        seq: 5,
        multiplier: 2.34,
        crashPoint: null,
        serverSeed: null,
        serverSeedHash: 'h1',
        bettingEndsAt: null,
        startedAt: 100,
      },
    });
    expect(state.snapshot?.multiplier).toBe(2.34);
    expect(isSnapshotStale(state)).toBe(true);
  });
});

describe('revealed round retention', () => {
  const crashedEvent = (
    seq: number,
    roundId: string,
    serverSeed: string,
    crashPoint: number,
  ): ClientGameEvent => ({
    type: 'round.crashed',
    seq,
    roundId,
    payload: { type: 'round.crashed', seq, roundId, crashPoint, serverSeed },
  });

  test('keeps the revealed seed together with the commitment of that round', () => {
    let state = withSnapshot(5);
    state = streamReducer(state, {
      type: 'game-event',
      event: crashedEvent(6, 'r1', 'seed-1', 2.34),
    });

    expect(state.lastRevealed).toEqual({
      roundId: 'r1',
      serverSeed: 'seed-1',
      serverSeedHash: 'h1',
      crashPoint: 2.34,
    });
  });

  test('survives the next round, which replaces the snapshot', () => {
    let state = withSnapshot(5);
    state = streamReducer(state, {
      type: 'game-event',
      event: crashedEvent(6, 'r1', 'seed-1', 2.34),
    });
    state = streamReducer(state, {
      type: 'game-event',
      event: {
        type: 'round.betting',
        seq: 7,
        roundId: 'r2',
        payload: { type: 'round.betting', seq: 7, roundId: 'r2', serverSeedHash: 'h2', bettingEndsAt: 999 },
      },
    });

    expect(state.snapshot?.roundId).toBe('r2');
    expect(state.snapshot?.serverSeed).toBeNull();
    expect(state.lastRevealed).toEqual({
      roundId: 'r1',
      serverSeed: 'seed-1',
      serverSeedHash: 'h1',
      crashPoint: 2.34,
    });
  });

  test('a snapshot with a seed but no crashed state is not treated as revealed', () => {
    const state = streamReducer(initialStreamState, {
      type: 'snapshot',
      upstream: 'connected',
      snapshot: {
        roundId: 'r1',
        state: 'running',
        seq: 12,
        multiplier: 1.4,
        crashPoint: null,
        serverSeed: 'leaked-seed',
        serverSeedHash: 'h1',
        bettingEndsAt: null,
        startedAt: 100,
      },
    });

    expect(state.lastRevealed).toBeNull();
  });

  test('a crashed snapshot also records the proof material', () => {
    const state = streamReducer(initialStreamState, {
      type: 'snapshot',
      upstream: 'connected',
      snapshot: {
        roundId: 'r9',
        state: 'crashed',
        seq: 30,
        multiplier: 3.5,
        crashPoint: 3.5,
        serverSeed: 'seed-9',
        serverSeedHash: 'h9',
        bettingEndsAt: null,
        startedAt: 100,
      },
    });

    expect(state.lastRevealed).toEqual({
      roundId: 'r9',
      serverSeed: 'seed-9',
      serverSeedHash: 'h9',
      crashPoint: 3.5,
    });
  });

  test('a later snapshot of the same round does not drop the commitment', () => {
    let state = withSnapshot(5);
    state = streamReducer(state, {
      type: 'game-event',
      event: crashedEvent(6, 'r1', 'seed-1', 2.34),
    });
    state = streamReducer(state, {
      type: 'snapshot',
      upstream: 'connected',
      snapshot: {
        roundId: 'r1',
        state: 'crashed',
        seq: 40,
        multiplier: 2.34,
        crashPoint: 2.34,
        serverSeed: 'seed-1',
        serverSeedHash: null,
        bettingEndsAt: null,
        startedAt: 100,
      },
    });

    expect(state.lastRevealed?.serverSeedHash).toBe('h1');
    expect(state.lastRevealed?.serverSeed).toBe('seed-1');
  });

  test('nothing is recorded while the round is still open', () => {
    const state = withSnapshot(5);
    expect(state.lastRevealed).toBeNull();
  });
});
