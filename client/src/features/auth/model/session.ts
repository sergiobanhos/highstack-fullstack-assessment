import type { AuthUser } from '../../../lib/operator/operator-api';

export interface PlayerSession {
  token: string;
  user: AuthUser;
}
