# AI Usage (Obsidian plugin)

Token usage and rate limits of your coding agents (Claude Code, Codex, Kimi) in Obsidian's right sidebar.
Desktop only. Read-only: it never writes notes to your vault.

![screenshot placeholder](docs/screenshot.png)

## What it shows

- **Agent chips** (All / claude / codex / kimi) that filter every widget. Tokens / Cost toggle.
- **Limits**: one progress-bar row per rate-limit window (claude 5h, claude 7d, codex 7d, kimi 5h, …), grouped
  per account with the account email. Click a row for exact %, window length, reset time and a live countdown.
  A notice fires once per window when a limit reaches 80%.
- **Usage**: today / 7d / 30d / this month cards with 7-day sparklines. Tap a card to drive the per-account
  breakdown under it.
- **Daily**: 7d / 14d / 30d chart, one line per agent. Hover a day for per-agent tokens and cost, click a day
  for the per-model breakdown, click a legend entry to hide a line.
- Collapsible sections, remembered. Auto-refresh every 5 minutes (configurable) and on open.

## Requirements

- Obsidian desktop (macOS, Linux, Windows). Not available on mobile.
- [bun](https://bun.sh) for token usage: the plugin runs `bunx ccusage@20.0.34` on your local session logs.
  Rate limits work without bun.
- Claude Code with the status-line tap below, Codex CLI, and/or Kimi Code CLI.

## Install

### Via BRAT (recommended while in beta)

1. Install the community plugin **BRAT** (Obsidian42).
2. BRAT settings → *Add beta plugin* → `Shuu7x/obsidian-ai-usage`.
3. Enable **AI Usage** in *Settings → Community plugins*.

### Manual

Download `main.js`, `manifest.json`, `styles.css` from the latest release into
`<vault>/.obsidian/plugins/ai-usage/` and enable the plugin.

## Setup

### Token usage (all agents)

Install bun. If `bunx` is not at `~/.bun/bin/bunx`, set the path in the plugin settings.
The first run downloads `ccusage`, so it can take a while.

### Claude Code limits: status-line tap

Claude Code only reports rate limits to its status line, so a tiny script has to save them.
Copy [`scripts/claude-limits-tap.sh`](scripts/claude-limits-tap.sh) somewhere and point `~/.claude/settings.json` at it:

```json
{
  "statusLine": { "type": "command", "command": "sh /path/to/claude-limits-tap.sh" }
}
```

Already have a status line? Chain it:

```json
{
  "statusLine": { "type": "command", "command": "AI_USAGE_CHAIN='sh /path/to/your-statusline.sh' sh /path/to/claude-limits-tap.sh" }
}
```

The script writes `statusline-last.json` and `account-sessions.txt` into the Claude config dir and nothing else.

### Multiple accounts

- **Claude Code**: run each account with its own `CLAUDE_CONFIG_DIR` (for example `~/.claude-2`), then list every
  dir in *Settings → Claude config dirs*, one per line. Rows are labelled `claude · email` (email from that dir's
  `.claude.json`). Per-account usage works because the tap records which sessions each account ran.
- **Codex**: run each account with its own `CODEX_HOME` (for example `~/.codex-2`) and list every home in
  *Settings → Codex homes*. Extra homes get their own `ccusage codex daily` run.

### Kimi (optional, off by default)

Turn on *Settings → Kimi limits*. See Privacy for what it reads.

## Privacy

Everything is read-only. Files read:

| Agent | Files | Purpose |
|---|---|---|
| all | session logs via `ccusage` (`~/.claude/projects`, `~/.codex/sessions`, …) | token usage |
| claude | `<dir>/statusline-last.json`, `<dir>/account-sessions.txt` | limits, per-account usage |
| claude | `~/.claude.json` or `<dir>/.claude.json`: only `oauthAccount.emailAddress` | header email |
| codex | newest `<home>/sessions/**/*.jsonl`: only the last `rate_limits` line | limits |
| codex (opt-in) | `<home>/auth.json`: only the `id_token` payload's email claim, decoded locally | header email |
| kimi (opt-in) | `~/.kimi-code/credentials/*.json`: the access token and its expiry | API calls below |

Network calls: **none**, unless *Kimi limits* is on. Then the plugin calls `GET /coding/v1/usages` and
`GET /coding/v1/me` on `api.kimi.com` (or `KIMI_CODE_BASE_URL`) with the kimi CLI's bearer token. The token is
never refreshed, logged, stored or sent anywhere else; only the returned numbers and email are cached in plugin data.

`ccusage` itself fetches model pricing from LiteLLM unless cached. No telemetry.

## Development

```
npm install
npm run build    # tsc + esbuild -> main.js
npm test         # node:test over the pure modules
npm run dev      # watch
```

Layout: `src/providers/{claude,codex,kimi}.ts` own each agent's parsers and file/API reading and export the same
small shape (`readLimits`, optional usage contribution). `src/usage.ts` runs ccusage and merges accounts,
`src/chart.ts` and `src/format.ts` are pure math and formatting, `src/view/` is the sidebar (one file per section).
Adding an agent is one new provider file plus two wiring lines.

Release: bump `manifest.json`, `versions.json` and `package.json`, then push a tag `x.y.z` (no `v`).
The workflow runs tests, builds and publishes `main.js`, `manifest.json`, `styles.css`.

## License

MIT
