import { useQuery } from '@tanstack/react-query';
import type { OperatorApi } from '../../../lib/operator/operator-api';

interface StoredSession {
  token: string;
  user: Awaited<ReturnType<OperatorApi['me']>>;
}

function readSessionToken(): string | null {
  try {
    return sessionStorage.getItem('operator.sessionToken');
  } catch {
    return null;
  }
}

/** Restores the current tab session through the operator's identity endpoint. */
export function useAuthSessionRestore(api: OperatorApi, retryKey: number) {
  return useQuery<StoredSession | null>({
    queryKey: ['auth', 'restore', retryKey],
    queryFn: async () => {
      const token = readSessionToken();
      if (token === null) return null;
      const user = await api.me(token);
      return { token, user };
    },
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
}
