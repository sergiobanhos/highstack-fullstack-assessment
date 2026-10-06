import { describe, expect, test } from 'bun:test';
import { GameEventFanout } from './event-fanout';
import type { OperatorMessage, OperatorSnapshot } from './round-state';

const snapshot = (seq: number): OperatorSnapshot => ({
  state: {
    roundId: 'r1',
    state: 'running',
    seq,
    serverSeedHash: 'hash',
    bettingEndsAt: null,
    startedAt: 100,
    multiplier: 1.2,
    crashPoint: null,
    serverSeed: null,
  },
  connection: 'connected',
});

const gameEvent = (seq: number): OperatorMessage => ({
  kind: 'game-event',
  seq,
  event: { type: 'tick', seq, roundId: 'r1', multiplier: seq / 10, t: seq * 100 },
});

describe('GameEventFanout', () => {
  test('captures the snapshot and queues a concurrent newer event for delivery after it', () => {
    const hub = new GameEventFanout();
    const received: OperatorMessage[] = [];
    const subscription = hub.subscribeWithSnapshot(() => {
      hub.publish(gameEvent(11));
      return snapshot(10);
    });

    expect(subscription.seq).toBe(10);
    subscription.activate((message) => received.push(message));
    expect(received).toEqual([gameEvent(11)]);
  });

  test('discards queued events at or below the captured sequence baseline', () => {
    const hub = new GameEventFanout();
    const subscription = hub.subscribeWithSnapshot(() => snapshot(10));
    hub.publish(gameEvent(9));
    hub.publish(gameEvent(10));
    hub.publish(gameEvent(11));

    const received: OperatorMessage[] = [];
    subscription.activate((message) => received.push(message));
    expect(received).toEqual([gameEvent(11)]);
  });

  test('always delivers connection health and then forwards live events', () => {
    const hub = new GameEventFanout();
    const subscription = hub.subscribeWithSnapshot(() => snapshot(100));
    const received: OperatorMessage[] = [];
    subscription.activate((message) => received.push(message));

    hub.publish({ kind: 'connection', connection: 'reconnecting' });
    hub.publish(gameEvent(101));
    expect(received).toEqual([
      { kind: 'connection', connection: 'reconnecting' },
      gameEvent(101),
    ]);
  });

  test('unsubscribe removes the subscriber and stops delivery', () => {
    const hub = new GameEventFanout();
    const subscription = hub.subscribeWithSnapshot(() => snapshot(0));
    const received: OperatorMessage[] = [];
    subscription.activate((message) => received.push(message));
    expect(hub.subscriberCount).toBe(1);

    subscription.unsubscribe();
    hub.publish(gameEvent(1));
    expect(hub.subscriberCount).toBe(0);
    expect(received).toEqual([]);
  });

  test('fans out to active subscribers independently', () => {
    const hub = new GameEventFanout();
    const first = hub.subscribeWithSnapshot(() => snapshot(0));
    const second = hub.subscribeWithSnapshot(() => snapshot(0));
    const firstReceived: OperatorMessage[] = [];
    const secondReceived: OperatorMessage[] = [];
    first.activate((message) => firstReceived.push(message));
    second.activate((message) => secondReceived.push(message));

    hub.publish(gameEvent(1));
    first.unsubscribe();
    hub.publish(gameEvent(2));

    expect(firstReceived).toEqual([gameEvent(1)]);
    expect(secondReceived).toEqual([gameEvent(1), gameEvent(2)]);
    expect(hub.subscriberCount).toBe(1);
  });

  test('removes a partially registered subscriber if snapshot capture throws', () => {
    const hub = new GameEventFanout();
    expect(() =>
      hub.subscribeWithSnapshot(() => {
        throw new Error('snapshot failed');
      }),
    ).toThrow('snapshot failed');
    expect(hub.subscriberCount).toBe(0);
  });
});
