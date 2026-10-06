import { sql } from 'drizzle-orm';
import { financialOperations, payouts } from '../financial.schema';
import type { PayoutRecord } from '../financial.contracts';

export const payoutProjection = {
  id: payouts.id,
  amountCents: financialOperations.amountCents,
  status: payouts.status,
  requestedAt: sql<string>`to_char(${financialOperations.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
  completedAt: sql<string | null>`CASE WHEN ${payouts.completedAt} IS NULL THEN NULL ELSE to_char(${payouts.completedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END`,
};

export function payoutRecord(row: {
  id: string;
  amountCents: bigint;
  status: string;
  requestedAt: string;
  completedAt: string | null;
}): PayoutRecord {
  return { ...row, status: row.status as PayoutRecord['status'] };
}
