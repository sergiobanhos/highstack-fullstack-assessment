import * as v from 'valibot';
import type { RoundSnapshot } from './round-state';

export interface CrashsimHttpClientDeps {
  /** Engine base URL, without a trailing slash. */
  baseUrl: string;
  /** Server-only operator key; sent as `x-operator-key`. */
  operatorKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 3_000;
const seqSchema = v.pipe(v.number(), v.integer(), v.minValue(0));
const snapshotSchema = v.object({
  roundId: v.string(),
  state: v.picklist(['betting', 'running', 'crashed']),
  seq: seqSchema,
  serverSeedHash: v.optional(v.string()),
  bettingEndsAt: v.optional(v.number()),
  startedAt: v.optional(v.number()),
  multiplier: v.optional(v.number()),
  crashPoint: v.optional(v.number()),
  serverSeed: v.optional(v.string()),
});

const issuePaths = (issues: readonly v.BaseIssue<unknown>[]): string =>
  issues.map((issue) => issue.path?.map((segment) => String(segment.key)).join('.') ?? '(root)').join(',');

/** Direct Crashsim HTTP client. The engine key never leaves this server-side boundary. */
export class CrashsimHttpClient {
  private readonly timeoutMs: number;

  constructor(private readonly deps: CrashsimHttpClientDeps) {
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Reads current state only; the engine has no historical replay endpoint. */
  async getCurrentRound(): Promise<RoundSnapshot> {
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    const response = await fetchImpl(`${this.deps.baseUrl}/rounds/current`, {
      method: 'GET',
      headers: { 'x-operator-key': this.deps.operatorKey, accept: 'application/json' },
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) throw new Error(`engine snapshot request failed with status ${response.status}`);

    const parsed = v.safeParse(snapshotSchema, await response.json());
    if (!parsed.success) throw new Error(`invalid engine snapshot: ${issuePaths(parsed.issues)}`);
    return parsed.output as RoundSnapshot;
  }
}
