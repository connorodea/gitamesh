#!/usr/bin/env bash
set -Eeuo pipefail

# Gitamesh engineering continuity: one-time global installer.
# Run from a local Gitamesh checkout. Safe to rerun; does not overwrite user instructions.
SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKILL_SOURCE="${SOURCE_ROOT}/skills/gitamesh-engineering-continuity/SKILL.md"
[[ -f "$SKILL_SOURCE" ]] || { echo "Missing $SKILL_SOURCE" >&2; exit 1; }
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
CLAUDE_HOME="$HOME/.claude"
mkdir -p "$CLAUDE_HOME/skills/gitamesh-engineering-continuity" "$CODEX_HOME/skills/gitamesh-engineering-continuity"
cp "$SKILL_SOURCE" "$CLAUDE_HOME/skills/gitamesh-engineering-continuity/SKILL.md"
cp "$SKILL_SOURCE" "$CODEX_HOME/skills/gitamesh-engineering-continuity/SKILL.md"

MARKER="<!-- gitamesh-engineering-continuity:v1 -->"
for target in "$CLAUDE_HOME/CLAUDE.md" "$CODEX_HOME/AGENTS.md"; do
  touch "$target"
  if ! grep -Fq "$MARKER" "$target"; then
    cat >> "$target" <<EOF

$MARKER
For every software development session, apply the installed gitamesh-engineering-continuity skill. Read and maintain the repository-local .agent/progress.md; search before build, compare before merge, and prove before promote. Use Gitamesh task claims and leases when available; never assume a claim was acquired if the daemon is unreachable. Preserve existing project instructions.
EOF
  fi
done

# Claude SessionStart is a supported automatic activation point.
# Hook initializes a log only in a writable Git repository and emits concise context.
HOOK_DIR="$CLAUDE_HOME/hooks"
mkdir -p "$HOOK_DIR"
HOOK="$HOOK_DIR/gitamesh-engineering-continuity.sh"
cat > "$HOOK" <<'HOOK_SCRIPT'
#!/usr/bin/env bash
set -Eeuo pipefail
root="${CLAUDE_PROJECT_DIR:-$PWD}"
if git -C "$root" rev-parse --show-toplevel >/dev/null 2>&1; then
  root="$(git -C "$root" rev-parse --show-toplevel)"
  if [[ -w "$root" ]]; then
    mkdir -p "$root/.agent"
    if [[ ! -e "$root/.agent/progress.md" ]]; then
      printf '# Engineering Progress Log\n\nAppend-only session history.\n' > "$root/.agent/progress.md"
    fi
  fi
fi
printf 'Use gitamesh-engineering-continuity. Read .agent/progress.md and repository instructions; inspect git status. Coordinate overlapping work with Gitamesh claims when available. Record verified progress and a handoff.\n'
HOOK_SCRIPT
chmod +x "$HOOK"

# Preserve existing Claude settings; fail closed on malformed JSON.
if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 required for safe Claude settings merge" >&2; exit 1
fi
CLAUDE_SETTINGS="$CLAUDE_HOME/settings.json" HOOK_PATH="$HOOK" python3 <<'PY'
import json, os
from pathlib import Path
p = Path(os.environ["CLAUDE_SETTINGS"])
data = json.loads(p.read_text()) if p.exists() else {}
if not isinstance(data, dict): raise ValueError("Expected settings JSON object")
hooks = data.setdefault("hooks", {}).setdefault("SessionStart", [])
cmd = os.environ["HOOK_PATH"]
if not any(h.get("command") == cmd for group in hooks if isinstance(group, dict) for h in group.get("hooks", []) if isinstance(h, dict)):
    hooks.append({"matcher": "startup|resume|clear|compact", "hooks": [{"type": "command", "command": cmd, "timeout": 30}]})
temp = p.with_suffix(".json.tmp")
temp.write_text(json.dumps(data, indent=2) + "\n")
temp.replace(p)
PY
echo "Installed global Claude + Codex engineering continuity instructions and Claude startup hook."
echo "Gitamesh MCP/daemon require separate configuration and credentials; no claims are fabricated."
