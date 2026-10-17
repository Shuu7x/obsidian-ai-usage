// Agent filter chips + the shared Tokens/Cost toggle.
import { Metric } from "../model";
import { colorMap } from "../format";
import { Ctx } from "./ctx";

export function renderChips(root: HTMLElement, ctx: Ctx) {
  const bar = root.createDiv({ cls: "aiu-chips" });
  const cur = ctx.d.agent;
  const colors = colorMap(ctx.all);
  const chip = (label: string, value: string | null) => {
    const c = bar.createEl("button", { cls: "aiu-chip" + (cur === value ? " is-active" : ""), text: label });
    if (value) c.style.setProperty("--chip-color", colors[value]);
    c.onclick = () => ctx.patch({ agent: value });
  };
  chip("All", null);
  for (const a of ctx.all) chip(a, a);
}

export function renderMetricToggle(parent: HTMLElement, ctx: Ctx) {
  const bar = parent.createDiv({ cls: "aiu-toggle" });
  for (const m of ["tokens", "cost"] as Metric[]) {
    const b = bar.createEl("button", { cls: "aiu-toggle-btn" + (ctx.d.metric === m ? " is-active" : ""), text: m === "tokens" ? "Tokens" : "Cost" });
    b.onclick = () => ctx.patch({ metric: m });
  }
}

export function renderGroupToggle(parent: HTMLElement, ctx: Ctx) {
  const bar = parent.createDiv({ cls: "aiu-toggle" });
  for (const g of ["provider", "model"] as const) {
    const b = bar.createEl("button", { cls: "aiu-toggle-btn" + (ctx.d.groupBy === g ? " is-active" : ""), text: g === "provider" ? "Provider" : "Model" });
    b.onclick = () => ctx.patch({ groupBy: g });
  }
}
