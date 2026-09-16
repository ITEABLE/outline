#!/bin/zsh
# Builds Outline.app from src/ + mac/. Pass --install to copy it into /Applications.
set -euo pipefail
cd "$(dirname "$0")"

node build.mjs

APP=build/Outline.app
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

swiftc -O -parse-as-library -swift-version 5 -target arm64-apple-macos12.0 mac/main.swift -o "$APP/Contents/MacOS/Outline"
cp mac/Info.plist "$APP/Contents/Info.plist"
cp dist/index.html dist/app.js dist/app.css "$APP/Contents/Resources/"
cp mac/notes.js "$APP/Contents/Resources/notes.js"
cp mac/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"
codesign --force --sign - "$APP"
echo "Built $APP"

if [[ "${1:-}" == "--install" ]]; then
  rm -rf /Applications/Outline.app
  cp -R "$APP" /Applications/
  echo "Installed /Applications/Outline.app"
fi
