// Codex provider: per-home rate limits from the newest session log, email from auth.json id_token payload,
// usage for extra homes via `ccusage codex daily` with CODEX_HOME. Read-only; tokens never leave this file.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { CcusageRunner, DayRow, Limit, LimitsResult, ModelRow, num } from "../model";
import { effectivePct, windowLabel } from "../format";

// ---------- pure ----------

/** Parse one codex session jsonl line (the one containing token_count + rate_limits). */
export function parseCodexLine(line: string, nowSec: number, account?: string): Limit[] {
  let j: any;
  try { j = JSON.parse(line); } catch { return []; }
  const rl = j?.payload?.rate_limits;
  if (!rl || typeof rl !== "object") return [];
  const out: Limit[] = [];
  for (const key of ["primary", "secondary"]) {
    const w = rl[key];
    if (!w || typeof w !== "object") continue;
    const mins = num(w.window_minutes);
    const resetsAt = typeof w.resets_at === "number" ? w.resets_at : null;
    out.push({ agent: "codex", label: `${account ?? "codex"} ${windowLabel(mins)}`, pct: effectivePct(num(w.used_percent), resetsAt, nowSec), resetsAt, windowMinutes: mins, ...(account ? { account } : {}) });
  }
  return out;
}

/** Last line of a jsonl text that mentions both markers, or null. */
export function lastRateLimitLine(text: string): string | null {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (l.includes("token_count") && l.includes("rate_limits")) return l;
  }
  return null;
}

export interface CodexHomeEntry { name: string; homeExists: boolean; line: string | null }
/** Limits per codex home; homes without a usable session line are listed in noData. */
export function codexAccounts(entries: CodexHomeEntry[], nowSec: number): { limits: Limit[]; noData: string[] } {
  const limits: Limit[] = [], noData: string[] = [];
  for (const e of entries) {
    if (!e.homeExists) continue;
    const l = e.line ? parseCodexLine(e.line, nowSec, e.name) : [];
    if (l.length) limits.push(...l); else noData.push(e.name);
  }
  return { limits, noData };
}

/** Decode ONLY the JWT payload (no verification) and return its email claim. Never returns the token. */
export function emailFromJwt(idToken: unknown): string | null {
  if (typeof idToken !== "string") return null;
  const parts = idToken.split(".");
  if (parts.length < 2) return null;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(parts[1].length / 4) * 4, "=");
    const bin = atob(b64);
    const json = new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
    const p = JSON.parse(json);
    const e = p?.email ?? p?.["https://api.openai.com/profile"]?.email;
    return typeof e === "string" && e.includes("@") ? e.trim() : null;
  } catch { return null; }
}

/** `ccusage codex daily --json` -> DayRows with a single "codex" agent (per-model cost is not reported). */
export function parseCodexDaily(json: unknown): DayRow[] {
  const daily = (json as { daily?: unknown[] })?.daily;
  if (!Array.isArray(daily)) return [];
  return daily
    .map((d: any) => {
      const models: ModelRow[] = Object.entries(d?.models ?? {}).map(([modelName, m]: [string, any]) => ({
        modelName, inputTokens: num(m?.inputTokens), outputTokens: num(m?.outputTokens),
        cacheReadTokens: num(m?.cacheReadTokens), cacheCreationTokens: num(m?.cacheCreationTokens), cost: 0,
      }));
      const totalTokens = num(d?.totalTokens), totalCost = num(d?.costUSD);
      return { period: String(d?.date ?? ""), totalTokens, totalCost, agents: [{ agent: "codex", totalTokens, totalCost, models }] };
    })
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.period))
    .sort((a, b) => (a.period < b.period ? -1 : 1));
}


// ---------- IO ----------

// <home>/sessions/{y}/{m}/{d}/{file}.jsonl, newest 5 by mtime; first file with a rate_limits line wins.
function latestCodexLine(home: string): string | null {
  const root = path.join(home, "sessions");
  const files: { f: string; m: number }[] = [];
  const walk = (dir: string, depth: number) => {
    let ents: fs.Dirent[];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (depth < 3 && e.isDirectory()) walk(p, depth + 1);
      else if (depth === 3 && e.isFile() && e.name.endsWith(".jsonl")) {
        try { files.push({ f: p, m: fs.statSync(p).mtimeMs }); } catch { /* skip */ }
      }
    }
  };
  walk(root, 0);
  files.sort((a, b) => b.m - a.m);
  for (const { f } of files.slice(0, 5)) {
    try { const line = lastRateLimitLine(fs.readFileSync(f, "utf8")); if (line) return line; } catch { /* try next */ }
  }
  return null;
}

/** homes like ["~/.codex", "~/.codex-2"]; account i is "codex <i+1>". Email from <home>/auth.json tokens.id_token (payload only, never stored). */
export function readLimits(homes: string[], nowSec: number, withEmail = false): LimitsResult {
  const emails: Record<string, string> = {};
  const entries: CodexHomeEntry[] = homes.map((h, i) => {
    const home = h.trim().replace(/^~/, os.homedir());
    const name = `codex ${i + 1}`;
    let homeExists = false;
    try { homeExists = fs.statSync(home).isDirectory(); } catch { /* missing */ }
    if (!homeExists) return { name, homeExists, line: null };
    if (withEmail) try { const e = emailFromJwt(JSON.parse(fs.readFileSync(path.join(home, "auth.json"), "utf8"))?.tokens?.id_token); if (e) emails[name] = e; } catch { /* no email */ }
    return { name, homeExists, line: latestCodexLine(home) };
  });
  return { ...codexAccounts(entries, nowSec), emails };
}


/** `ccusage codex daily` for every EXTRA home (index >= 1) that has sessions; a failing home is skipped. */
export async function extraUsage(run: CcusageRunner, since: string, homes: string[]): Promise<{ account: string; days: DayRow[] }[]> {
  const out: { account: string; days: DayRow[] }[] = [];
  for (const [i, h] of homes.slice(1).entries()) {
    const hp = h.trim().replace(/^~/, os.homedir());
    let exists = false;
    try { exists = fs.statSync(path.join(hp, "sessions")).isDirectory(); } catch { /* no sessions yet */ }
    if (!exists) continue;
    try {
      out.push({ account: `codex ${i + 2}`, days: parseCodexDaily(await run(["codex", "daily", "--since", since, "--json"], { ...process.env, CODEX_HOME: hp })) });
    } catch { /* ponytail: an extra home failing must not hide the main report */ }
  }
  return out;
}
