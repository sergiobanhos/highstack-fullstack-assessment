import { createHmac, timingSafeEqual } from 'node:crypto';

export type WebhookAuthFailure =
  | 'missing_timestamp'
  | 'invalid_timestamp'
  | 'stale_timestamp'
  | 'missing_signature'
  | 'invalid_signature';

export type WebhookAuthResult = { ok: true } | { ok: false; reason: WebhookAuthFailure };

export interface CrashsimWebhookHeaders {
  timestamp: string | string[] | undefined;
  signature: string | string[] | undefined;
}

const MAX_CLOCK_SKEW_SECONDS = 60;
const SIGNATURE_HEX = /^[a-fA-F0-9]{64}$/;
const UNIX_SECONDS = /^(0|[1-9][0-9]*)$/;

/** Verifies the exact wire bytes emitted by the concrete Crashsim engine client. */
export function verifyCrashsimWebhook({
  headers,
  rawBody,
  secret,
  nowSeconds = Math.floor(Date.now() / 1_000),
}: {
  headers: CrashsimWebhookHeaders;
  rawBody: Buffer;
  secret: string;
  nowSeconds?: number;
}): WebhookAuthResult {
  const timestamp = headers.timestamp;
  if (timestamp === undefined) return { ok: false, reason: 'missing_timestamp' };
  if (typeof timestamp !== 'string' || !UNIX_SECONDS.test(timestamp)) {
    return { ok: false, reason: 'invalid_timestamp' };
  }

  const timestampSeconds = Number(timestamp);
  if (!Number.isSafeInteger(timestampSeconds)) {
    return { ok: false, reason: 'invalid_timestamp' };
  }
  if (!Number.isSafeInteger(nowSeconds) || Math.abs(nowSeconds - timestampSeconds) > MAX_CLOCK_SKEW_SECONDS) {
    return { ok: false, reason: 'stale_timestamp' };
  }

  const signature = headers.signature;
  if (signature === undefined) return { ok: false, reason: 'missing_signature' };
  if (typeof signature !== 'string' || !SIGNATURE_HEX.test(signature)) {
    return { ok: false, reason: 'invalid_signature' };
  }

  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.`)
    .update(rawBody)
    .digest();
  const supplied = Buffer.from(signature, 'hex');
  if (supplied.length !== expected.length || !timingSafeEqual(expected, supplied)) {
    return { ok: false, reason: 'invalid_signature' };
  }

  return { ok: true };
}
