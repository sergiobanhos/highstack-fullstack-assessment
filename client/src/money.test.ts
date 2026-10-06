import { describe, expect, test } from 'bun:test';
import {
  formatCents,
  formatCentsInput,
  formatMultiplier,
  formatSignedCents,
  parseMultiplierToHundredths,
  parseUsdToCents,
  projectPayoutCents,
} from './money';

describe('parseUsdToCents', () => {
  test('parses valid USD amounts into exact integer cents', () => {
    expect(parseUsdToCents('12.34')).toEqual({ ok: true, value: 1234 });
    expect(parseUsdToCents('12')).toEqual({ ok: true, value: 1200 });
    expect(parseUsdToCents('0.01')).toEqual({ ok: true, value: 1 });
    expect(parseUsdToCents('1000.5')).toEqual({ ok: true, value: 100050 });
    expect(parseUsdToCents('  7.25  ')).toEqual({ ok: true, value: 725 });
  });

  test('rejects zero, negatives, extra decimals, and exponent notation', () => {
    expect(parseUsdToCents('0').ok).toBe(false);
    expect(parseUsdToCents('0.00').ok).toBe(false);
    expect(parseUsdToCents('-1').ok).toBe(false);
    expect(parseUsdToCents('1.005').ok).toBe(false);
    expect(parseUsdToCents('1e3').ok).toBe(false);
    expect(parseUsdToCents('.5').ok).toBe(false);
    expect(parseUsdToCents('12.').ok).toBe(false);
    expect(parseUsdToCents('12,34').ok).toBe(false);
    expect(parseUsdToCents('$12.34').ok).toBe(false);
    expect(parseUsdToCents('abc').ok).toBe(false);
    expect(parseUsdToCents('').ok).toBe(false);
    expect(parseUsdToCents('   ').ok).toBe(false);
  });

  test('rejects values outside the supported range', () => {
    // 2^53 cents is not representable as a safe integer.
    expect(parseUsdToCents('99999999999999.99').ok).toBe(false);
    expect(parseUsdToCents('90071992547409.92').ok).toBe(false);
    const capped = parseUsdToCents('10000.01', { maxCents: 1_000_000 });
    expect(capped.ok).toBe(false);
    if (!capped.ok) expect(capped.message).toContain('$10,000.00');
    expect(parseUsdToCents('10000.00', { maxCents: 1_000_000 })).toEqual({ ok: true, value: 1_000_000 });
  });

  test('never produces floating-point cents', () => {
    for (const [text, cents] of [['0.07', 7], ['0.29', 29], ['1.15', 115], ['19.99', 1999]] as const) {
      const parsed = parseUsdToCents(text);
      expect(parsed).toEqual({ ok: true, value: cents });
    }
  });
});

describe('parseMultiplierToHundredths', () => {
  test('parses multipliers on the operator half-hundredths grid', () => {
    expect(parseMultiplierToHundredths('1.01')).toEqual({ ok: true, value: 101 });
    expect(parseMultiplierToHundredths('2.5')).toEqual({ ok: true, value: 250 });
    expect(parseMultiplierToHundredths('10')).toEqual({ ok: true, value: 1000 });
    expect(parseMultiplierToHundredths('1000000')).toEqual({ ok: true, value: 100_000_000 });
  });

  test('rejects multipliers below 1.01, above the cap, or malformed', () => {
    expect(parseMultiplierToHundredths('1.00').ok).toBe(false);
    expect(parseMultiplierToHundredths('0.5').ok).toBe(false);
    expect(parseMultiplierToHundredths('1.005').ok).toBe(false);
    expect(parseMultiplierToHundredths('1000000.01').ok).toBe(false);
    expect(parseMultiplierToHundredths('1e2').ok).toBe(false);
    expect(parseMultiplierToHundredths('').ok).toBe(false);
    expect(parseMultiplierToHundredths('2,5').ok).toBe(false);
  });
});

describe('formatting', () => {
  test('formats cents as USD without floating-point arithmetic', () => {
    expect(formatCents(0)).toBe('$0.00');
    expect(formatCents(1)).toBe('$0.01');
    expect(formatCents(1234)).toBe('$12.34');
    expect(formatCents(1000000)).toBe('$10,000.00');
    expect(formatCents(123456789)).toBe('$1,234,567.89');
  });

  test('formats signed ledger amounts by direction', () => {
    expect(formatSignedCents(500, 'credit')).toBe('+$5.00');
    expect(formatSignedCents(500, 'debit')).toBe('-$5.00');
  });

  test('formats cents as plain input text that round-trips through the parser', () => {
    expect(formatCentsInput(5000)).toBe('50.00');
    expect(formatCentsInput(1)).toBe('0.01');
    expect(formatCentsInput(123456789)).toBe('1234567.89');
    expect(parseUsdToCents(formatCentsInput(123456789))).toEqual({ ok: true, value: 123456789 });
  });

  test('projects the cashout payout with the engine formula', () => {
    // Confirmed against the local engine: 10.00 at 1.01 credited 10.10.
    expect(projectPayoutCents(1000, 101)).toBe(1010);
    expect(projectPayoutCents(1000, 100)).toBe(1000);
    expect(projectPayoutCents(2500, 250)).toBe(6250);
    // Truncates like the engine's integer division.
    expect(projectPayoutCents(101, 333)).toBe(336);
    // Stays exact beyond float precision.
    expect(projectPayoutCents(1_000_000_000, 100_000_000)).toBe(1_000_000_000_000_000);
  });

  test('formats multipliers in hundredths', () => {
    expect(formatMultiplier(101)).toBe('1.01x');
    expect(formatMultiplier(250)).toBe('2.50x');
    expect(formatMultiplier(100)).toBe('1.00x');
    expect(formatMultiplier(100_000_000)).toBe('1000000.00x');
  });
});
