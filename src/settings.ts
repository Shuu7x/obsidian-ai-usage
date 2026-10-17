// Persisted plugin data (settings + remembered UI state) and the settings tab.
import { App, PluginSettingTab, Setting } from "obsidian";
import { Metric } from "./model";
import { KimiCache } from "./providers/kimi";
import type AiUsagePlugin from "./main";

export interface PluginData {
  bunxPath: string;
  refreshMinutes: number;
  claudeDirs: string[]; // one statusline-last.json per account
  codexHomes: string[]; // CODEX_HOME per account
  kimiEnabled: boolean; // read ~/.kimi-code credentials and call the kimi usage API
  codexEmail: boolean; // read <home>/auth.json id_token for the account email
  agent: string | null; // chip filter
  range: 7 | 14 | 30;
  metric: Metric;
  collapsed: Record<string, boolean>; // section id -> collapsed
  kimiCache: KimiCache | null; // last successful kimi fetch (no secrets)
}
export const DEFAULTS: PluginData = {
  bunxPath: "~/.bun/bin/bunx",
  refreshMinutes: 5,
  claudeDirs: ["~/.claude"],
  codexHomes: ["~/.codex"],
  kimiEnabled: false,
  codexEmail: false,
  agent: null,
  range: 14,
  metric: "tokens",
  collapsed: {},
  kimiCache: null,
};

export class AiUsageSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: AiUsagePlugin) { super(app, plugin); }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl)
      .setName("bunx path")
      .setDesc("Used to run ccusage. Default ~/.bun/bin/bunx")
      .addText((t) => t.setValue(this.plugin.data.bunxPath).onChange(async (v) => { this.plugin.data.bunxPath = v.trim() || DEFAULTS.bunxPath; await this.plugin.save(); }));
    new Setting(containerEl)
      .setName("Claude config dirs")
      .setDesc("One per line, one per account. Each is read for statusline-last.json. Rows are labelled claude 1, claude 2, … in this order.")
      .addTextArea((t) => t.setValue(this.plugin.data.claudeDirs.join("\n")).onChange(async (v) => { const dirs = v.split("\n").map((x) => x.trim()).filter(Boolean); this.plugin.data.claudeDirs = dirs.length ? dirs : DEFAULTS.claudeDirs; await this.plugin.save(); }));
    new Setting(containerEl)
      .setName("Codex homes")
      .setDesc("One per line, one per account (CODEX_HOME). Sessions, limits and usage are read from each. Rows are labelled codex 1, codex 2, …")
      .addTextArea((t) => t.setValue(this.plugin.data.codexHomes.join("\n")).onChange(async (v) => { const hs = v.split("\n").map((x) => x.trim()).filter(Boolean); this.plugin.data.codexHomes = hs.length ? hs : DEFAULTS.codexHomes; await this.plugin.save(); }));
    new Setting(containerEl)
      .setName("Codex account email")
      .setDesc("Off by default. When on, reads <home>/auth.json, decodes only the id_token payload (no verification) and shows its email claim in the header. The token itself is never stored, logged or sent anywhere.")
      .addToggle((t) => t.setValue(this.plugin.data.codexEmail).onChange(async (v) => { this.plugin.data.codexEmail = v; await this.plugin.save(); }));
    new Setting(containerEl)
      .setName("Kimi limits")
      .setDesc("Off by default. When on, reads the access token the kimi CLI stores in ~/.kimi-code/credentials and calls GET /usages and GET /me on api.kimi.com (or KIMI_CODE_BASE_URL) with it. Read-only: the token is never refreshed, stored or sent elsewhere. The last successful numbers and email are cached in plugin data.")
      .addToggle((t) => t.setValue(this.plugin.data.kimiEnabled).onChange(async (v) => { this.plugin.data.kimiEnabled = v; if (!v) this.plugin.data.kimiCache = null; await this.plugin.save(); }));
    new Setting(containerEl)
      .setName("Refresh interval (minutes)")
      .setDesc("Auto refresh of usage and limits. Takes effect on next view open.")
      .addText((t) => t.setValue(String(this.plugin.data.refreshMinutes)).onChange(async (v) => { const n = Number(v); this.plugin.data.refreshMinutes = n > 0 ? n : DEFAULTS.refreshMinutes; await this.plugin.save(); }));
  }
}
