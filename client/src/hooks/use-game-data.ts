import { useCallback, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { OperatorApi } from '../operator-api';
import { queryKeys } from '../query-keys';
import { useUnauthorizedQueryHandler, type PlayerQueryContext } from './query-context';

export function usePlayerGameSession(context: PlayerQueryContext) {
  const mutation = useMutation({ mutationFn: () => context.api.createSession(context.token), retry: false });
  useUnauthorizedQueryHandler(mutation.error, context.onUnauthorized);
  return mutation;
}

export function usePlayerBets(context: PlayerQueryContext, limit = 10) {
  const query = useQuery({
    queryKey: queryKeys.bets(context.playerId, limit),
    queryFn: () => context.api.listBets(context.token, limit),
    enabled: context.token.length > 0,
    staleTime: 0,
  });
  useUnauthorizedQueryHandler(query.error, context.onUnauthorized);
  return query;
}

export function usePlayerBetLookups(context: PlayerQueryContext) {
  const queryClient = useQueryClient();
  const command = useCallback((commandId: string) => queryClient.fetchQuery({
    queryKey: queryKeys.command(context.playerId, commandId),
    queryFn: () => context.api.getCommand(context.token, commandId),
    staleTime: 0,
    retry: false,
  }), [context.api, context.playerId, context.token, queryClient]);
  const bet = useCallback((betId: string) => queryClient.fetchQuery({
    queryKey: queryKeys.bet(context.playerId, betId),
    queryFn: () => context.api.getBet(context.token, betId),
    staleTime: 0,
    retry: false,
  }), [context.api, context.playerId, context.token, queryClient]);
  return useMemo(() => ({ command, bet }), [command, bet]);
}

export function usePlayerGameCommands(context: PlayerQueryContext) {
  const queryClient = useQueryClient();
  const refresh = async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.bets(context.playerId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.wallet(context.playerId) }),
    ]);
  };
  const placeBet = useMutation({
    mutationFn: (input: Parameters<OperatorApi['placeBet']>[1]) => context.api.placeBet(context.token, input),
    onSuccess: refresh,
  });
  const cashout = useMutation({
    mutationFn: (input: Parameters<OperatorApi['cashout']>[1]) => context.api.cashout(context.token, input),
    onSuccess: refresh,
  });
  return { placeBet, cashout };
}
