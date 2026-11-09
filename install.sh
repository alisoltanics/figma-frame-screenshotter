#!/usr/bin/env bash
set -euo pipefail

APP_ID="figma-frame-screenshotter"
APP_DIR="$(cd -- "$(dirname -- "$(readlink -f -- "${BASH_SOURCE[0]}")")" && pwd)"
DESKTOP_DIR="$HOME/.local/share/applications"
ICON_DIR="$HOME/.local/share/icons/hicolor"
BIN_DIR="$HOME/.local/bin"

if [[ ! -x "$APP_DIR/node_modules/electron/dist/electron" ]]; then
  echo "Install dependencies first: cd \"$APP_DIR\" && npm install" >&2
  exit 1
fi

chmod +x "$APP_DIR/launch.sh"

mkdir -p "$DESKTOP_DIR" "$ICON_DIR/512x512/apps" "$ICON_DIR/scalable/apps" "$BIN_DIR"
install -m 0644 "$APP_DIR/assets/icon.png" "$ICON_DIR/512x512/apps/$APP_ID.png"
install -m 0644 "$APP_DIR/assets/icon.svg" "$ICON_DIR/scalable/apps/$APP_ID.svg"

# Install the CLI launcher on PATH. ~/.local/bin is on PATH in the default
# Ubuntu shell profile.
ln -sfn "$APP_DIR/bin/figma-shot" "$BIN_DIR/figma-shot"

EXEC_PATH="$APP_DIR/launch.sh"
EXEC_PATH="${EXEC_PATH//\\/\\\\}"
EXEC_PATH="${EXEC_PATH//\"/\\\"}"

cat > "$DESKTOP_DIR/$APP_ID.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Figma Frame Screenshotter
GenericName=Figma screenshot tool
Comment=Capture Figma frames as PNG files
Exec="$EXEC_PATH"
Icon=$APP_ID
Terminal=false
Categories=Graphics;
StartupWMClass=$APP_ID
StartupNotify=true
Keywords=figma;screenshot;frame;png;design;
EOF

chmod 0644 "$DESKTOP_DIR/$APP_ID.desktop"

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1 || true
fi

if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -f -t "$ICON_DIR" >/dev/null 2>&1 || true
fi

if command -v desktop-file-validate >/dev/null 2>&1; then
  desktop-file-validate "$DESKTOP_DIR/$APP_ID.desktop"
fi

echo "Installed: $DESKTOP_DIR/$APP_ID.desktop"
echo "Icon:      $ICON_DIR/512x512/apps/$APP_ID.png"
echo "CLI:       $BIN_DIR/figma-shot"
echo "AI skill:  $BIN_DIR/figma-shot skill --install"
