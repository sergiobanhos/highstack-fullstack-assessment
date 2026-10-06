import type { OperatorMessage, OperatorSnapshot } from './round-state';
import type { GameEventSubscription } from './contracts';

interface Subscriber {
  baselineSeq: number;
  queue: OperatorMessage[];
  onMessage: ((message: OperatorMessage) => void) | null;
  closed: boolean;
}

/** In-process fan-out for the single Crashsim stream. */
export class GameEventFanout {
  private readonly subscribers = new Set<Subscriber>();

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  publish(message: OperatorMessage): void {
    for (const subscriber of this.subscribers) {
      if (subscriber.closed) continue;
      if (subscriber.onMessage) subscriber.onMessage(message);
      else subscriber.queue.push(message);
    }
  }

  /**
   * Registers a subscriber and captures the current view in the same
   * synchronous turn. Updates published before activation are queued so the
   * caller can write the snapshot first without dropping a concurrent event.
   */
  subscribeWithSnapshot(capture: () => OperatorSnapshot): GameEventSubscription {
    const subscriber: Subscriber = {
      baselineSeq: 0,
      queue: [],
      onMessage: null,
      closed: false,
    };

    this.subscribers.add(subscriber);
    let snapshot: OperatorSnapshot;
    try {
      snapshot = capture();
      subscriber.baselineSeq = snapshot.state.seq;
    } catch (error) {
      this.subscribers.delete(subscriber);
      throw error;
    }

    return {
      snapshot,
      seq: subscriber.baselineSeq,
      activate: (onMessage) => {
        if (subscriber.closed || subscriber.onMessage) return;
        subscriber.onMessage = onMessage;
        const queued = subscriber.queue;
        subscriber.queue = [];
        for (const message of queued) {
          if (subscriber.closed) break;
          const seq = message.kind === 'connection' ? undefined : message.seq;
          if (seq === undefined || seq > subscriber.baselineSeq) onMessage(message);
        }
      },
      unsubscribe: () => {
        subscriber.closed = true;
        subscriber.queue = [];
        subscriber.onMessage = null;
        this.subscribers.delete(subscriber);
      },
    };
  }
}
