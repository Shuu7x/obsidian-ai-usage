// OpenCode provider: usage only (no rate limits). The report comes from `ccusage opencode daily` in usage.ts.
import { DayRow, ModelRow, num } from "../model";

/** `ccusage opencode daily --json` -> DayRows with a single "opencode" agent. Per-model cost comes from modelBreakdowns. */
export function parseOpencodeDaily(json: unknown): DayRow[] {
  const daily = (json as { daily?: unknown[] })?.daily;
  if (!Array.isArray(daily)) return [];
  return daily
    .map((d: any) => {
      const models: ModelRow[] = (Array.isArray(d?.modelBreakdowns) ? d.modelBreakdowns : []).map((m: any) => ({
        modelName: String(m?.modelName ?? "?"), inputTokens: num(m?.inputTokens), outputTokens: num(m?.outputTokens),
        cacheReadTokens: num(m?.cacheReadTokens), cacheCreationTokens: num(m?.cacheCreationTokens), cost: num(m?.cost),
      }));
      const totalTokens = num(d?.totalTokens), totalCost = num(d?.totalCost);
      return { period: String(d?.date ?? ""), totalTokens, totalCost, agents: [{ agent: "opencode", totalTokens, totalCost, models }] };
    })
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.period))
    .sort((a, b) => (a.period < b.period ? -1 : 1));
}
