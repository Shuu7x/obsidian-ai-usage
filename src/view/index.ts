// ItemView shell: owns state, refresh, timers, section chrome and the footer. Sections render themselves.
import { ItemView, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type AiUsagePlugin from "../main";
import { Limit } from "../model";
import { hhmm } from "../format";
import { agentsOf, filterByAgent, fetchUsage } from "../usage";
import * as claude from "../providers/claude";
import * as codex from "../providers/codex";
import * as kimi from "../providers/kimi";
import { Ctx, ViewState, initialState } from "./ctx";
import { renderChips, renderGroupToggle, renderMetricToggle } from "./filters";
import { renderLimits } from "./limits";
import { renderUsage } from "./usage";
import { renderDaily } from "./daily";

export const VIEW_TYPE = "ai-usage-view";

export class AiUsageView extends ItemView {
  private s: ViewState = initialState();
  private notified = new Set<string>();
  private limitsEl: HTMLElement | null = null;

  constructor(leaf: WorkspaceLeaf, private plugin: AiUsagePlugin) { super(leaf); }
  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return "AI usage"; }
  getIcon() { return "gauge"; }

  async onOpen() {
    this.contentEl.addClass("ai-usage");
    this.render();
    void this.refresh();
    this.registerInterval(window.setInterval(() => void this.refresh(), this.plugin.data.refreshMinutes * 60_000));
    // ponytail: countdown ticks by re-rendering only the limits section each minute
    this.registerInterval(window.setInterval(() => { if (this.s.expandedGauge && this.limitsEl) renderLimits(this.limitsEl, this.ctx()); }, 60_000));
  }

  async refresh() {
    const s = this.s;
    if (s.loading) return;
    s.loading = true;
    s.error = null;
    this.render();
    const nowSec = Math.floor(Date.now() / 1000);
    const cl = claude.readLimits(this.plugin.data.claudeDirs, nowSec);
    const cx = codex.readLimits(this.plugin.data.codexHomes, nowSec, this.plugin.data.codexEmail);
    s.noData = [...cl.noData, ...cx.noData];
    s.emails = { ...cl.emails, ...cx.emails };
    let kimiLimits: Limit[] = [];
    // kimi is opt-in: when off, no credential file is touched and no request is made
    const r: kimi.KimiResult = this.plugin.data.kimiEnabled ? await kimi.readLimits(nowSec) : { problem: "no credentials (disabled)" };
    s.kimiMissing = "problem" in r && r.problem.startsWith("no credentials");
    const resolved = s.kimiMissing ? null : kimi.resolveKimi("limits" in r ? r : null, this.plugin.data.kimiCache, nowSec);
    if (resolved) {
      kimiLimits = resolved.cache.limits;
      if (resolved.cache.email) s.emails.kimi = resolved.cache.email;
      s.kimiAsOf = resolved.stale ? resolved.cache.fetchedAt : null;
      s.kimiProblem = null;
      if (!resolved.stale) { this.plugin.data.kimiCache = resolved.cache; await this.plugin.save(); }
    } else {
      s.kimiAsOf = null;
      s.kimiProblem = "problem" in r ? r.problem : null;
    }
    s.limits = [...cl.limits, ...cx.limits, ...kimiLimits];
    for (const l of s.limits) {
      const key = `${l.label}:${l.resetsAt}`;
      if (l.pct >= 80 && !this.notified.has(key)) { this.notified.add(key); new Notice(`AI usage: ${l.label} at ${Math.round(l.pct)}%`); }
    }
    try {
      const u = await fetchUsage(this.plugin.data.bunxPath, this.plugin.data.codexHomes, this.plugin.data.claudeDirs);
      s.days = u.days; s.accounts = u.accounts; s.periodAccounts = u.periodAccounts; s.usageAsOf = u.asOf; s.breakdownFailed = u.breakdownFailed;
      s.updatedAt = new Date();
    } catch (e) {
      s.error = (e as Error).message;
    }
    s.loading = false;
    this.render();
  }

  /** The one place persisted UI choices are written. */
  private patch = (p: Partial<typeof this.plugin.data>) => {
    Object.assign(this.plugin.data, p);
    void this.plugin.save().then(() => this.render());
  };

  private ctx(): Ctx {
    const d = this.plugin.data;
    const all = [...new Set([...agentsOf(this.s.days), ...this.s.limits.map((l) => l.agent), ...(this.s.kimiMissing ? [] : ["kimi"])])].sort();
    const filtered = filterByAgent(this.s.days, d.agent && all.includes(d.agent) ? d.agent : null);
    return { s: this.s, d, all, filtered, patch: this.patch, rerender: () => this.render(), refresh: () => void this.refresh() };
  }

  private render() {
    const root = this.contentEl;
    root.empty();
    const ctx = this.ctx();
    renderChips(root, ctx);
    const bar = root.createDiv({ cls: "aiu-toolbar" });
    renderMetricToggle(bar, ctx);
    renderGroupToggle(bar, ctx);
    this.limitsEl = this.section(root, "gauges", "Limits");
    renderLimits(this.limitsEl, ctx);
    renderUsage(this.section(root, "tiles", "Usage"), ctx);
    renderDaily(this.section(root, "chart", "Daily"), ctx);
    this.footer(root, ctx);
  }

  private section(root: HTMLElement, id: string, title: string): HTMLElement {
    const collapsed = !!this.plugin.data.collapsed[id];
    const wrap = root.createDiv({ cls: "aiu-section" + (collapsed ? " is-collapsed" : "") });
    const head = wrap.createDiv({ cls: "aiu-section-head" });
    const chev = head.createSpan({ cls: "aiu-chevron" });
    setIcon(chev, collapsed ? "chevron-right" : "chevron-down");
    head.createSpan({ text: title });
    head.onclick = () => this.patch({ collapsed: { ...this.plugin.data.collapsed, [id]: !collapsed } });
    return wrap.createDiv({ cls: "aiu-section-body" });
  }

  private footer(root: HTMLElement, ctx: Ctx) {
    const s = ctx.s;
    const f = root.createDiv({ cls: "aiu-footer" });
    f.createSpan({ cls: "aiu-muted", text: s.loading ? "loading…" : s.error ? "usage unavailable" : s.updatedAt ? `updated ${hhmm(s.updatedAt)}` : "" });
    const b = f.createEl("button", { cls: "aiu-refresh clickable-icon", attr: { "aria-label": "Refresh" } });
    setIcon(b, "refresh-cw");
    b.onclick = ctx.refresh;
  }
}
