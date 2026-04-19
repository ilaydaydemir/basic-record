#!/bin/bash
# patch.sh — update app JS without re-signing the bundle
#
# HOW IT WORKS (after the first run of this new version):
#   • loader.js is a permanent stub inside the signed asar — it never changes.
#   • On startup, loader.js checks ~/Library/Application Support/Basic Record/main-override.js
#     and requires it if present, otherwise falls back to main-real.js inside the asar.
#   • Future patches ONLY update main-override.js in userData; the asar and its
#     code-signature are never touched again, so macOS never revokes Screen Recording TCC.
#
# FIRST-RUN NOTE:
#   This patch does update the asar once (to install loader.js + main-real.js) and
#   re-signs, so you will need to re-grant Screen Recording once. After that,
#   subsequent runs of this script skip the asar entirely.

set -e

APP="/Applications/Basic Record.app"
ASAR="$APP/Contents/Resources/app.asar"
USERDATA="$HOME/Library/Application Support/Basic Record"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ── Check whether loader.js is already installed in the bundle ──────────────
LOADER_INSTALLED=false
TMP_CHECK="/tmp/br-check-$$"
npx --yes asar extract "$ASAR" "$TMP_CHECK" 2>/dev/null || true
if [ -f "$TMP_CHECK/loader.js" ]; then
  LOADER_INSTALLED=true
fi
rm -rf "$TMP_CHECK"

if [ "$LOADER_INSTALLED" = "true" ]; then
  # ── Fast path: loader already in bundle — just update userData override ────
  echo "→ loader.js detected in bundle — updating userData override only (no re-sign needed)…"
  mkdir -p "$USERDATA"
  cp "$SCRIPT_DIR/main-real.js"  "$USERDATA/main-override.js"
  cp "$SCRIPT_DIR/preload.js"    "$USERDATA/preload.js"
  cp "$SCRIPT_DIR/src/editor.js" "$USERDATA/editor-override.js"
  echo "✓ Done — main-override.js written to:"
  echo "  $USERDATA/main-override.js"
  echo ""
  echo "  Quit and reopen Basic Record to apply changes."
  echo "  Screen Recording permission is NOT affected."
else
  # ── First-time migration: pack loader.js + main-real.js into the asar ─────
  echo "→ First-time setup: installing loader.js into the bundle…"
  TMP="/tmp/br-patch-$$"

  echo "→ Extracting asar…"
  npx asar extract "$ASAR" "$TMP"

  echo "→ Copying source files…"
  cp "$SCRIPT_DIR/loader.js"    "$TMP/loader.js"
  cp "$SCRIPT_DIR/main-real.js" "$TMP/main-real.js"
  cp "$SCRIPT_DIR/main.js"      "$TMP/main.js"
  cp "$SCRIPT_DIR/preload.js"   "$TMP/preload.js"
  cp "$SCRIPT_DIR/package.json" "$TMP/package.json"
  cp -r "$SCRIPT_DIR/src/"      "$TMP/src/"

  echo "→ Repacking asar…"
  npx asar pack "$TMP" "$ASAR"

  echo "→ Cleaning up…"
  rm -rf "$TMP"

  echo "→ Re-signing app (ad-hoc) — this is the LAST time…"
  codesign --force --deep --sign - "$APP" 2>/dev/null || true

  # Also seed the userData override so it's ready for the next patch
  echo "→ Writing initial userData override…"
  mkdir -p "$USERDATA"
  cp "$SCRIPT_DIR/main-real.js" "$USERDATA/main-override.js"
  cp "$SCRIPT_DIR/src/editor.js" "$USERDATA/editor-override.js"

  echo ""
  echo "✓ Done — restart Basic Record to apply changes."
  echo ""
  echo "⚠️  Screen Recording permission was reset by re-signing."
  echo "   System Settings → Privacy & Security → Screen Recording"
  echo "   Toggle Basic Record OFF → ON → Quit & reopen app."
  echo ""
  echo "   After this one-time re-grant, future patches will NEVER"
  echo "   touch the asar or trigger the permission dialog again."
fi
