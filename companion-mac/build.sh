#!/bin/bash
# Build the idleai companion into a double-clickable .app (no Xcode project).
set -euo pipefail
cd "$(dirname "$0")"

APP="Idleai Companion.app"
swiftc -O main.swift -o idleai-companion

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp idleai-companion "$APP/Contents/MacOS/"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>idleai-companion</string>
  <key>CFBundleIdentifier</key><string>app.idleai.companion</string>
  <key>CFBundleName</key><string>Idleai Companion</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST

# Ad-hoc sign with a STABLE identifier so the Accessibility (TCC) grant sticks
# across rebuilds. Without this, swiftc's default ad-hoc signature changes every
# build and macOS treats each build as a new app, dropping the permission.
codesign --force --sign - --identifier app.idleai.companion "$APP" 2>/dev/null \
  && echo "  signed (stable ad-hoc identity — Accessibility grant persists)" \
  || echo "  (codesign unavailable — Accessibility may need re-granting each build)"

echo "✶ built: $APP  (menu-bar only — LSUIElement)"
echo "  run:   open \"$APP\"    (needs ~/.idleai.json — idleai login idl_xxx first)"
echo "  grant: System Settings → Privacy & Security → Accessibility → enable it (once)"
