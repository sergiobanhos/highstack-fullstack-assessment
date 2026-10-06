import type { AuthServiceErrorCode } from './auth.contracts';

const ERROR_MESSAGES: Record<AuthServiceErrorCode, string> = {
  EMAIL_IN_USE: 'Email is already registered',
  INVALID_CREDENTIALS: 'Invalid email or password',
  RATE_LIMITED: 'Too many authentication operations',
};

export class AuthServiceError extends Error {
  constructor(readonly code: AuthServiceErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'AuthServiceError';
  }
}
