import type { OperatorMessage, OperatorSnapshot } from './round-state';

export interface GameEventSubscription {
  readonly snapshot: OperatorSnapshot;
  readonly seq: number;
  /** Starts delivery after the caller writes the captured snapshot. */
  activate(onMessage: (message: OperatorMessage) => void): void;
  unsubscribe(): void;
}
