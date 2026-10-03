/**
 * Client-side state for the Crashsim operator SSE stream.
 *
 * The operator owns all sequencing rules; this reducer only mirrors what the
 * server sends: a snapshot replaces the displayed state, newer events are
 * appended to a bounded log, and upstream health is tracked separately from
 * the browser's own EventSource connection.
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

export interface OperatorStreamState {
  upstream: UpstreamConnection;
  downstream: DownstreamConnection;
  snapshot: ClientRoundState | null;
  events: ClientGameEvent[];
}

export const MAX_RETAINED_EVENTS = 100;

export const initialStreamState: OperatorStreamState = {
  upstream: 'reconnecting',
  downstream: 'connecting',
  snapshot: null,
  events: [],
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

export function streamReducer(state: OperatorStreamState, action: StreamAction): OperatorStreamState {
  switch (action.type) {
    case 'downstream-open':
      return { ...state, downstream: 'open' };
    case 'downstream-error':
      return { ...state, downstream: 'error' };
    case 'snapshot':
      // A snapshot replaces the displayed state and resets the log baseline:
      // events at or below its seq belong to older state.
      return {
        ...state,
        upstream: action.upstream,
        snapshot: action.snapshot,
        events: state.events.filter((event) => event.seq > action.snapshot.seq),
      };
    case 'game-event': {
      if (state.snapshot && action.event.seq <= state.snapshot.seq) return state;
      if (state.events.some((event) => event.seq === action.event.seq)) return state;
      const events = [...state.events, action.event]
        .sort((left, right) => left.seq - right.seq)
        .slice(-MAX_RETAINED_EVENTS);
      return { ...state, events };
    }
    case 'connection':
      return { ...state, upstream: action.upstream };
  }
}

/** True while the displayed snapshot must be treated as frozen/stale. */
export function isSnapshotStale(state: OperatorStreamState): boolean {
  return state.upstream !== 'connected' || state.downstream !== 'open';
}
