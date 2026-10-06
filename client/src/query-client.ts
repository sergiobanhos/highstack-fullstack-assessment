import { QueryClient } from '@tanstack/react-query';
import { OperatorApiError } from './operator-api';

/** Shared cache policy for operator reads. Writes are never retried automatically. */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      retry: (failureCount, error) => {
        if (error instanceof OperatorApiError && error.status !== null && error.status < 500) {
          return false;
        }
        return failureCount < 1;
      },
      refetchOnWindowFocus: false,
    },
    mutations: { retry: false },
  },
});
