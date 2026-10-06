import type { CrashsimRoundSnapshot, CrashsimStreamEvent } from '../../integrations/crashsim/contracts';
import type { GameEvent, RoundSnapshot } from './round-state';

/** Maps a validated Crashsim snapshot into the game's internal state contract. */
export function toRoundSnapshot(snapshot: CrashsimRoundSnapshot): RoundSnapshot {
  return snapshot;
}

/** Maps a validated external event into the game reducer's internal event. */
export function toGameEvent(event: CrashsimStreamEvent): GameEvent {
  switch (event.type) {
    case 'round.betting':
      return { type: event.type, seq: event.seq, ...event.data };
    case 'round.started':
      return { type: event.type, seq: event.seq, ...event.data };
    case 'tick':
      return { type: event.type, seq: event.seq, ...event.data };
    case 'round.crashed':
      return { type: event.type, seq: event.seq, ...event.data };
  }
}
