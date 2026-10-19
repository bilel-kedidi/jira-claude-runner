#!/usr/bin/env bash
# Registers the native messaging host with Chrome.
# Usage: ./install.sh <chrome-extension-id>   (find the id on chrome://extensions)
set -euo pipefail

EXT_ID="${1:?Usage: ./install.sh <chrome-extension-id>}"
HOST_NAME="com.jira_claude.runner"
DIR="$(cd "$(dirname "$0")" && pwd)"

NODE_BIN="$(command -v node)" || { echo "node not found on PATH"; exit 1; }
CLAUDE_BIN="$(command -v claude)" || { echo "claude CLI not found on PATH"; exit 1; }

# Chrome launches the host with a minimal environment, so freeze the current
# shell PATH (node, claude, ruby/rbenv, bundle, …) into a wrapper script.
WRAPPER="$DIR/run-host.sh"
cat > "$WRAPPER" <<EOF
#!/bin/bash
export PATH="$PATH"
export CLAUDE_BIN="$CLAUDE_BIN"
exec "$NODE_BIN" "$DIR/host.js" "\$@"
EOF
chmod +x "$WRAPPER" "$DIR/host.js"

case "$(uname)" in
  Darwin) TARGETS=("$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
                   "$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
                   "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts") ;;
  Linux)  TARGETS=("$HOME/.config/google-chrome/NativeMessagingHosts"
                   "$HOME/.config/chromium/NativeMessagingHosts"
                   "$HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts") ;;
  *) echo "Unsupported OS"; exit 1 ;;
esac

for T in "${TARGETS[@]}"; do
  # Only install for browsers that exist (the Chrome one is always written).
  [[ "$T" == *"Google/Chrome"* || "$T" == *"google-chrome"* || -d "$(dirname "$T")" ]] || continue
  mkdir -p "$T"
  cat > "$T/$HOST_NAME.json" <<EOF
{
  "name": "$HOST_NAME",
  "description": "Jira → Claude runner",
  "path": "$WRAPPER",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
EOF
  echo "Installed $T/$HOST_NAME.json"
done

echo "Done. node=$NODE_BIN claude=$CLAUDE_BIN"
