import { useEffect } from 'react';
import type { OperatorApi } from '../operator/operator-api';

export interface PlayerQueryContext {
  api: OperatorApi;
  token: string;
  playerId: string;
  onUnauthorized(): void;
}

export function useUnauthorizedQueryHandler(error: unknown, onUnauthorized: () => void): void {
  useEffect(() => {
    if (error instanceof Error && 'status' in error && error.status === 401) onUnauthorized();
  }, [error, onUnauthorized]);
}
