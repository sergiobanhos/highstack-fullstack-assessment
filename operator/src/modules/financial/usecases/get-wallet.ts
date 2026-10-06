import { eq } from 'drizzle-orm';
import type { OperatorDatabase } from '../../../db';
import { wallets } from '../financial.schema';
import { FinancialServiceError, type WalletBalance } from '../financial.contracts';
import { withFinancialStorageErrors } from './operation-transaction';

export function createGetWallet({ db }: { db: OperatorDatabase }) {
  return (playerId: string): Promise<WalletBalance> => withFinancialStorageErrors(async () => {
    const [wallet] = await db
      .select({ playerId: wallets.playerId, balanceCents: wallets.balanceCents })
      .from(wallets)
      .where(eq(wallets.playerId, playerId));
    if (!wallet) throw new FinancialServiceError('WALLET_NOT_FOUND');
    return wallet;
  });
}
