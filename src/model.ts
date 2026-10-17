// Shared types used by providers, usage, chart and view. No logic beyond tiny guards.

export interface ModelRow {
  modelName: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  cost: number;
}
export interface AgentRow {
  agent: string;
  totalTokens: number;
  totalCost: number;
  models: ModelRow[];
}
export interface DayRow {
  period: string; // YYYY-MM-DD
  totalTokens: number;
  totalCost: number;
  agents: AgentRow[];
}
export interface Limit {
  agent: string; // "claude" | "codex" | "kimi"
  label: string; // "claude 1 5h"
  pct: number; // 0..100, already 0 if window reset
  resetsAt: number | null; // epoch seconds
  windowMinutes: number;
  account?: string; // "claude 1" etc. for multi-account agents
}
export type Metric = "tokens" | "cost";
export type KpiPeriod = "today" | "last7" | "last30" | "month";

/** One agent/account's usage on one day (for the per-account breakdown). */
export interface AccountDay { period: string; account: string; agent: string; tokens: number; cost: number }
/** One account's usage over a whole KPI period (providers whose reports cannot split by day run once per period). */
export interface AccountPeriod { period: KpiPeriod; account: string; agent: string; tokens: number; cost: number }
export interface AccountTotal { account: string; agent: string; value: number }
export const KPI_PERIODS: KpiPeriod[] = ["today", "last7", "last30", "month"];

/** What every limits provider returns. */
export interface LimitsResult { limits: Limit[]; noData: string[]; emails: Record<string, string> }

export const num = (v: unknown): number => (typeof v === "number" && isFinite(v) ? v : 0);
export const EMPTY_DAY = (period: string): DayRow => ({ period, totalTokens: 0, totalCost: 0, agents: [] });

/** Runs `ccusage <args>` and returns parsed JSON. Bound to a bunx path by usage.ts. */
export type CcusageRunner = (args: string[], env?: NodeJS.ProcessEnv) => Promise<unknown>;
