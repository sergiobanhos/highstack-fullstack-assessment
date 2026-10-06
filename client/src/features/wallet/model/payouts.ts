/**
 * Local payout list bookkeeping: the operator is the only source of truth, so
 * list pages and refreshes are merged by payout id instead of being appended
 * blindly (which would duplicate rows or keep stale `processing` states).
 */

import type { Payout } from '../../../lib/operator/operator-api';

/** Appends an older page, refreshing any ids that were already known. */
export function mergePayoutPage<T extends Payout>(current: T[], incoming: T[]): T[] {
  const refreshed = new Map(incoming.map((payout) => [payout.id, payout]));
  const seen = new Set<string>();
  const merged = current.map((payout) => {
    seen.add(payout.id);
    return refreshed.get(payout.id) ?? payout;
  });
  for (const payout of incoming) {
    if (!seen.has(payout.id)) merged.push(payout);
  }
  return merged;
}

/** Inserts or replaces one payout, keeping the newest first. */
export function upsertPayout<T extends Payout>(current: T[], updated: T): T[] {
  const index = current.findIndex((payout) => payout.id === updated.id);
  if (index < 0) return [updated, ...current];
  const next = current.slice();
  next[index] = updated;
  return next;
}
