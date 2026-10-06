import { useEffect, useReducer, useRef, useState } from 'react';
import {
  initialStreamState,
  isSnapshotStale,
  parseOperatorFrame,
  streamReducer,
  type OperatorStreamState,
} from '../data/operator-events.client';

const STREAM_URL = '/game/events';
const STREAM_EVENTS = ['snapshot', 'game-event', 'connection'] as const;
const STREAM_RECONNECT_DELAY_MS = 1500;
const STREAM_SILENCE_MS = 5000;
const STREAM_SILENCE_IDLE_MS = 15000;
const STREAM_SILENCE_CHECK_MS = 2000;

/** Owns the live SSE connection and its recovery lifecycle, outside REST query state. */
export function useGameStream(): { stream: OperatorStreamState; stale: boolean } {
  const [stream, dispatch] = useReducer(streamReducer, initialStreamState);
  const [streamAttempt, setStreamAttempt] = useState(0);
  const lastFrameAtRef = useRef<number>(Date.now());
  const stale = isSnapshotStale(stream);
  const phase = stream.snapshot?.state ?? null;

  useEffect(() => {
    lastFrameAtRef.current = Date.now();
    const source = new EventSource(STREAM_URL);
    source.onopen = () => dispatch({ type: 'downstream-open' });
    source.onerror = () => dispatch({ type: 'downstream-error' });
    const receive = (message: Event): void => {
      const action = parseOperatorFrame((message as MessageEvent<string>).data);
      if (action) {
        lastFrameAtRef.current = Date.now();
        dispatch(action);
      }
    };
    for (const eventName of STREAM_EVENTS) source.addEventListener(eventName, receive);
    return () => {
      for (const eventName of STREAM_EVENTS) source.removeEventListener(eventName, receive);
      source.close();
    };
  }, [streamAttempt]);

  useEffect(() => {
    if (stream.downstream !== 'error') return;
    const timer = setTimeout(() => setStreamAttempt((count) => count + 1), STREAM_RECONNECT_DELAY_MS);
    return () => clearTimeout(timer);
  }, [stream.downstream, streamAttempt]);

  useEffect(() => {
    const threshold = phase === 'running' ? STREAM_SILENCE_MS : STREAM_SILENCE_IDLE_MS;
    const timer = setInterval(() => {
      if (!stale && Date.now() - lastFrameAtRef.current > threshold) {
        setStreamAttempt((count) => count + 1);
      }
    }, STREAM_SILENCE_CHECK_MS);
    return () => clearInterval(timer);
  }, [phase, stale]);

  return { stream, stale };
}
