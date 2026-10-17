// Claude provider: per-account rate limits from <dir>/statusline-last.json, email from .claude.json,
// usage per account via the ccusage session report + <dir>/account-sessions.txt. Read-only.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { AccountPeriod, CcusageRunner, KPI_PERIODS, KpiPeriod, Limit, LimitsResult, num } from "../model";
import { effectivePct } from "../format";
import { periodBounds } from "../chart";

// ---------- pure ----------

export function parseClaudeLimits(json: unknown, nowSec: number, account = "claude"): Limit[] {
  const rl = (json as any)?.rate_limits;
  if (!rl || typeof rl !== "object") return [];
  const out: Limit[] = [];
  const spec: [string, string, number][] = [["five_hour", "5h", 300], ["seven_day", "7d", 10080]];
  for (const [key, lbl, mins] of spec) {
    const w = rl[key];
    if (!w || typeof w !== "object") continue;
    const resetsAt = typeof w.resets_at === "number" ? w.resets_at : null;
    out.push({ agent: "claude", label: `${account} ${lbl}`, pct: effectivePct(num(w.used_percentage), resetsAt, nowSec), resetsAt, windowMinutes: mins, account });
  }
  return out;
}


/** Only oauthAccount.emailAddress is read; everything else in .claude.json is ignored. */
export function emailFromClaudeJson(json: unknown): string | null {
  const e = (json as any)?.oauthAccount?.emailAddress;
  return typeof e === "string" && e.includes("@") ? e.trim() : null;
}

export interface ClaudeDirEntry { name: string; dirExists: boolean; json: unknown | null }
/** Multi-account: limits for every dir with a statusline file; dirs that exist without one are listed in noData. */
export function claudeAccounts(entries: ClaudeDirEntry[], nowSec: number): { limits: Limit[]; noData: string[] } {
  const limits: Limit[] = [], noData: string[] = [];
  for (const e of entries) {
    if (!e.dirExists) continue;
    const l = e.json ? parseClaudeLimits(e.json, nowSec, e.name) : [];
    if (l.length) limits.push(...l); else noData.push(e.name);
  }
  return { limits, noData };
}

/** sessionId -> account name from per-account id lists; unknown ids belong to `fallback`. */
export function sessionAccountMap(lists: { name: string; ids: string[] }[], fallback: string): (id: string) => string {
  const m = new Map<string, string>();
  for (const l of lists) for (const id of l.ids) { const k = id.trim(); if (k && !m.has(k)) m.set(k, l.name); }
  return (id) => m.get(id) ?? fallback;
}

/** `ccusage claude session --json` (already date-bounded) -> totals per account. */
export function sessionTotals(json: unknown, accountOf: (id: string) => string): { account: string; tokens: number; cost: number }[] {
  const sessions = (json as { sessions?: unknown[] })?.sessions;
  if (!Array.isArray(sessions)) return [];
  const acc = new Map<string, { account: string; tokens: number; cost: number }>();
  for (const s of sessions as any[]) {
    const account = accountOf(String(s?.sessionId ?? ""));
    const cur = acc.get(account) ?? { account, tokens: 0, cost: 0 };
    cur.tokens += num(s?.totalTokens); cur.cost += num(s?.totalCost);
    acc.set(account, cur);
  }
  return [...acc.values()];
}

// ---------- IO ----------

/** dirs like ["~/.claude", "~/.claude-2"]; account i is labelled "claude <i+1>". */
export function readLimits(dirs: string[], nowSec: number): LimitsResult {
  const home = os.homedir();
  const emails: Record<string, string> = {};
  const entries: ClaudeDirEntry[] = dirs.map((d, i) => {
    const dir = d.trim().replace(/^~/, home);
    const name = `claude ${i + 1}`;
    let dirExists = false, json: unknown | null = null;
    try { dirExists = fs.statSync(dir).isDirectory(); } catch { /* missing */ }
    if (dirExists) {
      try { json = JSON.parse(fs.readFileSync(path.join(dir, "statusline-last.json"), "utf8")); } catch { /* no file yet */ }
      // default dir keeps its account file beside it (~/.claude.json), other dirs inside (<dir>/.claude.json)
      const acct = path.resolve(dir) === path.join(home, ".claude") ? path.join(home, ".claude.json") : path.join(dir, ".claude.json");
      try { const e = emailFromClaudeJson(JSON.parse(fs.readFileSync(acct, "utf8"))); if (e) emails[name] = e; } catch { /* no email */ }
    }
    return { name, dirExists, json };
  });
  return { ...claudeAccounts(entries, nowSec), emails };
}


/** Session usage per account, one date-bounded report per KPI period (the report has no per-day split).
 *  Sessions in no list belong to account 1 (the only account before 2026-10-17). */
export async function usageByPeriod(run: CcusageRunner, dirs: string[], today = new Date()): Promise<{ rows: AccountPeriod[]; failed: KpiPeriod[] }> {
  const home = os.homedir();
  const lists = dirs.map((d, i) => {
    let ids: string[] = [];
    try { ids = fs.readFileSync(path.join(d.trim().replace(/^~/, home), "account-sessions.txt"), "utf8").split("\n"); } catch { /* none yet */ }
    return { name: `claude ${i + 1}`, ids };
  });
  const accountOf = sessionAccountMap(lists, "claude 1");
  const failed: KpiPeriod[] = [];
  const per = await Promise.all(KPI_PERIODS.map(async (period): Promise<AccountPeriod[]> => {
    const { since, until } = periodBounds(period, today);
    try {
      const json = await run(["claude", "session", "--since", since.replace(/-/g, ""), "--until", until.replace(/-/g, ""), "--json"]);
      return sessionTotals(json, accountOf).map((t) => ({ period, agent: "claude", ...t }));
    } catch { failed.push(period); return []; } // surfaced: the view shows "breakdown unavailable" for this period
  }));
  return { rows: per.flat(), failed };
}
