import { AuthServiceError } from '../auth.errors';

const PASSWORD_OPTIONS = {
  algorithm: 'argon2id' as const,
  memoryCost: 65_536,
  timeCost: 2,
};

// Keep unknown-email checks at the same Argon2id cost as a real password check.
const DUMMY_PASSWORD_HASH =
  '$argon2id$v=19$m=65536,t=2,p=1$YcyRAqI5I0Kz7gPRX8P2o3w/8ai+Hz1xXzZYyaSKh+U$mFwCFiOYFrAYmuzEfWsqksLnjRmnGhx7jdN7FWdyJ4A';
const MAX_CONCURRENT_HASH_OPERATIONS = 2;

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(password: string, passwordHash: string | undefined): Promise<boolean>;
}

/** Bounds expensive Argon2 work for the process and preserves dummy verification. */
export function createPasswordHasher(): PasswordHasher {
  let activeOperations = 0;

  async function withCapacity<T>(operation: () => Promise<T>): Promise<T> {
    if (activeOperations >= MAX_CONCURRENT_HASH_OPERATIONS) {
      throw new AuthServiceError('RATE_LIMITED');
    }

    activeOperations += 1;
    try {
      return await operation();
    } finally {
      activeOperations -= 1;
    }
  }

  return {
    hash: (password) => withCapacity(() => Bun.password.hash(password, PASSWORD_OPTIONS)),
    verify: (password, passwordHash) =>
      withCapacity(() => Bun.password.verify(password, passwordHash ?? DUMMY_PASSWORD_HASH)),
  };
}
