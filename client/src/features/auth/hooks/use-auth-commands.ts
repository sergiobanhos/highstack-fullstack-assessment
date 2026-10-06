import { useMutation } from '@tanstack/react-query';
import type { OperatorApi } from '../../../lib/operator/operator-api';

export function useAuthCommands(api: OperatorApi) {
  const register = useMutation({ mutationFn: (input: Parameters<OperatorApi['register']>[0]) => api.register(input) });
  const login = useMutation({ mutationFn: (input: Parameters<OperatorApi['login']>[0]) => api.login(input) });
  const logout = useMutation({ mutationFn: (token: string) => api.logout(token) });
  return { register, login, logout };
}
