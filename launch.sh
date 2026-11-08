#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd -- "$(dirname -- "$(readlink -f -- "${BASH_SOURCE[0]}")")" && pwd)"
ELECTRON_BIN="$APP_DIR/node_modules/electron/dist/electron"
SANDBOX_BIN="$APP_DIR/node_modules/electron/dist/chrome-sandbox"

if [[ ! -x "$ELECTRON_BIN" ]]; then
  if command -v notify-send >/dev/null 2>&1; then
    notify-send "Figma Frame Screenshotter" "Install dependencies first: cd \"$APP_DIR\" && npm install"
  fi
  echo "Electron is not installed. Run: cd \"$APP_DIR\" && npm install" >&2
  exit 1
fi

SANDBOX_ARGS=()
if [[ ! -u "$SANDBOX_BIN" || "$(stat -c '%u' "$SANDBOX_BIN" 2>/dev/null || echo 0)" != "0" ]]; then
  # Ubuntu blocks Chromium's sandbox for npm-installed Electron launched by GNOME.
  # To restore it, make chrome-sandbox root-owned with mode 4755 after npm install.
  SANDBOX_ARGS+=(--no-sandbox)
fi

exec "$ELECTRON_BIN" "${SANDBOX_ARGS[@]}" "$APP_DIR" "$@"
