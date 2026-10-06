/**
 * Provably-fair verification for Crashsim rounds.
 *
 * Mirrors `engine/src/fair.js` so the player can recompute a finished round
 * instead of trusting the operator:
 *
 *   digest     = HMAC-SHA256(key = serverSeed, message = roundId)
 *   h          = first 52 bits of the digest (13 hex chars)
 *   crashPoint = 1                        when h % 100 == 0
 *              = floor((100 * 2^52 - h) / (2^52 - h)) / 100   otherwise
 *
 * The seed is only usable after the operator reveals it (post-crash); the
 * commitment hash published while betting is what proves it was fixed upfront.
 * Everything runs in the browser with Web Crypto and integer arithmetic.
 */

const DIGEST_HEX_CHARS = 13;
const E = 2n ** 52n;

const encoder = new TextEncoder();

export type ProofCheck = 'match' | 'mismatch' | 'unavailable';

export interface RoundProofInput {
  roundId: string;
  serverSeed: string | null;
  serverSeedHash: string | null;
  crashPoint: number | null;
}

export interface RoundProof {
  /** The revealed seed hashes to the commitment published before the round. */
  commitment: ProofCheck;
  /** The revealed seed reproduces the crash point shown for the round. */
  result: ProofCheck;
  /** Crash point recomputed locally, in hundredths of the multiplier. */
  reproducedHundredths: number | null;
}

const toHex = (buffer: ArrayBuffer): string => {
  let hex = '';
  for (const byte of new Uint8Array(buffer)) hex += byte.toString(16).padStart(2, '0');
  return hex;
};

/** `sha256(serverSeed)` compared with the commitment published up front. */
export async function commitmentMatches(
  serverSeed: string,
  serverSeedHash: string,
): Promise<boolean> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(serverSeed));
  return toHex(digest) === serverSeedHash.trim().toLowerCase();
}

/** Crash point (2 decimals) from a hex digest; mirrors `crashPointFromHex`. */
export function crashPointFromDigest(digestHex: string): number {
  const h = BigInt(`0x${digestHex.slice(0, DIGEST_HEX_CHARS)}`);
  if (h % 100n === 0n) return 1;
  const cents = (100n * E - h) / (E - h);
  return Number(cents) / 100;
}

/** Recomputes a round's crash point from the revealed seed and the round id. */
export async function reproduceCrashPoint(serverSeed: string, roundId: string): Promise<number> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(serverSeed),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(roundId));
  return crashPointFromDigest(toHex(mac));
}

/** Runs both checks for a finished round; unavailable until the seed is revealed. */
export async function verifyRound(input: RoundProofInput): Promise<RoundProof> {
  const { roundId, serverSeed, serverSeedHash, crashPoint } = input;
  if (serverSeed === null) {
    return { commitment: 'unavailable', result: 'unavailable', reproducedHundredths: null };
  }

  const reproduced = await reproduceCrashPoint(serverSeed, roundId);
  const reproducedHundredths = Math.round(reproduced * 100);

  const commitment =
    serverSeedHash === null
      ? 'unavailable'
      : (await commitmentMatches(serverSeed, serverSeedHash))
        ? 'match'
        : 'mismatch';

  const result =
    crashPoint === null
      ? 'unavailable'
      : Math.round(crashPoint * 100) === reproducedHundredths
        ? 'match'
        : 'mismatch';

  return { commitment, result, reproducedHundredths };
}
