#!/bin/bash
# patch.sh — update app JS and re-sign in-place
set -e

APP="/Applications/Basic Record.app"
ASAR="$APP/Contents/Resources/app.asar"
TMP="/tmp/br-patch-$$"

echo "→ Extracting asar…"
npx asar extract "$ASAR" "$TMP"

echo "→ Copying source files…"
cp main.js        "$TMP/main.js"
cp preload.js     "$TMP/preload.js"
cp package.json   "$TMP/package.json"
cp -r src/        "$TMP/src/"

echo "→ Repacking asar…"
npx asar pack "$TMP" "$ASAR"

echo "→ Cleaning up…"
rm -rf "$TMP"

echo "→ Re-signing app (ad-hoc)…"
codesign --force --deep --sign - "$APP" 2>/dev/null || true

echo "✓ Done — restart Basic Record to apply changes"
echo ""
echo "⚠️  If Screen Recording permission was lost:"
echo "   System Settings → Privacy & Security → Screen Recording"
echo "   Toggle Basic Record OFF → ON → Quit & reopen app"
