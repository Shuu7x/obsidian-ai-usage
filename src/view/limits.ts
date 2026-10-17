// Limits section: one header per account/agent, aligned bar rows, click to expand reset details.
import { Limit } from "../model";
import { colorMap, countdown, formatReset, gaugeColor, hhmm, windowLabel } from "../format";
import { Ctx, accountTitle } from "./ctx";

export function renderLimits(body: HTMLElement, ctx: Ctx) {
  body.empty();
  const agent = ctx.d.agent;
  const lims = ctx.s.limits.filter((l) => !agent || l.agent === agent);
  const list = body.createDiv({ cls: "aiu-limits" });
  const nowSec = Math.floor(Date.now() / 1000);
  const colors = colorMap([...new Set(ctx.s.limits.map((l) => l.agent))].sort());
  const renderRow = (l: Limit, parent: HTMLElement, label: string) => {
    const open = ctx.s.expandedGauge === l.label;
    const row = parent.createDiv({ cls: "aiu-limit" + (open ? " is-open" : "") });
    row.setAttr("role", "button"); row.setAttr("tabindex", "0");
    const line = row.createDiv({ cls: "aiu-limit-row" });
    line.createSpan({ cls: "aiu-limit-label", text: label });
    const bar = line.createDiv({ cls: "aiu-bar" });
    const fill = bar.createDiv({ cls: "aiu-bar-fill" + (l.pct >= 80 ? " is-hot" : "") });
    fill.style.setProperty("--fill", gaugeColor(l.pct));
    fill.style.width = "0%";
    // ponytail: width animates from 0 on each render; rAF so the transition actually runs
    requestAnimationFrame(() => { fill.style.width = `${Math.max(0, Math.min(100, l.pct))}%`; });
    line.createSpan({ cls: "aiu-limit-pct", text: `${Math.round(l.pct)}%` });
    if (open) {
      row.createDiv({ cls: "aiu-limit-detail", text: `${formatReset(l.resetsAt, new Date())} · in ${countdown(l.resetsAt, nowSec)} · ${l.pct.toFixed(1)}% used · window ${windowLabel(l.windowMinutes)} (${l.windowMinutes} min)` });
    }
    const toggle = () => { ctx.s.expandedGauge = open ? null : l.label; renderLimits(body, ctx); };
    row.onclick = toggle;
    row.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } };
  };
  // one header per account (claude N) or agent (codex, kimi); window rows share one grid so all bars align
  const seen = new Set<string>();
  for (const l of lims) {
    const group = l.account ?? l.agent;
    if (seen.has(group)) continue;
    seen.add(group);
    const head = list.createDiv({ cls: "aiu-acct-head" });
    head.createSpan({ cls: "aiu-dot" }).style.background = colors[l.agent];
    accountTitle(head, group, l.agent, ctx.s.emails[group]);
    if (group === "kimi" && ctx.s.kimiAsOf) {
      const d = new Date(ctx.s.kimiAsOf * 1000);
      head.createSpan({ cls: "aiu-acct-asof", text: `as of ${hhmm(d)}`, attr: { title: "kimi token expired; showing the last successful fetch. Run kimi, then refresh." } });
    }
    for (const m of lims.filter((x) => (x.account ?? x.agent) === group)) renderRow(m, list, m.label.slice(group.length + 1));
  }
  const missing: string[] = [];
  for (const a of ctx.s.noData) {
    if (agent && !a.startsWith(agent)) continue;
    missing.push(a); list.createDiv({ cls: "aiu-limit aiu-muted", text: `${a}: no data yet` });
  }
  if ((!agent || agent === "kimi") && ctx.s.kimiProblem && !ctx.s.kimiMissing) {
    list.createDiv({ cls: "aiu-limit aiu-muted aiu-wrap", text: `kimi: ${ctx.s.kimiProblem}` });
    missing.push("kimi");
  }
  if (!lims.length && !missing.length) body.createDiv({ cls: "aiu-muted", text: "no limits" });
}

