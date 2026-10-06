/**
 * Exact USD-decimal handling for the player client.
 *
 * Money never goes through floating point: text input is parsed into integer
 * cents with strict decimal rules, and cents are rendered back with integer
 * arithmetic only. The operator always revalidates every amount.
 */

export type ParseResult<T> = { ok: true; value: T } | { ok: false; message: string };

const USD_PATTERN = /^(\d{1,15})(?:\.(\d{1,2}))?$/;
const MULTIPLIER_PATTERN = /^(\d{1,7})(?:\.(\d{1,2}))?$/;

export const MIN_AUTO_CASHOUT_HUNDREDTHS = 101;
export const MAX_AUTO_CASHOUT_HUNDREDTHS = 100_000_000;
/** Operator limit for a single bet (`MAX_BET_CENTS` in the game module). */
export const MAX_BET_CENTS = 1_000_000_000;

function twoDigitFraction(digits: string | undefined): number {
  return Number((digits ?? '').padEnd(2, '0'));
}

/**
 * Parses a USD amount typed by the player into integer cents.
 * Rejects zero, negatives, more than two decimals, exponent notation, and
 * values that cannot be represented as safe integers.
 */
export function parseUsdToCents(
  input: string,
  options: { maxCents?: number } = {},
): ParseResult<number> {
  const text = input.trim();
  if (text.length === 0) return { ok: false, message: 'Informe um valor.' };

  const match = USD_PATTERN.exec(text);
  if (!match) {
    return { ok: false, message: 'Use apenas números com até duas casas decimais (ex.: 12.34).' };
  }

  const whole = Number(match[1]);
  if (!Number.isSafeInteger(whole)) {
    return { ok: false, message: 'Valor fora do intervalo suportado.' };
  }

  const cents = whole * 100 + twoDigitFraction(match[2]);
  if (!Number.isSafeInteger(cents)) {
    return { ok: false, message: 'Valor fora do intervalo suportado.' };
  }
  if (cents < 1) {
    return { ok: false, message: 'O valor deve ser maior que zero.' };
  }
  if (options.maxCents !== undefined && cents > options.maxCents) {
    return { ok: false, message: `O valor máximo é ${formatCents(options.maxCents)}.` };
  }
  return { ok: true, value: cents };
}

/**
 * Parses an auto-cashout multiplier typed by the player into hundredths
 * (e.g. `2.50` -> `250`), matching the operator's multiplier grid.
 */
export function parseMultiplierToHundredths(
  input: string,
  options: { minHundredths?: number; maxHundredths?: number } = {},
): ParseResult<number> {
  const min = options.minHundredths ?? MIN_AUTO_CASHOUT_HUNDREDTHS;
  const max = options.maxHundredths ?? MAX_AUTO_CASHOUT_HUNDREDTHS;
  const text = input.trim();
  if (text.length === 0) return { ok: false, message: 'Informe um multiplicador como 1.50.' };

  const match = MULTIPLIER_PATTERN.exec(text);
  if (!match) {
    return { ok: false, message: 'Use apenas números com até duas casas decimais (ex.: 1.50).' };
  }

  const whole = Number(match[1]);
  const hundredths = whole * 100 + twoDigitFraction(match[2]);
  if (!Number.isSafeInteger(hundredths)) {
    return { ok: false, message: 'Multiplicador fora do intervalo suportado.' };
  }
  if (hundredths < min || hundredths > max) {
    return {
      ok: false,
      message: `O multiplicador deve ficar entre ${formatMultiplier(min)} e ${formatMultiplier(max)}.`,
    };
  }
  return { ok: true, value: hundredths };
}

/** Renders integer cents as USD text (e.g. `1234` -> `$12.34`). */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const absolute = Math.abs(cents);
  const whole = Math.floor(absolute / 100);
  const fraction = absolute % 100;
  return `${sign}$${whole.toLocaleString('en-US')}.${String(fraction).padStart(2, '0')}`;
}

/** Renders ledger cents with an explicit direction sign. */
export function formatSignedCents(cents: number, direction: 'debit' | 'credit'): string {
  return `${direction === 'debit' ? '-' : '+'}${formatCents(Math.abs(cents))}`;
}

/** Renders cents as plain input text (e.g. `5000` -> `50.00`), without grouping or symbol. */
export function formatCentsInput(cents: number): string {
  const whole = Math.floor(Math.abs(cents) / 100);
  const fraction = Math.abs(cents) % 100;
  return `${cents < 0 ? '-' : ''}${whole}.${String(fraction).padStart(2, '0')}`;
}

/**
 * Mirrors the engine's cashout math for display: `amount x multiplier`, in
 * integer cents with truncation (`engine/src/bets.js` divides BigInt by 100).
 * The operator remains the source of truth for the credited amount.
 */
export function projectPayoutCents(amountCents: number, multiplierHundredths: number): number {
  const payout = (BigInt(amountCents) * BigInt(multiplierHundredths)) / 100n;
  return Number(payout);
}

/** Renders a multiplier in hundredths (e.g. `234` -> `2.34x`). */
export function formatMultiplier(hundredths: number): string {
  const whole = Math.trunc(hundredths / 100);
  const fraction = Math.abs(hundredths % 100);
  return `${whole}.${String(fraction).padStart(2, '0')}x`;
}
