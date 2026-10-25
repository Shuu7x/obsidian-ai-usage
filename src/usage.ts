// ccusage runner, generic report parsing and per-account usage math.
// Providers contribute their own accounts; this file orchestrates one refresh of usage data.
import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { AccountDay, AccountPeriod, AccountTotal, CcusageRunner, DayRow, KpiPeriod, Metric, num } from "./model";
import { periodFilter } from "./chart";
import { isoDay } from "./format";
import * as claude from "./providers/claude";
import * as codex from "./providers/codex";
import { parseOpencodeDaily } from "./providers/opencode";

const CCUSAGE = "ccusage@20.0.34";

let ccusageQueue: Promise<unknown> = Promise.resolve();

/** Runs tasks one after another. Parallel bunx runs of the same package race on linking (EEXIST), so ccusage calls go through here.
 *  Chained on settle, not on success: a rejected task does not block the ones queued after it. */
export function serialize<T>(task: () => Promise<T>): Promise<T> {
  const next = ccusageQueue.then(task);
  ccusageQueue = next.catch(() => {});
  return next;
}

/** Runner bound to a bunx path. Each call uses a private temp cwd so bunx cannot pick up a planted bunfig/package.json. */
export function ccusageRunner(bunxPath: string): CcusageRunner {
  return (args, env = process.env) => serialize(() => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-"));
    return new Promise((resolve, reject) => {
      execFile(bunxPath.replace(/^~/, os.homedir()), [CCUSAGE, ...args], { cwd, env, maxBuffer: 64 * 1024 * 1024, timeout: 120_000 }, (err, stdout) => {
        fs.rmSync(cwd, { recursive: true, force: true });
        if (err) return reject(err);
        try { resolve(JSON.parse(stdout)); } catch (e) { reject(e); }
      });
    });
  });
}

/** YYYYMMDD for 31 days ago (ccusage --since). */
export function sinceArg(today = new Date()): string {
  const d = new Date(today); d.setDate(d.getDate() - 31);
  return isoDay(d).replace(/-/g, "");
}

export function parseCcusage(json: unknown): DayRow[] {
  const daily = (json as { daily?: unknown[] })?.daily;
  if (!Array.isArray(daily)) return [];
  return daily
    .map((d: any) => ({
      period: String(d.period ?? ""),
      totalTokens: num(d.totalTokens),
      totalCost: num(d.totalCost),
      agents: (Array.isArray(d.agents) ? d.agents : []).map((a: any) => ({
        agent: String(a.agent ?? "unknown"),
        totalTokens: num(a.totalTokens),
        totalCost: num(a.totalCost),
        models: (Array.isArray(a.modelBreakdowns) ? a.modelBreakdowns : []).map((m: any) => ({
          modelName: String(m.modelName ?? "?"),
          inputTokens: num(m.inputTokens),
          outputTokens: num(m.outputTokens),
          cacheReadTokens: num(m.cacheReadTokens),
          cacheCreationTokens: num(m.cacheCreationTokens),
          cost: num(m.cost),
        })),
      })),
    }))
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.period))
    .sort((a, b) => (a.period < b.period ? -1 : 1));
}


export function agentsOf(days: DayRow[]): string[] {
  const s = new Set<string>();
  for (const d of days) for (const a of d.agents) s.add(a.agent);
  return [...s].sort();
}

/** agent=null -> all. Totals are recomputed from the surviving agent rows. */
export function filterByAgent(days: DayRow[], agent: string | null): DayRow[] {
  if (!agent) return days;
  return days
    .map((d) => {
      const agents = d.agents.filter((a) => a.agent === agent);
      return {
        period: d.period,
        totalTokens: agents.reduce((s, a) => s + a.totalTokens, 0),
        totalCost: agents.reduce((s, a) => s + a.totalCost, 0),
        agents,
      };
    })
    .filter((d) => d.agents.length > 0);
}

/** Add `extra` agent rows into `days` (same agent on the same day is summed; models appended). */
export function mergeUsage(days: DayRow[], extra: DayRow[]): DayRow[] {
  const byDay = new Map(days.map((d) => [d.period, { ...d, agents: d.agents.map((a) => ({ ...a, models: [...a.models] })) }]));
  for (const x of extra) {
    const d = byDay.get(x.period) ?? { period: x.period, totalTokens: 0, totalCost: 0, agents: [] };
    byDay.set(x.period, d);
    for (const a of x.agents) {
      const cur = d.agents.find((y) => y.agent === a.agent);
      if (cur) { cur.totalTokens += a.totalTokens; cur.totalCost += a.totalCost; cur.models.push(...a.models); }
      else d.agents.push({ ...a, models: [...a.models] });
      d.totalTokens += a.totalTokens; d.totalCost += a.totalCost;
    }
  }
  return [...byDay.values()].sort((a, b) => (a.period < b.period ? -1 : 1));
}

/** Lift one agent's rows out of DayRows as a single named account (codex 1 from the main report, kimi, an extra codex home). */
export function agentAsAccount(days: DayRow[], agent: string, account: string): AccountDay[] {
  const out: AccountDay[] = [];
  for (const d of days) for (const a of d.agents) if (a.agent === agent && (a.totalTokens || a.totalCost)) out.push({ period: d.period, account, agent, tokens: a.totalTokens, cost: a.totalCost });
  return out;
}

/** Sum per account for one KPI period in the given metric, desc; zero rows dropped.
 *  Daily rows (codex, kimi) are filtered by date; period rows (claude) are picked by period key. */
export function accountTotals(daily: AccountDay[], periodRows: AccountPeriod[], period: KpiPeriod, today: Date, metric: Metric, agent: string | null): AccountTotal[] {
  const inPeriod = periodFilter(period, today);
  const acc = new Map<string, AccountTotal>();
  const add = (account: string, ag: string, tokens: number, cost: number) => {
    if (agent && ag !== agent) return;
    const cur = acc.get(account) ?? { account, agent: ag, value: 0 };
    cur.value += metric === "cost" ? cost : tokens;
    acc.set(account, cur);
  };
  for (const r of daily) if (inPeriod(r.period)) add(r.account, r.agent, r.tokens, r.cost);
  for (const r of periodRows) if (r.period === period) add(r.account, r.agent, r.tokens, r.cost);
  return [...acc.values()].filter((a) => a.value > 0).sort((a, b) => b.value - a.value || a.account.localeCompare(b.account));
}

/** One refresh of usage data. `asOf` is the single date snapshot every card and breakdown is derived from:
 *  the period-bounded reports were run for it, so cards computed for any other date would disagree. */
/** Every agent present in daily or period account rows (for a stable color map). */
export function accountAgents(daily: AccountDay[], periodRows: AccountPeriod[]): string[] {
  return [...new Set([...daily.map((r) => r.agent), ...periodRows.map((r) => r.agent)])].sort();
}

export interface Usage { asOf: Date; days: DayRow[]; accounts: AccountDay[]; periodAccounts: AccountPeriod[]; breakdownFailed: KpiPeriod[] }

/** Main report (all agents, default homes) + one codex-only run per EXTRA codex home + claude session reports
 *  per KPI period mapped to accounts via <dir>/account-sessions.txt. Per-home codex results are kept for the account breakdown
 *  and also merged into the single codex agent. */
export async function fetchUsage(bunxPath: string, codexHomes: string[], claudeDirs: string[]): Promise<Usage> {
  const run = ccusageRunner(bunxPath);
  const asOf = new Date();
  const since = sinceArg(asOf);
  let days = parseCcusage(await run(["daily", "--since", since, "--json", "--by-agent"]));
  const accounts: AccountDay[] = [...agentAsAccount(days, "codex", "codex 1"), ...agentAsAccount(days, "kimi", "kimi")];
  for (const x of await codex.extraUsage(run, since, codexHomes)) {
    accounts.push(...agentAsAccount(x.days, "codex", x.account));
    days = mergeUsage(days, x.days);
  }
  try {
    const oc = parseOpencodeDaily(await run(["opencode", "daily", "--since", since, "--json"]));
    accounts.push(...agentAsAccount(oc, "opencode", "opencode"));
    days = mergeUsage(days, oc);
  } catch { /* ponytail: opencode failing must not hide the main report */ }
  const byPeriod = await claude.usageByPeriod(run, claudeDirs, asOf);
  return { asOf, days, accounts, periodAccounts: byPeriod.rows, breakdownFailed: byPeriod.failed };
}
