import { useEffect, useReducer } from 'react';
import {
  initialStreamState,
  isSnapshotStale,
  parseOperatorFrame,
  streamReducer,
} from './operator-events.client';

const STREAM_URL = '/game/events';
const STREAM_EVENTS = ['snapshot', 'game-event', 'connection'] as const;

/**
 * Local-only diagnostic page for the Crashsim operator stream.
 *
 * Plain text on purpose: connection health, the current synchronized snapshot,
 * and a bounded event log. No betting or cashout controls, no styling scope,
 * and no direct engine access — the browser only talks to the operator.
 */
export function App(): React.JSX.Element {
  const [state, dispatch] = useReducer(streamReducer, initialStreamState);
  const stale = isSnapshotStale(state);

  useEffect(() => {
    const source = new EventSource(STREAM_URL);
    source.onopen = () => dispatch({ type: 'downstream-open' });
    source.onerror = () => dispatch({ type: 'downstream-error' });
    const receive = (message: Event) => {
      const frame = message as MessageEvent<string>;
      const action = parseOperatorFrame(frame.data);
      if (action) dispatch(action);
    };
    for (const eventName of STREAM_EVENTS) source.addEventListener(eventName, receive);
    return () => {
      for (const eventName of STREAM_EVENTS) source.removeEventListener(eventName, receive);
      source.close();
    };
  }, []);

  const snapshot = state.snapshot;

  return (
    <main>
      <h1>Crashsim operator — debug stream</h1>
      <p>Local development only. No betting or cashout controls.</p>

      <section>
        <h2>Connection</h2>
        <p>
          Upstream engine: <strong>{state.upstream}</strong>
          {state.upstream !== 'connected' ? ' (reconnecting — snapshot frozen)' : ''}
        </p>
        <p>
          Downstream operator stream: <strong>{state.downstream}</strong>
        </p>
      </section>

      <section>
        <h2>Current snapshot{stale ? ' (stale)' : ''}</h2>
        {snapshot ? (
          <dl>
            <dt>roundId</dt>
            <dd>{snapshot.roundId ?? '—'}</dd>
            <dt>state</dt>
            <dd>{snapshot.state ?? '—'}</dd>
            <dt>seq</dt>
            <dd>{snapshot.seq}</dd>
            <dt>multiplier</dt>
            <dd>{snapshot.multiplier ?? '—'}</dd>
            <dt>crashPoint</dt>
            <dd>{snapshot.crashPoint ?? '—'}</dd>
            <dt>serverSeed</dt>
            <dd>{snapshot.serverSeed ?? '—'}</dd>
          </dl>
        ) : (
          <p>Waiting for the first snapshot…</p>
        )}
      </section>

      <section>
        <h2>Events ({state.events.length})</h2>
        {state.events.length === 0 ? (
          <p>No events yet.</p>
        ) : (
          <ol>
            {state.events.map((event) => (
              <li key={event.seq}>
                {event.type} seq={event.seq} roundId={event.roundId}{' '}
                <code>{JSON.stringify(event.payload)}</code>
              </li>
            ))}
          </ol>
        )}
      </section>
    </main>
  );
}
