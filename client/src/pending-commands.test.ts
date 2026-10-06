import { describe, expect, test } from 'bun:test';
import {
  clearPendingPayout,
  clearPendingTopUp,
  readPendingPayout,
  readPendingTopUp,
  writePendingPayout,
  writePendingTopUp,
} from './pending-commands';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      void values.set(key, value);
    },
    removeItem: (key: string) => {
      void values.delete(key);
    },
    raw: values,
  };
}

describe('pending top-up storage', () => {
  test('round-trips a pending command and clears it', () => {
    const storage = memoryStorage();
    expect(readPendingTopUp(storage)).toBeNull();

    writePendingTopUp({ idempotencyKey: 'key-1', amountCents: 2500 }, storage);
    expect(readPendingTopUp(storage)).toEqual({ idempotencyKey: 'key-1', amountCents: 2500 });

    clearPendingTopUp(storage);
    expect(readPendingTopUp(storage)).toBeNull();
  });

  test('ignores malformed or unsafe stored values', () => {
    const storage = memoryStorage();
    storage.setItem('operator.pendingTopUp', 'not-json');
    expect(readPendingTopUp(storage)).toBeNull();

    storage.setItem('operator.pendingTopUp', JSON.stringify({ idempotencyKey: '', amountCents: 10 }));
    expect(readPendingTopUp(storage)).toBeNull();

    storage.setItem('operator.pendingTopUp', JSON.stringify({ idempotencyKey: 'k', amountCents: 0 }));
    expect(readPendingTopUp(storage)).toBeNull();

    storage.setItem('operator.pendingTopUp', JSON.stringify({ idempotencyKey: 'k', amountCents: 1.5 }));
    expect(readPendingTopUp(storage)).toBeNull();
  });

  test('never throws when storage is unavailable', () => {
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    };
    expect(readPendingTopUp(broken)).toBeNull();
    expect(() => writePendingTopUp({ idempotencyKey: 'k', amountCents: 1 }, broken)).not.toThrow();
    expect(() => clearPendingTopUp(broken)).not.toThrow();
  });
});

describe('pending payout storage', () => {
  test('keeps top-up and payout entries independent', () => {
    const storage = memoryStorage();
    writePendingTopUp({ idempotencyKey: 'top-up', amountCents: 100 }, storage);
    writePendingPayout({ idempotencyKey: 'payout', amountCents: 500 }, storage);

    expect(readPendingTopUp(storage)?.idempotencyKey).toBe('top-up');
    expect(readPendingPayout(storage)?.idempotencyKey).toBe('payout');

    clearPendingPayout(storage);
    expect(readPendingPayout(storage)).toBeNull();
    expect(readPendingTopUp(storage)).toEqual({ idempotencyKey: 'top-up', amountCents: 100 });
  });
});
