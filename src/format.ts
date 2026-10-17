// Number, time and color formatting. Pure.
import { Metric } from "./model";

export function isoDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
export const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

export function formatTokens(n: number): string {
  const f = (v: number) => (v >= 100 ? v.toFixed(0) : v.toFixed(1)).replace(/\.0$/, "");
  if (n >= 1e9) return f(n / 1e9) + "B";
  if (n >= 1e6) return f(n / 1e6) + "M";
  if (n >= 1e3) return f(n / 1e3) + "K";
  return String(Math.round(n));
}
export function formatCost(n: number): string {
  return "$" + (n >= 100 ? n.toFixed(0) : n.toFixed(2));
}
export function formatMetric(n: number, m: Metric): string {
  return m === "cost" ? formatCost(n) : formatTokens(n);
}

/** 10080 -> "7d", 300 -> "5h", 90 -> "90m". */
export function windowLabel(minutes: number): string {
  if (minutes >= 1440 && minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60}h`;
  return `${Math.round(minutes)}m`;
}

/** A window whose reset time already passed shows 0%. */
export function effectivePct(pct: number, resetsAt: number | null, nowSec: number): number {
  if (resetsAt !== null && resetsAt < nowSec) return 0;
  return Math.max(0, Math.min(100, pct));
}

export const isoToSec = (v: unknown): number | null => {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return isNaN(t) ? null : Math.floor(t / 1000);
};
/** Accepts epoch seconds, epoch ms, or ISO string. */
export function toEpochSec(v: unknown): number | null {
  if (typeof v === "number" && isFinite(v) && v > 0) return v > 1e11 ? Math.floor(v / 1000) : Math.floor(v);
  if (typeof v === "string") { const n = Number(v); if (v.trim() && isFinite(n) && n > 0) return toEpochSec(n); return isoToSec(v); }
  return null;
}

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** "resets 20:10" if same local day as now, else "resets Sat 09:00". */
export function formatReset(resetsAt: number | null, now: Date): string {
  if (resetsAt === null) return "no reset time";
  const d = new Date(resetsAt * 1000);
  return isoDay(d) === isoDay(now) ? `resets ${hhmm(d)}` : `resets ${DOW[d.getDay()]} ${hhmm(d)}`;
}

/** "2d 3h", "1h 05m", "12m", or "now" when passed. */
export function countdown(resetsAt: number | null, nowSec: number): string {
  if (resetsAt === null) return "–";
  let s = resetsAt - nowSec;
  if (s <= 0) return "now";
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.ceil(s / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${m}m`;
}

export function gaugeColor(pct: number): string {
  return pct >= 80 ? "#ef4444" : pct >= 50 ? "#f59e0b" : "#22c55e";
}
const AGENT_COLORS: Record<string, string> = { claude: "#f59e0b", codex: "#3b82f6", opencode: "#22c55e" };
const OTHER_COLORS = ["#a855f7", "#ef4444"];
/** Distinct colors for per-model chart lines (top 6 + other). */
export const SERIES_COLORS = ["#f59e0b", "#3b82f6", "#22c55e", "#a855f7", "#ef4444", "#14b8a6", "#9ca3af"];
/** Stable color map for a list of agents (unknown ones alternate through OTHER_COLORS). */
export function colorMap(agents: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  for (const a of agents) out[a] = AGENT_COLORS[a] ?? OTHER_COLORS[i++ % OTHER_COLORS.length];
  return out;
}
