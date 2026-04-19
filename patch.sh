#!/bin/bash
# patch.sh — update app JS without reinstalling (preserves macOS permissions)
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

echo "✓ Done — restart Basic Record to apply changes"
