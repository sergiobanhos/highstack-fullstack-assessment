import { useCallback } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { OperatorApi } from '../../../lib/operator/operator-api';
import { queryKeys } from '../../../lib/query/query-keys';
import { useUnauthorizedQueryHandler, type PlayerQueryContext } from '../../../lib/query/query-context';

export function usePlayerWallet(context: PlayerQueryContext) {
  const query = useQuery({
    queryKey: queryKeys.wallet(context.playerId),
    queryFn: () => context.api.getWallet(context.token),
    enabled: context.token.length > 0,
  });
  useUnauthorizedQueryHandler(query.error, context.onUnauthorized);
  return query;
}

export function usePlayerTransactions(context: PlayerQueryContext) {
  const query = useInfiniteQuery({
    queryKey: queryKeys.transactions(context.playerId),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => context.api.getTransactions(context.token, { limit: 20, ...(pageParam ? { cursor: pageParam } : {}) }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: context.token.length > 0,
  });
  useUnauthorizedQueryHandler(query.error, context.onUnauthorized);
  return query;
}

export function usePlayerPayouts(context: PlayerQueryContext) {
  const query = useInfiniteQuery({
    queryKey: queryKeys.payouts(context.playerId),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => context.api.listPayouts(context.token, { limit: 50, ...(pageParam ? { cursor: pageParam } : {}) }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: context.token.length > 0,
  });
  useUnauthorizedQueryHandler(query.error, context.onUnauthorized);
  return query;
}

export function usePlayerPayoutLookup(context: PlayerQueryContext) {
  const queryClient = useQueryClient();
  return useCallback((payoutId: string) => queryClient.fetchQuery({
    queryKey: queryKeys.payout(context.playerId, payoutId),
    queryFn: () => context.api.getPayout(context.token, payoutId),
    staleTime: 0,
    retry: false,
  }), [context.api, context.playerId, context.token, queryClient]);
}

export function usePlayerWalletCommands(context: PlayerQueryContext) {
  const queryClient = useQueryClient();
  const refreshFinancialData = async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.wallet(context.playerId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.transactions(context.playerId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.payouts(context.playerId) }),
    ]);
  };
  const topUp = useMutation({
    mutationFn: (input: Parameters<OperatorApi['requestTopUp']>[1]) => context.api.requestTopUp(context.token, input),
    onSuccess: refreshFinancialData,
  });
  const payout = useMutation({
    mutationFn: (input: Parameters<OperatorApi['createPayout']>[1]) => context.api.createPayout(context.token, input),
    onSuccess: refreshFinancialData,
  });
  return { topUp, payout };
}
