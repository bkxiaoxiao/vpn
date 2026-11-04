#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
project_root=$(pwd)
build_dir="$project_root/build"
app_dir="$project_root/dist/Relay Enterprise.app"
app_version=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' Resources/Info.plist)
mkdir -p "$build_dir/module-cache" "$app_dir/Contents/MacOS" "$app_dir/Contents/Resources"
core_path=${SING_BOX_PATH:-/opt/homebrew/bin/sing-box}
test -x "$core_path"
xcrun swiftc -swift-version 5 -O -target arm64-apple-macosx13.0 -module-cache-path "$build_dir/module-cache" Sources/*.swift -o "$app_dir/Contents/MacOS/RelayEnterprise" -framework SwiftUI -framework AppKit -framework AuthenticationServices -framework Security -framework SystemConfiguration -framework CryptoKit
cp Resources/Info.plist "$app_dir/Contents/Info.plist"
if [ -f "$app_dir/Contents/Resources/sing-box" ]; then chmod u+w "$app_dir/Contents/Resources/sing-box"; fi
cp -L "$core_path" "$app_dir/Contents/Resources/sing-box"
cp Resources/core-watchdog.sh "$app_dir/Contents/Resources/core-watchdog.sh"
cp Resources/安装与测试.txt "$app_dir/Contents/Resources/安装与测试.txt"
cp Resources/THIRD_PARTY_NOTICES.txt "$app_dir/Contents/Resources/THIRD_PARTY_NOTICES.txt"
cp Resources/sing-box-LICENSE.txt "$app_dir/Contents/Resources/sing-box-LICENSE.txt"
cp Resources/core-version.txt "$app_dir/Contents/Resources/core-version.txt"
xcrun swift -module-cache-path "$build_dir/module-cache" scripts/make-icon.swift "$build_dir/Relay.iconset"
iconutil -c icns "$build_dir/Relay.iconset" -o "$app_dir/Contents/Resources/Relay.icns"
chmod 755 "$app_dir/Contents/MacOS/RelayEnterprise" "$app_dir/Contents/Resources/sing-box" "$app_dir/Contents/Resources/core-watchdog.sh"
codesign --force --sign - --identifier com.ritfit.relay.core "$app_dir/Contents/Resources/sing-box"
codesign --force --sign - "$app_dir"
codesign --verify --deep --strict "$app_dir"
plutil -lint "$app_dir/Contents/Info.plist"
stage="$build_dir/dmg-stage"
mkdir -p "$stage"
rm -rf "$stage/Relay Enterprise.app"
cp -R "$app_dir" "$stage/Relay Enterprise.app"
cp Resources/安装与测试.txt "$stage/安装与测试.txt"
if [ ! -L "$stage/Applications" ]; then ln -s /Applications "$stage/Applications"; fi
hdiutil create -volname "Relay Enterprise" -srcfolder "$stage" -ov -format UDZO "$project_root/dist/Relay-Enterprise-$app_version-macOS-arm64.dmg"
shasum -a 256 "$project_root/dist/Relay-Enterprise-$app_version-macOS-arm64.dmg" > "$project_root/dist/SHA256SUMS.txt"
