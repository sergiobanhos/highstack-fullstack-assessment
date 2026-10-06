import type { BetCommandResult, ReconcileClosedBetsInput } from '../game.contracts';
import { and, eq, ne } from 'drizzle-orm';
import type { Logger } from '../../../config';
import type { OperatorDatabase } from '../../../db';
import { gameBets } from '../game.schema';
import { GameCommandError } from '../game.errors';

const RECONCILIATION_CONCURRENCY = 5;

interface BetCandidate {
  betId: string;
  playerId: string;
  roundId: string;
}

export interface ReconcileBetsDeps {
  db: OperatorDatabase;
  logger: Logger;
  getBet(input: { playerId: string; betId: string }): Promise<BetCommandResult | null>;
}

/** Reconciles terminal rounds through authoritative bet reads with bounded, coalesced work. */
export function createReconcileBets({ db, logger, getBet }: ReconcileBetsDeps) {
  const betReconciliations = new Map<string, Promise<void>>();
  const roundReconciliations = new Map<string, Promise<void>>();

  async function reconcileOneBet(candidate: BetCandidate): Promise<void> {
    const current = betReconciliations.get(candidate.betId);
    if (current) return current;
    const reconciliation = (async () => {
      try {
        const result = await getBet({ playerId: candidate.playerId, betId: candidate.betId });
        if (!result?.bet) {
          logger.warn('game.bet.reconciliation_pending', { ...candidate, reason: 'bet_not_found_locally' });
          return;
        }
        if (result.bet.engineStatus === 'active') {
          logger.info('game.bet.reconciliation_pending', { ...candidate, reason: 'engine_still_active' });
          return;
        }
        logger.info('game.bet.reconciled', {
          betId: candidate.betId,
          roundId: candidate.roundId,
          engineStatus: result.bet.engineStatus,
          settlementStatus: result.bet.settlementStatus,
        });
      } catch (error) {
        logger.warn('game.bet.reconciliation_pending', {
          betId: candidate.betId,
          roundId: candidate.roundId,
          reason: error instanceof GameCommandError ? error.code : 'unexpected_error',
        });
      }
    })();
    betReconciliations.set(candidate.betId, reconciliation);
    try {
      await reconciliation;
    } finally {
      if (betReconciliations.get(candidate.betId) === reconciliation) betReconciliations.delete(candidate.betId);
    }
  }

  async function reconcileCandidates(scope: { roundId: string } | { currentRoundId: string; includeCurrentRound: boolean }): Promise<void> {
    const conditions = [eq(gameBets.engineStatus, 'active')];
    if ('roundId' in scope) conditions.push(eq(gameBets.roundId, scope.roundId));
    else if (!scope.includeCurrentRound) conditions.push(ne(gameBets.roundId, scope.currentRoundId));

    let candidates: BetCandidate[];
    try {
      candidates = await db.select({ betId: gameBets.betId, playerId: gameBets.playerId, roundId: gameBets.roundId })
        .from(gameBets).where(and(...conditions));
    } catch {
      throw new GameCommandError('SERVICE_UNAVAILABLE');
    }

    logger.info('game.bet.reconciliation_started', {
      scope: 'roundId' in scope ? 'round' : 'closed_rounds',
      roundId: 'roundId' in scope ? scope.roundId : scope.currentRoundId,
      candidates: candidates.length,
    });
    let nextIndex = 0;
    const workerCount = Math.min(RECONCILIATION_CONCURRENCY, candidates.length);
    await Promise.all(Array.from({ length: workerCount }, async () => {
      while (nextIndex < candidates.length) {
        const candidate = candidates[nextIndex++];
        if (candidate) await reconcileOneBet(candidate);
      }
    }));
  }

  function coalesce(key: string, run: () => Promise<void>): Promise<void> {
    const current = roundReconciliations.get(key);
    if (current) return current;
    const reconciliation = run();
    roundReconciliations.set(key, reconciliation);
    void reconciliation.finally(() => {
      if (roundReconciliations.get(key) === reconciliation) roundReconciliations.delete(key);
    }).catch(() => {});
    return reconciliation;
  }

  function reconcileBetsForRound(roundId: string): Promise<void> {
    return coalesce(`round:${roundId}`, async () => {
      try {
        await reconcileCandidates({ roundId });
      } catch (error) {
        logger.error('game.bet.reconciliation_failed', {
          roundId,
          reason: error instanceof GameCommandError ? error.code : 'unexpected_error',
        });
        throw error;
      }
    });
  }

  function reconcileClosedBets(input: ReconcileClosedBetsInput): Promise<void> {
    const includeCurrentRound = input.currentRoundState === 'crashed';
    const key = `snapshot:${input.currentRoundId}:${includeCurrentRound ? 'crashed' : 'open'}`;
    return coalesce(key, async () => {
      try {
        await reconcileCandidates({ currentRoundId: input.currentRoundId, includeCurrentRound });
      } catch (error) {
        logger.error('game.bet.reconciliation_failed', {
          roundId: input.currentRoundId,
          reason: error instanceof GameCommandError ? error.code : 'unexpected_error',
        });
        throw error;
      }
    });
  }

  return { reconcileBetsForRound, reconcileClosedBets };
}
