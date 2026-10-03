const engineStreamUrl = new URL(
  process.env.ENGINE_STREAM_URL ?? 'ws://localhost:4000/stream',
);
const operatorKey = process.env.ENGINE_OPERATOR_KEY ?? 'dev-operator-key';

// The engine accepts the operator key as a query parameter for local stream clients.
engineStreamUrl.searchParams.set('key', operatorKey);

const streamTarget = `${engineStreamUrl.origin}${engineStreamUrl.pathname}`;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let stopped = false;
let socket: WebSocket | undefined;

function scheduleReconnect() {
  if (stopped || reconnectTimer) return;

  console.log('[operator] retrying engine stream in 1 second');
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    connect();
  }, 1_000);
}

function connect() {
  console.log(`[operator] connecting to ${streamTarget}`);
  socket = new WebSocket(engineStreamUrl);

  socket.addEventListener('open', () => {
    console.log('[operator] connected to engine stream');
  });

  socket.addEventListener('message', ({ data }) => {
    const raw = typeof data === 'string' ? data : String(data);

    try {
      const event = JSON.parse(raw);
      console.log(`[engine event] ${JSON.stringify(event)}`);
    } catch {
      console.log(`[engine message] ${raw}`);
    }
  });

  socket.addEventListener('error', () => {
    console.error('[operator] engine stream connection error');
  });

  socket.addEventListener('close', ({ code, reason }) => {
    console.log(`[operator] engine stream closed (code=${code}, reason=${reason || 'none'})`);
    scheduleReconnect();
  });
}

function stop() {
  stopped = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  socket?.close(1000, 'smoke test stopped');
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);

connect();
