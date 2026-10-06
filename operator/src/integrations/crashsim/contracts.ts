/** Validated payload returned by Crashsim's current-round HTTP endpoint. */
export interface CrashsimRoundSnapshot {
  roundId: string;
  state: 'betting' | 'running' | 'crashed';
  seq: number;
  serverSeedHash?: string;
  bettingEndsAt?: number;
  startedAt?: number;
  multiplier?: number;
  crashPoint?: number;
  serverSeed?: string;
}

/** Crashsim WebSocket event envelope after parsing its raw JSON frame. */
export type CrashsimStreamEvent =
  | {
      type: 'round.betting';
      seq: number;
      data: { roundId: string; serverSeedHash: string; bettingEndsAt: number };
    }
  | { type: 'round.started'; seq: number; data: { roundId: string; startedAt: number } }
  | { type: 'tick'; seq: number; data: { roundId: string; multiplier: number; t: number } }
  | {
      type: 'round.crashed';
      seq: number;
      data: { roundId: string; crashPoint: number; serverSeed: string };
    };
