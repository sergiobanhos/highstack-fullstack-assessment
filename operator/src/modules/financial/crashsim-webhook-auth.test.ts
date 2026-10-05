import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { verifyCrashsimWebhook } from './crashsim-webhook-auth';

const secret = 'operator webhook secret';
const nowSeconds = 1_800_000_000;

function sign(timestamp: string, rawBody: Buffer): string {
  return createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex');
}

describe('Crashsim webhook authentication', () => {
  test('verifies HMAC over the exact raw bytes and textual timestamp', () => {
    const rawBody = Buffer.from('{ "amount": 101, "playerId":"p" }');
    const timestamp = String(nowSeconds);
    expect(verifyCrashsimWebhook({
      headers: { timestamp, signature: sign(timestamp, rawBody) }, rawBody, secret, nowSeconds,
    })).toEqual({ ok: true });

    const changedBytes = Buffer.from('{"amount":101,"playerId":"p"}');
    expect(verifyCrashsimWebhook({
      headers: { timestamp, signature: sign(timestamp, rawBody) }, rawBody: changedBytes, secret, nowSeconds,
    })).toEqual({ ok: false, reason: 'invalid_signature' });
  });

  test('requires decimal safe Unix timestamps and rejects either side beyond the freshness window', () => {
    const rawBody = Buffer.from('{}');
    expect(verifyCrashsimWebhook({
      headers: { timestamp: undefined, signature: '0'.repeat(64) }, rawBody, secret, nowSeconds,
    })).toEqual({ ok: false, reason: 'missing_timestamp' });
    for (const timestamp of ['-1', '1.5', '01', '9007199254740992', ['1800000000']]) {
      expect(verifyCrashsimWebhook({
        headers: { timestamp, signature: '0'.repeat(64) }, rawBody, secret, nowSeconds,
      })).toEqual({ ok: false, reason: 'invalid_timestamp' });
    }
    for (const timestamp of [String(nowSeconds - 61), String(nowSeconds + 61)]) {
      expect(verifyCrashsimWebhook({
        headers: { timestamp, signature: sign(timestamp, rawBody) }, rawBody, secret, nowSeconds,
      })).toEqual({ ok: false, reason: 'stale_timestamp' });
    }
  });

  test('rejects missing, malformed, and incorrect signatures', () => {
    const rawBody = Buffer.from('{}');
    const timestamp = String(nowSeconds);
    expect(verifyCrashsimWebhook({
      headers: { timestamp, signature: undefined }, rawBody, secret, nowSeconds,
    })).toEqual({ ok: false, reason: 'missing_signature' });
    for (const signature of ['bad', '0'.repeat(62), ['0'.repeat(64)]]) {
      expect(verifyCrashsimWebhook({
        headers: { timestamp, signature }, rawBody, secret, nowSeconds,
      })).toEqual({ ok: false, reason: 'invalid_signature' });
    }
    expect(verifyCrashsimWebhook({
      headers: { timestamp, signature: '0'.repeat(64) }, rawBody, secret, nowSeconds,
    })).toEqual({ ok: false, reason: 'invalid_signature' });
  });
});
