// Daily section: range toggle, line chart with hover tooltip + click-to-detail, legend toggles.
import { setIcon } from "obsidian";
import { DayRow } from "../model";
import { colorMap, formatCost, formatMetric, formatTokens } from "../format";
import { lastDays, linePoints, seriesByAgent } from "../chart";
import { Ctx, svgEl } from "./ctx";

export function renderDaily(body: HTMLElement, ctx: Ctx) {
  const { filtered, all } = ctx;
  const d = ctx.d;
  const m = d.metric;
  const rb = body.createDiv({ cls: "aiu-toolbar" }).createDiv({ cls: "aiu-toggle" });
  for (const r of [7, 14, 30] as const) {
    const b = rb.createEl("button", { cls: "aiu-toggle-btn" + (d.range === r ? " is-active" : ""), text: `${r}d` });
    b.onclick = () => ctx.patch({ range: r });
  }

  if (ctx.s.loading && !ctx.s.days.length) { body.createDiv({ cls: "aiu-muted", text: "loading…" }); return; }
  if (ctx.s.error && !ctx.s.days.length) { body.createDiv({ cls: "aiu-muted", text: "no usage data (see Usage section)" }); return; }

  const days = lastDays(filtered, d.range, new Date());
  const agents = d.agent ? [d.agent] : all;
  const colors = colorMap(all);
  const series = seriesByAgent(days, agents, m);
  const visible = agents.filter((a) => !ctx.s.hidden.has(a));
  const max = Math.max(0, ...visible.flatMap((a) => series[a]));

  const W = 300, H = 130, L = 34, R = 8, T = 8, B = 20, pw = W - L - R, ph = H - T - B;
  const wrap = body.createDiv({ cls: "aiu-chart-wrap" });
  const svg = svgEl(wrap, "svg", { viewBox: `0 0 ${W} ${H}`, width: "100%", preserveAspectRatio: "xMidYMid meet", class: "aiu-chart" });
  // y grid: 0, half, max
  for (const f of [0, 0.5, 1]) {
    const y = T + ph - f * ph;
    svgEl(svg, "line", { x1: L, x2: W - R, y1: y, y2: y, class: "aiu-grid" });
    const t = svgEl(svg, "text", { x: L - 4, y: y + 3, "text-anchor": "end", class: "aiu-axis" });
    t.textContent = formatMetric(max * f, m);
  }
  const n = days.length;
  const xOf = (i: number) => L + (i * pw) / (n - 1);
  const step = n > 16 ? 5 : n > 8 ? 2 : 1;
  days.forEach((day, i) => {
    if (i % step === 0 || i === n - 1) {
      const t = svgEl(svg, "text", { x: xOf(i), y: H - 6, "text-anchor": "middle", class: "aiu-axis" });
      t.textContent = String(Number(day.period.slice(8)));
    }
  });
  for (const a of visible) {
    svgEl(svg, "polyline", { points: linePoints(series[a], max, L, pw, T, ph), fill: "none", stroke: colors[a], "stroke-width": 2, "stroke-linejoin": "round" });
  }
  if (ctx.s.selectedDay) {
    const i = days.findIndex((x) => x.period === ctx.s.selectedDay);
    if (i >= 0) svgEl(svg, "line", { x1: xOf(i), x2: xOf(i), y1: T, y2: T + ph, class: "aiu-sel" });
  }
  // hover/click hit areas
  const tip = wrap.createDiv({ cls: "aiu-tip" });
  tip.hide();
  const half = pw / (n - 1) / 2;
  days.forEach((day, i) => {
    const x = xOf(i);
    const hit = svgEl(svg, "rect", { x: x - half, y: 0, width: half * 2, height: H, fill: "transparent" });
    const show = () => {
      tip.empty();
      tip.createDiv({ cls: "aiu-tip-title", text: day.period });
      const rows = day.agents.filter((a) => agents.includes(a.agent));
      if (!rows.length) tip.createDiv({ cls: "aiu-muted", text: "no usage" });
      for (const a of rows) tip.createDiv({ text: `${a.agent}: ${formatTokens(a.totalTokens)} · ${formatCost(a.totalCost)}` });
      tip.show();
      tip.style.left = `${(x / W) * 100}%`;
      tip.toggleClass("is-right", x > W / 2);
    };
    hit.addEventListener("mouseenter", show);
    hit.addEventListener("mouseleave", () => tip.hide());
    hit.addEventListener("click", () => { ctx.s.selectedDay = ctx.s.selectedDay === day.period ? null : day.period; ctx.rerender(); });
  });

  // legend: click toggles visibility
  const leg = body.createDiv({ cls: "aiu-legend" });
  for (const a of agents) {
    const it = leg.createEl("button", { cls: "aiu-chip aiu-legend-item" + (ctx.s.hidden.has(a) ? " is-hidden" : ""), text: a });
    it.style.setProperty("--chip-color", colors[a]);
    it.onclick = () => { ctx.s.hidden.has(a) ? ctx.s.hidden.delete(a) : ctx.s.hidden.add(a); ctx.rerender(); };
  }

  if (ctx.s.selectedDay) renderDetail(body, ctx, days.find((x) => x.period === ctx.s.selectedDay), agents);
}

function renderDetail(body: HTMLElement, ctx: Ctx, day: DayRow | undefined, agents: string[]) {
  const det = body.createDiv({ cls: "aiu-detail" });
  const head = det.createDiv({ cls: "aiu-detail-head" });
  head.createSpan({ text: day?.period ?? "" });
  const close = head.createEl("button", { cls: "aiu-close", attr: { "aria-label": "close" } });
  setIcon(close, "x");
  close.onclick = () => { ctx.s.selectedDay = null; ctx.rerender(); };
  const rows = (day?.agents ?? []).filter((a) => agents.includes(a.agent));
  if (!rows.length) { det.createDiv({ cls: "aiu-muted", text: "no usage" }); return; }
  for (const a of rows) {
    det.createDiv({ cls: "aiu-detail-agent", text: `${a.agent} · ${formatTokens(a.totalTokens)} · ${formatCost(a.totalCost)}` });
    for (const mo of a.models) {
      const r = det.createDiv({ cls: "aiu-model" });
      r.createDiv({ cls: "aiu-model-name", text: mo.modelName });
      r.createDiv({ cls: "aiu-model-nums", text: `in ${formatTokens(mo.inputTokens)} · out ${formatTokens(mo.outputTokens)} · cache r ${formatTokens(mo.cacheReadTokens)} · w ${formatTokens(mo.cacheCreationTokens)} · ${formatCost(mo.cost)}` });
    }
  }
}

