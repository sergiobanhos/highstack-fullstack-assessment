import { eq } from 'drizzle-orm';
import type { OperatorDatabase } from '../../../db';
import { wallets } from '../financial.schema';
import { FinancialServiceError, type WalletBalance } from '../financial.contracts';
import { withFinancialStorageErrors } from './operation-transaction';

export function createEnsureWallet({ db }: { db: OperatorDatabase }) {
  return (playerId: string): Promise<WalletBalance> => withFinancialStorageErrors(async () => {
    const [created] = await db
      .insert(wallets)
      .values({ playerId })
      .onConflictDoNothing()
      .returning({ playerId: wallets.playerId, balanceCents: wallets.balanceCents });
    if (created) return created;
    const [existing] = await db
      .select({ playerId: wallets.playerId, balanceCents: wallets.balanceCents })
      .from(wallets)
      .where(eq(wallets.playerId, playerId));
    if (!existing) throw new FinancialServiceError('STORAGE_UNAVAILABLE');
    return existing;
  });
}
