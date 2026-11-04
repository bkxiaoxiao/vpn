#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
mkdir -p build/module-cache
xcrun swiftc -swift-version 5 -target arm64-apple-macosx13.0 -module-cache-path build/module-cache Sources/EnterpriseAPI.swift Sources/BrowserLogin.swift Tests/BrowserLoginTests.swift -o build/browser-login-tests -framework CryptoKit
build/browser-login-tests
