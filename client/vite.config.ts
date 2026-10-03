import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Local-development-only debug client. The browser talks to the operator, never
// to the engine: the Crashsim SSE path is proxied to the operator service over
// the Compose network.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/game/events': {
        target: process.env.OPERATOR_URL ?? 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
