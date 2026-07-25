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

export interface LedgerSummary {
  earned: number;
  lost: number;
  locked: number;
  clawback: number;
}

export interface ReplayState {
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
}

export function createEmptyState(): ReplayState {
  return {
    balances: new Map(),
    accounts: new Map(),
    stakeTotals: new Map(),
    betPools: new Map(),
    rounds: new Map(),
    votes: new Map(),
    stakes: [],
    ledgerSummary: new Map(),
  };
}

export function betPoolKey(messageId: string, settlementType: string): string {
  return `${messageId}:${settlementType}`;
}
