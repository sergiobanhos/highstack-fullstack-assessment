
/** Internal Crashsim events after validation and translation at the engine boundary. */
export type GameEvent =
  | {
      type: 'round.betting';
      seq: number;
      roundId: string;
      serverSeedHash: string;
      bettingEndsAt: number;
    }
  | { type: 'round.started'; seq: number; roundId: string; startedAt: number }
  | { type: 'tick'; seq: number; roundId: string; multiplier: number; t: number }
  | { type: 'round.crashed'; seq: number; roundId: string; crashPoint: number; serverSeed: string };

export type RoundStateName = 'betting' | 'running' | 'crashed';

/** Upstream engine connection health, mirrored to downstream clients. */
export type ConnectionState = 'connected' | 'reconnecting' | 'synchronizing';

/** In-process view of the current round. Never projected forward while stale. */
export interface RoundState {
  roundId: string | null;
  state: RoundStateName | null;
  /** Global engine sequence applied to this state. */
  seq: number;
  serverSeedHash: string | null;
  bettingEndsAt: number | null;
  startedAt: number | null;
  multiplier: number | null;
  crashPoint: number | null;
  serverSeed: string | null;
}

/**
 * Authoritative current-round state read from the provider. This is the engine's
 * present state only; the provider exposes no event history to replay.
 */
export interface RoundSnapshot {
  roundId: string;
  state: RoundStateName;
  seq: number;
  serverSeedHash?: string;
  bettingEndsAt?: number;
  startedAt?: number;
  multiplier?: number;
  crashPoint?: number;
  serverSeed?: string;
}

export function emptyRoundState(): RoundState {
  return {
    roundId: null,
    state: null,
    seq: 0,
    serverSeedHash: null,
    bettingEndsAt: null,
    startedAt: null,
    multiplier: null,
    crashPoint: null,
    serverSeed: null,
  };
}

/** Replaces the tracked state with an authoritative snapshot (current state, not history). */
export function applySnapshot(snapshot: RoundSnapshot): RoundState {
  return {
    roundId: snapshot.roundId,
    state: snapshot.state,
    seq: snapshot.seq,
    serverSeedHash: snapshot.serverSeedHash ?? null,
    bettingEndsAt: snapshot.bettingEndsAt ?? null,
    startedAt: snapshot.startedAt ?? null,
    multiplier: snapshot.multiplier ?? null,
    crashPoint: snapshot.crashPoint ?? null,
    serverSeed: snapshot.serverSeed ?? null,
  };
}

/**
 * Reduces one normalized event into the current round state.
 *
 * Round state only moves forward:
 * - a duplicate or older `seq` never changes state;
 * - only `round.betting` may change the tracked round identity;
 * - events for a round we are not tracking are ignored;
 * - a `tick` after that round is `crashed` is ignored, even if it arrives late
 *   with a newer sequence (the round is terminal).
 */
export function applyEvent(state: RoundState, event: GameEvent): RoundState {
  if (event.seq <= state.seq) return state;

  if (event.type === 'round.betting') {
    // Re-emitting betting for the tracked round only advances the sequence.
    if (event.roundId === state.roundId) return { ...state, seq: event.seq };
    return {
      roundId: event.roundId,
      state: 'betting',
      seq: event.seq,
      serverSeedHash: event.serverSeedHash,
      bettingEndsAt: event.bettingEndsAt,
      startedAt: null,
      multiplier: null,
      crashPoint: null,
      serverSeed: null,
    };
  }

  if (event.roundId !== state.roundId) return state;

  switch (event.type) {
    case 'round.started':
      if (state.state !== 'betting') return state;
      return { ...state, state: 'running', startedAt: event.startedAt, multiplier: 1, seq: event.seq };
    case 'tick':
      if (state.state !== 'running') return state;
      return { ...state, multiplier: event.multiplier, seq: event.seq };
    case 'round.crashed':
      if (state.state === 'crashed') return state;
      return {
        ...state,
        state: 'crashed',
        crashPoint: event.crashPoint,
        serverSeed: event.serverSeed,
        multiplier: event.crashPoint,
        seq: event.seq,
      };
  }
}

/** Downstream snapshot payload handed to each new subscriber. */
export interface OperatorSnapshot {
  state: RoundState;
  connection: ConnectionState;
}

/**
 * Messages the operator owns and sends downstream. `seq` is present only for
 * game events; the hub uses it to discard messages at or below a subscriber's
 * snapshot baseline.
 */
export type OperatorMessage =
  | { kind: 'snapshot'; seq: number; state: RoundState; connection: ConnectionState }
  | { kind: 'game-event'; seq: number; event: GameEvent }
  | { kind: 'connection'; connection: ConnectionState };
