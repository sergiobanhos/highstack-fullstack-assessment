export type AuthServiceErrorCode = 'EMAIL_IN_USE' | 'INVALID_CREDENTIALS' | 'RATE_LIMITED';

export interface AuthenticatedPlayer {
  id: string;
  name: string;
  email: string;
}

export interface RegisterPlayerInput {
  name: string;
  email: string;
  password: string;
}

export interface LoginPlayerInput {
  email: string;
  password: string;
}

export interface LoginResult {
  token: string;
  expiresAt: Date;
  user: AuthenticatedPlayer;
}

export interface AuthService {
  register(input: RegisterPlayerInput): Promise<AuthenticatedPlayer>;
  login(input: LoginPlayerInput): Promise<LoginResult>;
  logout(token: string): Promise<void>;
  resolveSession(token: string): Promise<AuthenticatedPlayer | null>;
}
