import { Plugin } from "obsidian";
import { AiUsageSettingTab, DEFAULTS, PluginData } from "./settings";
import { AiUsageView, VIEW_TYPE } from "./view";

export default class AiUsagePlugin extends Plugin {
  data: PluginData = { ...DEFAULTS };

  async onload() {
    this.data = { ...DEFAULTS, ...((await this.loadData()) ?? {}) };
    this.registerView(VIEW_TYPE, (leaf) => new AiUsageView(leaf, this));
    this.addRibbonIcon("gauge", "Open AI usage", () => this.activate());
    this.addCommand({ id: "open", name: "Open AI usage", callback: () => this.activate() });
    this.addSettingTab(new AiUsageSettingTab(this.app, this));
  }

  async save() { await this.saveData(this.data); }

  // data.json changed outside Obsidian (another tool, sync): reload so the next save() does not overwrite it
  async onExternalSettingsChange() {
    this.data = { ...DEFAULTS, ...((await this.loadData()) ?? {}) };
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) (leaf.view as AiUsageView).refresh();
  }

  async activate() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false)!;
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }
}

