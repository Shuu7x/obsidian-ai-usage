// Series, KPI and SVG point math. Pure.
import { DayRow, EMPTY_DAY, KpiPeriod, Metric } from "./model";
import { isoDay } from "./format";

/** Last n days ending at `today` (local), missing days filled with an empty row. */
export function lastDays(days: DayRow[], n: number, today: Date): DayRow[] {
  const byDay = new Map(days.map((d) => [d.period, d]));
  const out: DayRow[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const k = isoDay(new Date(today.getFullYear(), today.getMonth(), today.getDate() - i));
    out.push(byDay.get(k) ?? EMPTY_DAY(k));
  }
  return out;
}

export function metricOf(row: { totalTokens: number; totalCost: number }, m: Metric): number {
  return m === "cost" ? row.totalCost : row.totalTokens;
}

/** Per-agent value series aligned with `days`. */
export function seriesByAgent(days: DayRow[], agents: string[], m: Metric): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const ag of agents) {
    out[ag] = days.map((d) => {
      const a = d.agents.find((x) => x.agent === ag);
      return a ? metricOf(a, m) : 0;
    });
  }
  return out;
}

export interface KpiPair { tokens: number; cost: number }
export interface Kpis { today: KpiPair; last7: KpiPair; last30: KpiPair; month: KpiPair }
/** today, last 7 days, last 30 days (rolling, incl. today), this calendar month. */
export function kpis(days: DayRow[], today: Date): Kpis {
  const t = isoDay(today);
  const month = t.slice(0, 7);
  const last7 = new Set(lastDays([], 7, today).map((d) => d.period));
  const last30 = new Set(lastDays([], 30, today).map((d) => d.period));
  const z = (): KpiPair => ({ tokens: 0, cost: 0 });
  const k: Kpis = { today: z(), last7: z(), last30: z(), month: z() };
  const add = (p: KpiPair, d: DayRow) => { p.tokens += d.totalTokens; p.cost += d.totalCost; };
  for (const d of days) {
    if (d.period === t) add(k.today, d);
    if (last7.has(d.period)) add(k.last7, d);
    if (last30.has(d.period)) add(k.last30, d);
    if (d.period.startsWith(month)) add(k.month, d);
  }
  return k;
}

/** Predicate for the days a KPI period covers. */
export function periodFilter(period: KpiPeriod, today: Date): (p: string) => boolean {
  if (period === "month") { const m = isoDay(today).slice(0, 7); return (p) => p.startsWith(m); }
  const set = new Set(lastDays([], period === "today" ? 1 : period === "last7" ? 7 : 30, today).map((d) => d.period));
  return (p) => set.has(p);
}

/** First/last day (YYYY-MM-DD) a KPI period covers. */
export function periodBounds(period: KpiPeriod, today: Date): { since: string; until: string } {
  const until = isoDay(today);
  if (period === "month") return { since: until.slice(0, 8) + "01", until };
  return { since: lastDays([], period === "today" ? 1 : period === "last7" ? 7 : 30, today)[0].period, until };
}

/** Polyline points for an SVG line chart. ys scaled to [top, top+height]; max<=0 draws a flat bottom line. */
export function linePoints(ys: number[], max: number, left: number, width: number, top: number, height: number): string {
  const n = ys.length;
  return ys
    .map((y, i) => {
      const x = n === 1 ? left + width / 2 : left + (i * width) / (n - 1);
      const yy = max > 0 ? top + height - (y / max) * height : top + height;
      return `${x.toFixed(1)},${yy.toFixed(1)}`;
    })
    .join(" ");
}
