/**
 * Client-side state for the Crashsim operator SSE stream.
 *
 * The operator owns event ordering. This reducer mirrors its snapshot and
 * accepted round transitions, keeps a bounded event log, and tracks upstream
 * health separately from the browser's own EventSource connection.
 */

export type UpstreamConnection = 'connected' | 'reconnecting' | 'synchronizing';
export type DownstreamConnection = 'connecting' | 'open' | 'error';

export interface ClientRoundState {
  roundId: string | null;
  state: string | null;
  seq: number;
  multiplier: number | null;
  crashPoint: number | null;
  serverSeed: string | null;
  serverSeedHash: string | null;
  bettingEndsAt: number | null;
  startedAt: number | null;
}

export interface ClientGameEvent {
  type: string;
  seq: number;
  roundId: string;
  payload: unknown;
}

export interface ClientTickPoint {
  seq: number;
  elapsedMs: number;
  multiplier: number;
}

/**
 * Proof material for a round the operator already finished: the revealed seed,
 * the commitment published while it was open, and the crash point shown. Kept
 * after the round ends, because the next `round.betting` replaces the snapshot.
 */
export interface RevealedRound {
  roundId: string;
  serverSeed: string;
  serverSeedHash: string | null;
  crashPoint: number;
}

export interface OperatorStreamState {
  upstream: UpstreamConnection;
  downstream: DownstreamConnection;
  /**
   * Whether the retained snapshot is trusted as live. Opening the browser
   * connection (`onopen`) never sets it: only a snapshot from the operator, or
   * an upstream `connected` notice published after a successful resync, does.
   * Any interruption revokes it.
   */
  synchronized: boolean;
  snapshot: ClientRoundState | null;
  lastRevealed: RevealedRound | null;
  events: ClientGameEvent[];
  /** Round-local chart history, retained independently of the short event log. */
  tickHistory: ClientTickPoint[];
}

export const MAX_RETAINED_EVENTS = 100;
export const MAX_RETAINED_TICKS = 10_000;

export const initialStreamState: OperatorStreamState = {
  upstream: 'reconnecting',
  downstream: 'connecting',
  synchronized: false,
  snapshot: null,
  lastRevealed: null,
  events: [],
  tickHistory: [],
};

export type StreamAction =
  | { type: 'downstream-open' }
  | { type: 'downstream-error' }
  | { type: 'snapshot'; snapshot: ClientRoundState; upstream: UpstreamConnection }
  | { type: 'game-event'; event: ClientGameEvent }
  | { type: 'connection'; upstream: UpstreamConnection };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const toNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const toStringOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** Parses one SSE `data:` payload into a reducer action. Unknown shapes are ignored. */
export function parseOperatorFrame(data: string): StreamAction | null {
  let body: unknown;
  try {
    body = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isRecord(body)) return null;

  const kind = body.kind;
  if (kind === 'snapshot') {
    const state = isRecord(body.state) ? body.state : null;
    const connection = body.connection;
    if (!state || !isUpstream(connection)) return null;
    const seq = toNumber(state.seq);
    if (seq === null) return null;
    return {
      type: 'snapshot',
      upstream: connection,
      snapshot: {
        roundId: toStringOrNull(state.roundId),
        state: toStringOrNull(state.state),
        seq,
        multiplier: toNumber(state.multiplier),
        crashPoint: toNumber(state.crashPoint),
        serverSeed: toStringOrNull(state.serverSeed),
        serverSeedHash: toStringOrNull(state.serverSeedHash),
        bettingEndsAt: toNumber(state.bettingEndsAt),
        startedAt: toNumber(state.startedAt),
      },
    };
  }

  if (kind === 'game-event') {
    const event = isRecord(body.event) ? body.event : null;
    const seq = toNumber(body.seq);
    if (!event || seq === null) return null;
    const type = event.type;
    const roundId = event.roundId;
    if (typeof type !== 'string' || typeof roundId !== 'string') return null;
    return { type: 'game-event', event: { type, seq, roundId, payload: event } };
  }

  if (kind === 'connection') {
    const connection = body.connection;
    if (!isUpstream(connection)) return null;
    return { type: 'connection', upstream: connection };
  }

  return null;
}

const isUpstream = (value: unknown): value is UpstreamConnection =>
  value === 'connected' || value === 'reconnecting' || value === 'synchronizing';

function applyGameEventToSnapshot(
  snapshot: ClientRoundState | null,
  event: ClientGameEvent,
): ClientRoundState | null {
  const payload = isRecord(event.payload) ? event.payload : {};

  if (event.type === 'round.betting') {
    if (snapshot?.roundId === event.roundId) return { ...snapshot, seq: event.seq };
    const serverSeedHash = toStringOrNull(payload.serverSeedHash);
    const bettingEndsAt = toNumber(payload.bettingEndsAt);
    if (serverSeedHash === null || bettingEndsAt === null) return snapshot;
    return {
      roundId: event.roundId,
      state: 'betting',
      seq: event.seq,
      multiplier: null,
      crashPoint: null,
      serverSeed: null,
      serverSeedHash,
      bettingEndsAt,
      startedAt: null,
    };
  }

  if (!snapshot || snapshot.roundId !== event.roundId || event.seq <= snapshot.seq) return snapshot;

  switch (event.type) {
    case 'round.started': {
      const startedAt = toNumber(payload.startedAt);
      if (snapshot.state !== 'betting' || startedAt === null) return snapshot;
      return { ...snapshot, state: 'running', seq: event.seq, startedAt, multiplier: 1 };
    }
    case 'tick': {
      const multiplier = toNumber(payload.multiplier);
      if (snapshot.state !== 'running' || multiplier === null) return snapshot;
      return { ...snapshot, seq: event.seq, multiplier };
    }
    case 'round.crashed': {
      const crashPoint = toNumber(payload.crashPoint);
      const serverSeed = toStringOrNull(payload.serverSeed);
      if (snapshot.state === 'crashed' || crashPoint === null || serverSeed === null) return snapshot;
      return {
        ...snapshot,
        state: 'crashed',
        seq: event.seq,
        multiplier: crashPoint,
        crashPoint,
        serverSeed,
      };
    }
    default:
      return snapshot;
  }
}

/** Proof material a crashed round carries, using the commitment of that round. */
function revealedFromEvent(
  event: ClientGameEvent,
  current: ClientRoundState | null,
): RevealedRound | null {
  if (event.type !== 'round.crashed') return null;
  const payload = isRecord(event.payload) ? event.payload : {};
  const serverSeed = toStringOrNull(payload.serverSeed);
  const crashPoint = toNumber(payload.crashPoint);
  if (serverSeed === null || crashPoint === null) return null;
  const commitmentOfRound =
    current !== null && current.roundId === event.roundId ? current.serverSeedHash : null;
  return { roundId: event.roundId, serverSeed, serverSeedHash: commitmentOfRound, crashPoint };
}

/**
 * A snapshot taken after the crash already carries the revealed seed. The
 * crashed-state gate is defense in depth: the operator never sends a seed for
 * an open round, and a proof must never be assembled from one that does.
 */
function revealedFromSnapshot(snapshot: ClientRoundState): RevealedRound | null {
  if (snapshot.state !== 'crashed') return null;
  if (snapshot.serverSeed === null || snapshot.crashPoint === null || snapshot.roundId === null) {
    return null;
  }
  return {
    roundId: snapshot.roundId,
    serverSeed: snapshot.serverSeed,
    serverSeedHash: snapshot.serverSeedHash,
    crashPoint: snapshot.crashPoint,
  };
}

const keepLatestReveal = (
  current: RevealedRound | null,
  candidate: RevealedRound | null,
): RevealedRound | null => {
  if (candidate === null) return current;
  if (current !== null && current.roundId === candidate.roundId) {
    // Prefer the variant that also carries the pre-round commitment.
    return current.serverSeedHash !== null || candidate.serverSeedHash === null ? current : candidate;
  }
  return candidate;
};

export function streamReducer(state: OperatorStreamState, action: StreamAction): OperatorStreamState {
  switch (action.type) {
    case 'downstream-open':
      // A reopened connection proves nothing about the displayed snapshot:
      // only a fresh snapshot with a synchronized upstream clears staleness.
      return { ...state, downstream: 'open', synchronized: false };
    case 'downstream-error':
      return { ...state, downstream: 'error', synchronized: false };
    case 'snapshot':
      // A snapshot replaces the displayed state and resets the log baseline:
      // events at or below its seq belong to older state. It is authoritative
      // even while the upstream is still reported as `synchronizing`, because
      // the operator only publishes one after reading the current round.
      return {
        ...state,
        upstream: action.upstream,
        synchronized: true,
        snapshot: action.snapshot,
        lastRevealed: keepLatestReveal(state.lastRevealed, revealedFromSnapshot(action.snapshot)),
        events: state.events.filter((event) => event.seq > action.snapshot.seq),
        tickHistory: state.snapshot?.roundId === action.snapshot.roundId ? state.tickHistory : [],
      };
    case 'game-event': {
      if (state.snapshot && action.event.seq <= state.snapshot.seq) return state;
      if (state.events.some((event) => event.seq === action.event.seq)) return state;
      const events = [...state.events, action.event]
        .sort((left, right) => left.seq - right.seq)
        .slice(-MAX_RETAINED_EVENTS);
      return {
        ...state,
        snapshot: applyGameEventToSnapshot(state.snapshot, action.event),
        lastRevealed: keepLatestReveal(
          state.lastRevealed,
          revealedFromEvent(action.event, state.snapshot),
        ),
        events,
        tickHistory: action.event.type === 'round.betting' && action.event.roundId !== state.snapshot?.roundId
          ? []
          : appendTickPoint(state.tickHistory, state.snapshot, action.event),
      };
    }
    case 'connection':
      // `connected` is published only after a successful resync, which always
      // publishes a fresh snapshot first; anything else freezes the screen.
      return {
        ...state,
        upstream: action.upstream,
        synchronized: action.upstream === 'connected' && state.snapshot !== null,
      };
  }
}

function getTickPoint(event: ClientGameEvent): ClientTickPoint | null {
  if (event.type !== 'tick' || !isRecord(event.payload)) return null;
  const elapsedMs = toNumber(event.payload.t);
  const multiplier = toNumber(event.payload.multiplier);
  if (elapsedMs === null || multiplier === null) return null;
  return { seq: event.seq, elapsedMs, multiplier };
}

function appendTickPoint(
  history: ClientTickPoint[],
  snapshot: ClientRoundState | null,
  event: ClientGameEvent,
): ClientTickPoint[] {
  if (snapshot?.state !== 'running' || snapshot.roundId !== event.roundId) return history;
  const point = getTickPoint(event);
  if (point === null || history.some((candidate) => candidate.seq === point.seq)) return history;
  return [...history, point].slice(-MAX_RETAINED_TICKS);
}

/** True while the displayed snapshot must be treated as frozen/stale. */
export function isSnapshotStale(state: OperatorStreamState): boolean {
  return !state.synchronized || state.upstream !== 'connected' || state.downstream !== 'open';
}
