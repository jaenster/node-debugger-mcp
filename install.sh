#!/usr/bin/env bash
# Install / update node-debugger-mcp for Claude Code.
#
# Two modes (auto-detected):
#   1. In-repo:   ./install.sh        (build + register from this checkout)
#   2. Bootstrap: curl ... | bash     (clone to ~/.local/share/node-debugger-mcp, then build + register)

set -euo pipefail

REPO_URL="${NDM_REPO_URL:-https://github.com/jaenster/node-debugger-mcp.git}"
INSTALL_DIR="${NDM_INSTALL_DIR:-$HOME/.local/share/node-debugger-mcp}"
NAME="node-debugger"

require() {
  command -v "$1" >/dev/null 2>&1 || { echo "error: '$1' not found on PATH"; exit 1; }
}

require node
require npm

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "error: node ${NODE_MAJOR} is too old; need >= 20"
  exit 1
fi

# Are we running from inside the repo, or being piped from curl?
SCRIPT_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/package.json" ] && grep -q '"node-debugger-mcp"' "$SCRIPT_DIR/package.json"; then
  echo "==> in-repo install from $SCRIPT_DIR"
  cd "$SCRIPT_DIR"
else
  echo "==> bootstrap install into $INSTALL_DIR"
  require git
  if [ -d "$INSTALL_DIR/.git" ]; then
    echo "==> updating existing checkout"
    git -C "$INSTALL_DIR" fetch --quiet origin
    git -C "$INSTALL_DIR" reset --hard --quiet origin/HEAD
  else
    echo "==> cloning $REPO_URL"
    mkdir -p "$(dirname "$INSTALL_DIR")"
    git clone --quiet --depth 1 "$REPO_URL" "$INSTALL_DIR"
  fi
  cd "$INSTALL_DIR"
fi

ENTRY="$(pwd)/dist/server.js"

# Parse optional flags (also passable as env vars NDM_ALLOW_RAW=1, NDM_SCOPE=...)
ALLOW_RAW="${NDM_ALLOW_RAW:-0}"
SCOPE="${NDM_SCOPE:-user}"
for arg in "${@:-}"; do
  case "$arg" in
    --allow-raw)      ALLOW_RAW=1 ;;
    --scope=local)    SCOPE="local" ;;
    --scope=project)  SCOPE="project" ;;
    --scope=user)     SCOPE="user" ;;
    -h|--help)
      cat <<EOF
Usage: install.sh [--allow-raw] [--scope=user|local|project]

  --allow-raw         Set MCP_DEBUGGER_ALLOW_RAW=1 so debug_cdp_raw is exposed.
  --scope=<scope>     Install scope for \`claude mcp add\` (default: user).

Env vars:
  NDM_REPO_URL        Override the repo URL for bootstrap mode.
  NDM_INSTALL_DIR     Override the bootstrap checkout directory.
EOF
      exit 0
      ;;
    "") ;;
    *)  echo "unknown flag: $arg (try --help)"; exit 1 ;;
  esac
done

echo "==> installing dependencies (npm install)"
npm install --silent

echo "==> building bundle (tsup)"
npm run build --silent

if [ ! -f "$ENTRY" ]; then
  echo "error: build did not produce $ENTRY"
  exit 1
fi

if command -v claude >/dev/null 2>&1; then
  echo "==> registering with \`claude mcp\` (scope=$SCOPE)"
  claude mcp remove -s "$SCOPE" "$NAME" >/dev/null 2>&1 || true
  ENV_ARGS=()
  if [ "$ALLOW_RAW" = "1" ]; then
    ENV_ARGS+=(-e "MCP_DEBUGGER_ALLOW_RAW=1")
  fi
  claude mcp add -s "$SCOPE" "${ENV_ARGS[@]+"${ENV_ARGS[@]}"}" "$NAME" node "$ENTRY"
  echo
  echo "==> installed. Verify with:  claude mcp list"
  echo "    In an open Claude Code session, run \`/mcp\` to reconnect; otherwise tools appear at next session start."
else
  cat <<EOF

==> \`claude\` CLI not found on PATH — skipping auto-registration.
    Add this to your Claude Code MCP config manually:

      "node-debugger": {
        "command": "node",
        "args": ["$ENTRY"]$([ "$ALLOW_RAW" = "1" ] && echo ',
        "env": { "MCP_DEBUGGER_ALLOW_RAW": "1" }')
      }
EOF
fi
