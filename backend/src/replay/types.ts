/**
 * types.ts — In-memory replay state types for Phase D.
 */

export interface PointAccount {
  available: number;
  locked: number;
}

export interface StakeTotals {
  pro: number;
  con: number;
}

export interface BetPoolState {
  pro: number;
  con: number;
}

export interface RoundState {
  messageId: string;
  settlementType: string;
  status: 'OPEN' | 'VOTING' | 'SETTLED';
  result: 'TRUE' | 'FALSE' | 'UNKNOWN' | null;
  weights: { TRUE: number; FALSE: number };
  previousRoundId: string | null;
  /** state.stakes.length at the moment this round was settled — used by clawback */
  settledAtStakeCount: number;
}

export interface VoteRecord {
  userId: string;
  vote: 'TRUE' | 'FALSE';
  amount: number;
}

export interface StakeRecord {
  userId: string;
  messageId: string;
  side: 'PRO' | 'CON';
  amount: number;
  roundId: string | null;
  settlementType: string;
}

export interface MessageState {
  id: string;
  topicId: string;
  createdById: string;
  kind: string;
  contentType: string | null;
  content: string | null;
  quoteSourceId: string | null;
  quotedText: string | null;
  quotedTextHash: string | null;
  quoteContextBefore: string | null;
  quoteContextAfter: string | null;
  relationType: string | null;
  relSourceId: string | null;
  targetRefs: unknown;
  relationPayload: unknown;
  supersededBy: string | null;
}

export interface LedgerSummary {
  earned: number;
  lost: number;
  locked: number;
  clawback: number;
}

export interface ReplayState {
  /** messageId -> reconstructed message */
  messages: Map<string, MessageState>;
  /** userId → balance */
  balances: Map<string, number>;
  /** userId → PointAccount */
  accounts: Map<string, PointAccount>;
  /** messageId → PRO/CON totals */
  stakeTotals: Map<string, StakeTotals>;
  /** `${messageId}:${settlementType}` → BetPool */
  betPools: Map<string, BetPoolState>;
  /** roundId → RoundState */
  rounds: Map<string, RoundState>;
  /** roundId → votes */
  votes: Map<string, VoteRecord[]>;
  /** all stakes used by settlement */
  stakes: StakeRecord[];
  /** userId → LedgerSummary */
  ledgerSummary: Map<string, LedgerSummary>;
  /** accumulated protocol fee revenue (replaces burned fees) */
  revenuePoolBalance: number;
}

export function createEmptyState(): ReplayState {
  return {
    messages: new Map(),
    balances: new Map(),
    accounts: new Map(),
    stakeTotals: new Map(),
    betPools: new Map(),
    rounds: new Map(),
    votes: new Map(),
    stakes: [],
    ledgerSummary: new Map(),
    revenuePoolBalance: 0,
  };
}

export function betPoolKey(messageId: string, settlementType: string): string {
  return `${messageId}:${settlementType}`;
}
