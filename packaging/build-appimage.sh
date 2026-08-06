#!/usr/bin/env bash
# Build an AppImage for Audibian.
#
# Requirements (auto-downloaded if missing):
#   - linuxdeploy  (https://github.com/linuxdeploy/linuxdeploy)
#   - linuxdeploy-plugin-gtk  (bundles GTK libraries automatically)
#   - appimagetool  (https://github.com/AppImage/AppImageKit)
#
# Usage:
#   make appimage
#   # or directly:
#   bash packaging/build-appimage.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APPDIR="$REPO_ROOT/packaging/AppDir"
BINARY="$REPO_ROOT/target/release/audibian"
OUTPUT="${AUDIBIAN_APPIMAGE_OUTPUT:-$REPO_ROOT/Audibian-x86_64.AppImage}"

# A running AppImage is a live FUSE mount backed by this very file, so
# overwriting it corrupts the mount and kills the process with SIGBUS —
# taking the whole audio graph down mid-session. Refuse by default.
if [[ -e "$OUTPUT" ]] && pgrep -x audibian >/dev/null 2>&1 \
   && [[ -z "${AUDIBIAN_APPIMAGE_FORCE:-}" ]]; then
  echo "ERROR: audibian is running and '$OUTPUT' would be overwritten."
  echo "Close it first, or build elsewhere:"
  echo "  AUDIBIAN_APPIMAGE_OUTPUT=/tmp/Audibian-new.AppImage make appimage"
  echo "Set AUDIBIAN_APPIMAGE_FORCE=1 to override."
  exit 1
fi

# ── Verify binary ──────────────────────────────────────────────────────────
if [[ ! -f "$BINARY" ]]; then
  echo "ERROR: release binary not found. Run 'cargo build --release' first."
  exit 1
fi

# ── Download tools if not present ─────────────────────────────────────────
BIN_DIR="$REPO_ROOT/packaging/tools"
mkdir -p "$BIN_DIR"

LINUXDEPLOY="$BIN_DIR/linuxdeploy-x86_64.AppImage"
LINUXDEPLOY_GTK="$BIN_DIR/linuxdeploy-plugin-gtk.sh"
APPIMAGETOOL="$BIN_DIR/appimagetool-x86_64.AppImage"

if [[ ! -f "$LINUXDEPLOY" ]]; then
  echo "Downloading linuxdeploy..."
  curl -L -o "$LINUXDEPLOY" \
    "https://github.com/linuxdeploy/linuxdeploy/releases/download/continuous/linuxdeploy-x86_64.AppImage"
  chmod +x "$LINUXDEPLOY"
fi

if [[ ! -f "$LINUXDEPLOY_GTK" ]]; then
  echo "Downloading linuxdeploy-plugin-gtk..."
  curl -L -o "$LINUXDEPLOY_GTK" \
    "https://raw.githubusercontent.com/linuxdeploy/linuxdeploy-plugin-gtk/master/linuxdeploy-plugin-gtk.sh"
  chmod +x "$LINUXDEPLOY_GTK"
fi

if [[ ! -f "$APPIMAGETOOL" ]]; then
  echo "Downloading appimagetool..."
  curl -L -o "$APPIMAGETOOL" \
    "https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-x86_64.AppImage"
  chmod +x "$APPIMAGETOOL"
fi

# ── Build AppDir ───────────────────────────────────────────────────────────
rm -rf "$APPDIR"
mkdir -p "$APPDIR/usr/bin"
mkdir -p "$APPDIR/usr/share/applications"
mkdir -p "$APPDIR/usr/share/icons/hicolor/scalable/apps"

cp "$BINARY" "$APPDIR/usr/bin/audibian"
cp "$REPO_ROOT/data/audibian.desktop" "$APPDIR/usr/share/applications/"
cp "$REPO_ROOT/data/icons/scalable/apps/audibian.svg" \
   "$APPDIR/usr/share/icons/hicolor/scalable/apps/"

# Desktop + icon at AppDir root (required by AppImage spec)
cp "$REPO_ROOT/data/audibian.desktop" "$APPDIR/"
cp "$REPO_ROOT/data/icons/scalable/apps/audibian.svg" "$APPDIR/audibian.svg"

# ── linuxdeploy + GTK plugin ───────────────────────────────────────────────
export DEPLOY_GTK_VERSION=3
export PATH="$BIN_DIR:$PATH"
export NO_STRIP=true    # Rust binaries are already stripped in release mode
# Run AppImage tools without FUSE (works in containers and systems without libfuse2)
export APPIMAGE_EXTRACT_AND_RUN=1

echo "Running linuxdeploy with GTK plugin..."
"$LINUXDEPLOY" \
  --appdir "$APPDIR" \
  --plugin gtk \
  --executable "$BINARY" \
  --desktop-file "$REPO_ROOT/data/audibian.desktop" \
  --icon-file "$REPO_ROOT/data/icons/scalable/apps/audibian.svg"

# ── Create AppRun ──────────────────────────────────────────────────────────
cat > "$APPDIR/AppRun" <<'EOF'
#!/bin/bash
APPDIR="$(dirname "$(readlink -f "$0")")"
export XDG_DATA_DIRS="$APPDIR/usr/share:${XDG_DATA_DIRS:-/usr/local/share:/usr/share}"
export GDK_PIXBUF_MODULE_FILE="$APPDIR/usr/lib/x86_64-linux-gnu/gdk-pixbuf-2.0/2.10.0/loaders.cache"
export GDK_PIXBUF_MODULEDIR="$APPDIR/usr/lib/x86_64-linux-gnu/gdk-pixbuf-2.0/2.10.0/loaders"
export GIO_MODULE_DIR="$APPDIR/usr/lib/x86_64-linux-gnu/gio/modules"
exec "$APPDIR/usr/bin/audibian" "$@"
EOF
chmod +x "$APPDIR/AppRun"

# ── Pack AppImage ──────────────────────────────────────────────────────────
echo "Packing AppImage..."
ARCH=x86_64 APPIMAGE_EXTRACT_AND_RUN=1 "$APPIMAGETOOL" "$APPDIR" "$OUTPUT"

echo ""
echo "✓ AppImage ready: $OUTPUT"
echo ""
echo "To run on systems without FUSE (e.g. Debian 12 without libfuse2):"
echo "  APPIMAGE_EXTRACT_AND_RUN=1 $OUTPUT"
echo "Or install FUSE 2:"
echo "  sudo apt install libfuse2"
