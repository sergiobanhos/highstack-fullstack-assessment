import { describe, expect, test } from 'bun:test';
import type { Payout } from '../../../lib/operator/operator-api';
import { mergePayoutPage, upsertPayout } from './payouts';

const payout = (id: string, overrides: Partial<Payout> = {}): Payout => ({
  id,
  amountCents: 500,
  currency: 'USD',
  status: 'processing',
  requestedAt: '2026-10-05T10:20:30.123456Z',
  completedAt: null,
  simulated: true,
  ...overrides,
});

describe('mergePayoutPage', () => {
  test('appends unknown older payouts without duplicating known ids', () => {
    const current = [payout('b'), payout('a')];
    const merged = mergePayoutPage(current, [payout('a'), payout('z')]);

    expect(merged.map((item) => item.id)).toEqual(['b', 'a', 'z']);
  });

  test('refreshes an item that changed status between loads', () => {
    const current = [payout('a')];
    const done = payout('a', { status: 'done', completedAt: '2026-10-05T10:21:30.123456Z' });
    const merged = mergePayoutPage(current, [done]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.status).toBe('done');
  });
});

describe('upsertPayout', () => {
  test('prepends a payout that is not in the list yet', () => {
    const created = payout('new');
    expect(upsertPayout([payout('a')], created).map((item) => item.id)).toEqual(['new', 'a']);
  });

  test('replaces in place when the payout is already listed', () => {
    const current = [payout('b'), payout('a')];
    const merged = upsertPayout(current, payout('a', { status: 'done' }));

    expect(merged.map((item) => item.id)).toEqual(['b', 'a']);
    expect(merged[1]?.status).toBe('done');
  });
});
