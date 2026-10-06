import { describe, expect, test } from 'bun:test';
import {
  applyEvent,
  applySnapshot,
  emptyRoundState,
  type GameEvent,
  type RoundSnapshot,
  type RoundState,
} from './round-state';

const betting = (seq: number, roundId = 'r1'): GameEvent => ({
  type: 'round.betting',
  seq,
  roundId,
  serverSeedHash: `hash-${roundId}`,
  bettingEndsAt: 1_000 + seq,
});

const started = (seq: number, roundId = 'r1'): GameEvent => ({
  type: 'round.started',
  seq,
  roundId,
  startedAt: 2_000 + seq,
});

const tick = (seq: number, multiplier: number, roundId = 'r1'): GameEvent => ({
  type: 'tick',
  seq,
  roundId,
  multiplier,
  t: seq * 100,
});

const crashed = (seq: number, crashPoint = 2.5, roundId = 'r1'): GameEvent => ({
  type: 'round.crashed',
  seq,
  roundId,
  crashPoint,
  serverSeed: `seed-${roundId}`,
});

const reduce = (events: GameEvent[], from: RoundState = emptyRoundState()): RoundState =>
  events.reduce(applyEvent, from);

describe('applyEvent', () => {
  test('walks a round from betting through running to crashed', () => {
    const state = reduce([betting(1), started(2), tick(3, 1.5), tick(4, 2.1), crashed(5, 2.5)]);

    expect(state.roundId).toBe('r1');
    expect(state.state).toBe('crashed');
    expect(state.seq).toBe(5);
    expect(state.serverSeedHash).toBe('hash-r1');
    expect(state.startedAt).toBe(2_002);
    expect(state.bettingEndsAt).toBe(1_001);
    expect(state.crashPoint).toBe(2.5);
    expect(state.serverSeed).toBe('seed-r1');
    expect(state.multiplier).toBe(2.5);
  });

  test('ignores duplicate and older sequences', () => {
    const afterTick = reduce([betting(1), started(2), tick(3, 1.5)]);

    expect(applyEvent(afterTick, tick(3, 1.5))).toBe(afterTick);
    expect(applyEvent(afterTick, tick(2, 9.9))).toBe(afterTick);
    expect(applyEvent(afterTick, { ...betting(2) })).toBe(afterTick);
  });

  test('keeps a crashed round terminal when a late tick has a lower seq (REORDER=1)', () => {
    const crashedState = reduce([betting(1), started(2), tick(3, 2.0), crashed(5, 2.5)]);

    // Held ticks are created before the crash event, so they carry a *lower* seq
    // but are delivered after it.
    const lateLower = applyEvent(crashedState, tick(4, 2.2));
    expect(lateLower).toBe(crashedState);

    // Even a tick with a newer seq must not revive a terminal round.
    const lateHigher = applyEvent(crashedState, tick(6, 2.4));
    expect(lateHigher).toBe(crashedState);
    expect(lateHigher.state).toBe('crashed');
    expect(lateHigher.multiplier).toBe(2.5);
  });

  test('starts a new round on the next betting event after a crash', () => {
    const crashedState = reduce([betting(1), started(2), crashed(3, 1.1)]);
    const next = applyEvent(crashedState, betting(4, 'r2'));

    expect(next.roundId).toBe('r2');
    expect(next.state).toBe('betting');
    expect(next.seq).toBe(4);
    expect(next.crashPoint).toBeNull();
    expect(next.serverSeed).toBeNull();
    expect(next.startedAt).toBeNull();
  });

  test('ignores events for a round that is not being tracked', () => {
    const state = reduce([betting(1)]);
    expect(applyEvent(state, started(2, 'other'))).toBe(state);
    expect(applyEvent(state, tick(3, 1.5, 'other'))).toBe(state);
    expect(applyEvent(state, crashed(4, 2, 'other'))).toBe(state);
  });

  test('ignores round.started and tick before the round is running', () => {
    const state = reduce([betting(1)]);
    expect(applyEvent(state, started(2))).toEqual({ ...state, state: 'running', startedAt: 2_002, multiplier: 1, seq: 2 });

    const stillBetting = reduce([betting(1)]);
    expect(applyEvent(stillBetting, tick(2, 1.4))).toBe(stillBetting);
  });

  test('accepts a crash that follows betting directly (instant crash)', () => {
    const state = reduce([betting(1), crashed(2, 1.0)]);
    expect(state.state).toBe('crashed');
    expect(state.multiplier).toBe(1.0);
    expect(state.serverSeedHash).toBe('hash-r1');
  });

  test('re-reports betting for the tracked round without resetting it', () => {
    const state = reduce([betting(1), started(2), tick(3, 1.5)]);
    const repeated = applyEvent(state, betting(4));

    expect(repeated.roundId).toBe('r1');
    expect(repeated.state).toBe('running');
    expect(repeated.multiplier).toBe(1.5);
    expect(repeated.seq).toBe(4);
  });
});

describe('applySnapshot', () => {
  test('replaces state with the authoritative current-round snapshot', () => {
    const snapshot: RoundSnapshot = {
      roundId: 'r9',
      state: 'running',
      seq: 42,
      serverSeedHash: 'hash-r9',
      startedAt: 5_000,
      multiplier: 1.8,
    };

    const state = applySnapshot(snapshot);
    expect(state).toEqual({
      roundId: 'r9',
      state: 'running',
      seq: 42,
      serverSeedHash: 'hash-r9',
      bettingEndsAt: null,
      startedAt: 5_000,
      multiplier: 1.8,
      crashPoint: null,
      serverSeed: null,
    });
  });

  test('a snapshot drops any earlier round state', () => {
    const stale = reduce([betting(1), started(2), tick(3, 2.0)]);
    const fresh = applySnapshot({ roundId: 'r2', state: 'betting', seq: 10, serverSeedHash: 'h2', bettingEndsAt: 9 });
    expect(fresh.roundId).toBe('r2');
    expect(fresh.state).toBe('betting');
    expect(fresh.multiplier).toBeNull();
    expect(applyEvent(fresh, tick(4, 3.0))).toBe(fresh); // stale seq and unknown round
    expect(stale.roundId).toBe('r1');
  });
});
