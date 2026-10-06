/**
 * Tab-scoped memory of unresolved idempotent commands.
 *
 * When a top-up or payout POST loses its response, the idempotency key and the
 * amount must survive a reload so a retry reuses the same key instead of
 * creating a second operation. Everything here is best-effort: the store never
 * throws and never holds credentials.
 */

export interface PendingAmountCommand {
  idempotencyKey: string;
  amountCents: number;
}

const TOP_UP_KEY = 'operator.pendingTopUp';
const PAYOUT_KEY = 'operator.pendingPayout';

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function parse(value: string | null): PendingAmountCommand | null {
  if (value === null) return null;
  try {
    const candidate: unknown = JSON.parse(value);
    if (candidate === null || typeof candidate !== 'object') return null;
    const record = candidate as Record<string, unknown>;
    const { idempotencyKey, amountCents } = record;
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) return null;
    if (typeof amountCents !== 'number' || !Number.isSafeInteger(amountCents) || amountCents < 1) {
      return null;
    }
    return { idempotencyKey, amountCents };
  } catch {
    return null;
  }
}

function read(storage: StorageLike, key: string): PendingAmountCommand | null {
  try {
    return parse(storage.getItem(key));
  } catch {
    return null;
  }
}

function write(storage: StorageLike, key: string, command: PendingAmountCommand): void {
  try {
    storage.setItem(key, JSON.stringify(command));
  } catch {
    // Storage can be unavailable; the in-memory state still covers this tab.
  }
}

function clear(storage: StorageLike, key: string): void {
  try {
    storage.removeItem(key);
  } catch {
    // Ignore: the command is already resolved.
  }
}

export const readPendingTopUp = (storage: StorageLike = sessionStorage): PendingAmountCommand | null =>
  read(storage, TOP_UP_KEY);
export const writePendingTopUp = (
  command: PendingAmountCommand,
  storage: StorageLike = sessionStorage,
): void => write(storage, TOP_UP_KEY, command);
export const clearPendingTopUp = (storage: StorageLike = sessionStorage): void =>
  clear(storage, TOP_UP_KEY);

export const readPendingPayout = (storage: StorageLike = sessionStorage): PendingAmountCommand | null =>
  read(storage, PAYOUT_KEY);
export const writePendingPayout = (
  command: PendingAmountCommand,
  storage: StorageLike = sessionStorage,
): void => write(storage, PAYOUT_KEY, command);
export const clearPendingPayout = (storage: StorageLike = sessionStorage): void =>
  clear(storage, PAYOUT_KEY);
