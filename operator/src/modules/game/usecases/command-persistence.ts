import { sql } from 'drizzle-orm';
import { gameCommands, type GameCommandStatus } from '../game.schema';

const reservedAt = sql<string>`to_char(${gameCommands.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export const commandProjection = {
  id: gameCommands.id,
  playerId: gameCommands.playerId,
  commandType: gameCommands.commandType,
  idempotencyKey: gameCommands.idempotencyKey,
  requestHash: gameCommands.requestHash,
  roundId: gameCommands.roundId,
  betId: gameCommands.betId,
  amountCents: gameCommands.amountCents,
  autoCashoutHundredths: gameCommands.autoCashoutHundredths,
  status: gameCommands.status,
  resultCode: gameCommands.resultCode,
  reservedAt,
};

export type StoredCommand = {
  id: string;
  playerId: string;
  commandType: 'bet' | 'cashout';
  idempotencyKey: string;
  requestHash: string;
  roundId: string | null;
  betId: string | null;
  amountCents: bigint | null;
  autoCashoutHundredths: number | null;
  status: GameCommandStatus;
  resultCode: string | null;
  reservedAt: string;
};
