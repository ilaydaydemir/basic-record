#!/bin/bash
set -e
echo "Building..."
npm run dist

echo "Installing..."
rm -rf "/Applications/Basic Record.app"
hdiutil attach "dist/Basic Record-1.0.0-arm64.dmg" -nobrowse -quiet
cp -R "/Volumes/Basic Record 1.0.0-arm64/Basic Record.app" /Applications/
hdiutil detach "/Volumes/Basic Record 1.0.0-arm64" -quiet

echo "Signing..."
codesign --force --deep --sign - "/Applications/Basic Record.app"

echo "Resetting screen permission..."
tccutil reset ScreenCapture co.basicrecord.app 2>/dev/null || true

echo ""
echo "✅ Done! Now:"
echo "   1. Open Basic Record"
echo "   2. System Settings → Screen & System Audio Recording → Basic Record ON"
echo "   3. Click 'Quit & Reopen'"
