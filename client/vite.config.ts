import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Local player client. The browser talks to the operator, never to the engine:
// auth, wallet, game, and payout paths (including the SSE stream) are proxied
// to the operator service over the Compose network.
const operatorUrl = process.env.OPERATOR_URL ?? 'http://localhost:3000';
const operatorPaths = ['/auth', '/wallet', '/game', '/payouts'];

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: Object.fromEntries(
      operatorPaths.map((path) => [path, { target: operatorUrl, changeOrigin: true }]),
    ),
  },
});
