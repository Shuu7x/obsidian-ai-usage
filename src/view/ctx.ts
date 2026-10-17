// View state (one typed object) and the context handed to every section renderer.
import type { AccountDay, AccountPeriod, DayRow, KpiPeriod, Limit } from "../model";
import type { PluginData } from "../settings";

export interface ViewState {
  // data from the last refresh
  days: DayRow[];
  accounts: AccountDay[];
  periodAccounts: AccountPeriod[];
  usageAsOf: Date; // date snapshot the usage data was fetched for; cards + breakdown derive from it
  breakdownFailed: KpiPeriod[]; // periods whose claude session report failed
  limits: Limit[];
  noData: string[]; // account names with a dir/home but no data yet
  emails: Record<string, string>; // account/agent -> email
  kimiProblem: string | null; // null = kimi limits loaded (fresh or cached)
  kimiAsOf: number | null; // epoch s of the cached kimi fetch when showing stale rows
  kimiMissing: boolean; // no kimi credentials at all -> no chip, no row
  loading: boolean;
  error: string | null;
  updatedAt: Date | null;
  // transient UI (not persisted)
  kpiPeriod: KpiPeriod;
  hidden: Set<string>; // legend-hidden agents
  selectedDay: string | null;
  expandedGauge: string | null;
}

export const initialState = (): ViewState => ({
  days: [], accounts: [], periodAccounts: [], usageAsOf: new Date(), breakdownFailed: [], limits: [], noData: [], emails: {}, kimiProblem: null, kimiAsOf: null, kimiMissing: true,
  loading: false, error: null, updatedAt: null,
  kpiPeriod: "today", hidden: new Set(), selectedDay: null, expandedGauge: null,
});

export interface Ctx {
  s: ViewState;
  d: PluginData; // persisted settings + remembered UI choices
  all: string[]; // every agent known (usage or limits)
  filtered: DayRow[]; // days after the agent chip filter
  patch: (p: Partial<PluginData>) => void; // persist + rerender
  rerender: () => void;
  refresh: () => void;
}

/** "claude · email" when an email is known, else the account label ("claude 2"). */
export function accountTitle(parent: HTMLElement, label: string, agent: string, email: string | undefined) {
  parent.createSpan({ cls: "aiu-acct-name", text: email ? agent : label });
  if (email) { parent.createSpan({ cls: "aiu-acct-sep", text: "·" }); parent.createSpan({ cls: "aiu-acct-dir", text: email, attr: { title: email } }); }
}

const SVG = "http://www.w3.org/2000/svg";
export function svgEl<K extends keyof SVGElementTagNameMap>(parent: Node, tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  parent.appendChild(el);
  return el;
}
