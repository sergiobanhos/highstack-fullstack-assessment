import { useEffect, useState } from 'react';

/** UI-only countdown from the authoritative bettingEndsAt timestamp. */
export function useRoundCountdown(bettingEndsAt: number | null, enabled: boolean): string | null {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled || bettingEndsAt === null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [bettingEndsAt, enabled]);

  if (!enabled || bettingEndsAt === null) return null;
  const seconds = Math.max(0, Math.ceil((bettingEndsAt - now) / 1000));
  return `00:${String(seconds).padStart(2, '0')}`;
}
