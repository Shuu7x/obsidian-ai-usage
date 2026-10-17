#!/bin/sh
# Claude Code statusLine tap for the Obsidian "AI Usage" plugin.
#
# Claude Code pipes a JSON payload to the statusLine command on every update. This script:
#   1. saves the payload (it carries "rate_limits") to <config dir>/statusline-last.json
#   2. appends the session_id to <config dir>/account-sessions.txt (per-account usage mapping)
#   3. optionally chains to your previous statusLine command, given in AI_USAGE_CHAIN
#
# <config dir> is $CLAUDE_CONFIG_DIR when set (multi-account), else $HOME/.claude.
#
# settings.json:
#   "statusLine": { "type": "command", "command": "sh /path/to/claude-limits-tap.sh" }
# keep an existing status line:
#   "command": "AI_USAGE_CHAIN='/path/to/your-statusline.sh' sh /path/to/claude-limits-tap.sh"
payload=$(cat)
dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
case "$payload" in *'"rate_limits"'*) printf '%s' "$payload" > "$dir/statusline-last.json" ;; esac
sid=$(printf '%s' "$payload" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
map="$dir/account-sessions.txt"
[ -n "$sid" ] && ! grep -qx "$sid" "$map" 2>/dev/null && echo "$sid" >> "$map"
[ -n "$AI_USAGE_CHAIN" ] && printf '%s' "$payload" | sh -c "$AI_USAGE_CHAIN"
exit 0
