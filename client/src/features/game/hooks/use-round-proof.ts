import { useEffect, useState } from 'react';
import { verifyRound, type RoundProof } from '../model/fairness';
import type { RevealedRound } from '../data/operator-events.client';

export interface RoundProofState {
  roundId: string;
  status: 'checking' | 'done' | 'failed';
  result: RoundProof | null;
}

export function useRoundProof(revealed: RevealedRound | null) {
  const [proof, setProof] = useState<RoundProofState | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (revealed === null) return;
    let cancelled = false;
    setProof({ roundId: revealed.roundId, status: 'checking', result: null });
    void verifyRound({
      roundId: revealed.roundId,
      serverSeed: revealed.serverSeed,
      serverSeedHash: revealed.serverSeedHash,
      crashPoint: revealed.crashPoint,
    })
      .then((result) => {
        if (!cancelled) setProof({ roundId: revealed.roundId, status: 'done', result });
      })
      .catch(() => {
        if (!cancelled) setProof({ roundId: revealed.roundId, status: 'failed', result: null });
      });
    return () => { cancelled = true; };
  }, [revealed, attempt]);

  return { proof, retry: () => setAttempt((count) => count + 1) };
}
