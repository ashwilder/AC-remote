#!/usr/bin/env bash
# Builds the Windows installer (dist/AC-Remote-Setup-<version>.exe) from Linux or Windows (Git Bash).
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
STAGE="$ROOT/build/stage"
rm -rf "$STAGE" && mkdir -p "$STAGE/desktop"

cp -r src public scripts "$STAGE/"
cp desktop/main.cjs desktop/loading.html desktop/icon.png desktop/tray.png desktop/icon.ico desktop/afterPack.cjs "$STAGE/desktop/"
cp package-lock.json "$STAGE/"
node -e '
const p = require("./package.json");
const out = { name: p.name, productName: "AC Remote", version: p.version, description: p.description, author: "AC Remote",
  main: "desktop/main.cjs", type: "module", license: p.license, dependencies: p.dependencies, optionalDependencies: p.optionalDependencies };
require("fs").writeFileSync(process.argv[1], JSON.stringify(out, null, 2));
' "$STAGE/package.json"

# Windows versions of the dependencies (including the prebuilt Bluetooth module).
(cd "$STAGE" && npm ci --omit=dev --os=win32 --cpu=x64 --ignore-scripts --no-audit --no-fund)
# Trim what the app never loads: CommonJS builds, TypeScript sources/types and source maps of matter.js,
# and native builds for other platforms.
find "$STAGE/node_modules/@matter" -type d \( -path "*/dist/cjs" -o -name src \) -prune -exec rm -rf {} +
find "$STAGE/node_modules" \( -name "*.map" -o -name "*.d.ts" -o -name "*.d.ts.map" -o -name "*.md" \) -type f -delete
find "$STAGE/node_modules" -type d -path "*/prebuilds/*" ! -name "win32-x64" ! -name "prebuilds" -prune -exec rm -rf {} +
test -f "$STAGE/node_modules/@stoprocent/noble/prebuilds/win32-x64/node.napi.node" || echo "warning: Windows Bluetooth module missing; Bluetooth pairing will be unavailable"

# Package the app (folder only), then compile our own NSIS installer, which needs no Wine.
npx --prefix "$ROOT" electron-builder --projectDir "$STAGE" --config "$ROOT/desktop/builder.json" --win dir --x64 --publish never
UNPACKED="$STAGE/../dist/win-unpacked"
NSIS=$(dirname "$(find "$HOME/.cache/electron-builder" -path "*nsis-3*/linux/makensis" | head -1)" 2>/dev/null || true)
if [ -z "$NSIS" ] || [ ! -x "$NSIS/makensis" ]; then
  # electron-builder downloads NSIS the first time it builds an nsis target; fetch it that way if missing.
  npx --prefix "$ROOT" electron-builder --projectDir "$STAGE" --config "$ROOT/desktop/builder.json" --win nsis --x64 --publish never >/dev/null 2>&1 || true
  NSIS=$(dirname "$(find "$HOME/.cache/electron-builder" -path "*nsis-3*/linux/makensis" | head -1)")
fi
VERSION=$(node -p 'require("./package.json").version')
mkdir -p "$ROOT/dist"
NSISDIR="$(dirname "$NSIS")" "$NSIS/makensis" -V2 -DVERSION="$VERSION" -DSRC="$UNPACKED" -DOUT="$ROOT/dist/AC-Remote-Setup-$VERSION.exe" -DRES="$ROOT/desktop" "$ROOT/desktop/installer.nsi"
ls -la "$ROOT/dist"
