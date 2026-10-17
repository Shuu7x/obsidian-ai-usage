// Usage section: four KPI cards (tap to pick the period) + per-account breakdown.
import { KpiPeriod, Metric } from "../model";
import { colorMap, formatMetric } from "../format";
import { kpis, lastDays, linePoints, metricOf, modelTotals, periodFilter } from "../chart";
import { accountAgents, accountTotals } from "../usage";
import { Ctx, accountTitle, svgEl } from "./ctx";

export function renderUsage(body: HTMLElement, ctx: Ctx) {
const days = ctx.filtered;
  const m = ctx.d.metric;
  const asOf = ctx.s.usageAsOf; // one snapshot for cards, sparkline and breakdown
  const k = kpis(days, asOf);
  const spark = lastDays(days, 7, asOf).map((d) => metricOf(d, m));
  const row = body.createDiv({ cls: "aiu-kpis" });
  const cell = (value: number, label: string, period: KpiPeriod) => {
    const c = row.createDiv({ cls: "aiu-kpi" + (ctx.s.kpiPeriod === period ? " is-active" : "") });
    c.setAttr("role", "button"); c.setAttr("tabindex", "0");
    c.createDiv({ cls: "aiu-kpi-value", text: formatMetric(value, m) });
    const svg = svgEl(c, "svg", { viewBox: "0 0 60 16", width: "100%", preserveAspectRatio: "none", class: "aiu-spark" });
    const max = Math.max(0, ...spark);
    const pts = linePoints(spark, max, 1, 58, 2, 12);
    svgEl(svg, "polygon", { points: `1,14 ${pts} 59,14`, class: "aiu-spark-area" });
    svgEl(svg, "polyline", { points: pts, class: "aiu-spark-line", fill: "none" });
    c.createDiv({ cls: "aiu-kpi-label", text: label });
    const pick = () => { ctx.s.kpiPeriod = period; ctx.rerender(); };
    c.onclick = pick;
    c.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } };
  };
  cell(k.today[m], "today", "today");
  cell(k.last7[m], "7d", "last7");
  cell(k.last30[m], "30d", "last30");
  cell(k.month[m], "month", "month");
  if (ctx.d.groupBy === "model") renderModels(body, ctx);
  else renderAccounts(body, ctx);
}

/** Per-account rows for the selected card's period + metric, agent filter applied. */
function renderAccounts(body: HTMLElement, ctx: Ctx) {
  const m = ctx.d.metric;
  const agent = ctx.d.agent;
  if (ctx.s.breakdownFailed.includes(ctx.s.kpiPeriod) && (!agent || agent === "claude")) {
    body.createDiv({ cls: "aiu-muted aiu-breakdown-note", text: "breakdown unavailable (claude session report failed)" });
    return;
  }
  const totals = accountTotals(ctx.s.accounts, ctx.s.periodAccounts, ctx.s.kpiPeriod, ctx.s.usageAsOf, m, agent);
  const colors = colorMap(accountAgents(ctx.s.accounts, ctx.s.periodAccounts));
  renderRows(body, totals.map((t) => ({ value: t.value, color: colors[t.agent], label: (el) => accountTitle(el, t.account, t.agent, ctx.s.emails[t.account]) })), m);
}

/** Per-model rows for the selected card's period + metric (agent filter already applied to ctx.filtered). */
function renderModels(body: HTMLElement, ctx: Ctx) {
  const m = ctx.d.metric;
  const inPeriod = periodFilter(ctx.s.kpiPeriod, ctx.s.usageAsOf);
  const totals = modelTotals(ctx.filtered.filter((d) => inPeriod(d.period)), m);
  const colors = colorMap(ctx.all);
  renderRows(body, totals.map((t) => ({ value: t.value, color: colors[t.agent], label: (el) => el.createSpan({ cls: "aiu-acct-model", text: t.model, attr: { title: t.model } }) })), m);
}

/** Rows are already sorted desc; the first is the bar scale. */
function renderRows(body: HTMLElement, rows: { value: number; color: string; label: (el: HTMLElement) => void }[], m: Metric) {
  if (!rows.length) return;
  const max = rows[0].value;
  const list = body.createDiv({ cls: "aiu-accts" });
  for (const t of rows) {
    const row = list.createDiv({ cls: "aiu-acct" });
    const name = row.createDiv({ cls: "aiu-acct-label" });
    name.createSpan({ cls: "aiu-dot" }).style.background = t.color;
    t.label(name);
    row.createSpan({ cls: "aiu-acct-value", text: formatMetric(t.value, m) });
    const bar = row.createDiv({ cls: "aiu-bar aiu-bar-sm" });
    const fill = bar.createDiv({ cls: "aiu-bar-fill" });
    fill.style.setProperty("--fill", t.color);
    fill.style.width = "0%";
    requestAnimationFrame(() => { fill.style.width = `${max > 0 ? (t.value / max) * 100 : 0}%`; });
  }
}

