#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

failures=0

fail() {
  echo "FAIL: $*"
  failures=$((failures + 1))
}

pass() {
  echo "PASS: $*"
}

echo "== Bridge device preflight =="
echo "repo: $ROOT_DIR"

echo
echo "== Git status =="
git status --short --branch

echo
echo "== Code signing identities =="
signing_output="$(security find-identity -v -p codesigning 2>&1 || true)"
echo "$signing_output"
if grep -Eq 'Apple (Development|Distribution)|iPhone Developer|iOS Development' <<<"$signing_output"; then
  pass "Apple code signing identity is available"
else
  fail "No Apple Development code signing identity found. Add an Apple ID in Xcode > Settings > Accounts, then select a Team for the Bridge target."
fi

echo
echo "== Xcode signing settings =="
pbx="Bridge.xcodeproj/project.pbxproj"
team_values="$(grep -E 'DEVELOPMENT_TEAM = ' "$pbx" | sed -E 's/.*DEVELOPMENT_TEAM = "?([^";]*)"?;.*/\1/' | sort -u)"
bundle_values="$(grep -E 'PRODUCT_BUNDLE_IDENTIFIER = ' "$pbx" | sed -E 's/.*PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);.*/\1/' | sort -u)"
echo "DEVELOPMENT_TEAM:"
echo "$team_values"
echo "PRODUCT_BUNDLE_IDENTIFIER:"
echo "$bundle_values"
if grep -q 'DEVELOPMENT_TEAM = "";' "$pbx"; then
  fail "DEVELOPMENT_TEAM is empty. In Xcode, open TARGETS > Bridge > Signing & Capabilities and select a Team."
else
  pass "DEVELOPMENT_TEAM is set"
fi

if grep -q 'PRODUCT_BUNDLE_IDENTIFIER = com.bridge.app;' "$pbx"; then
  echo "WARN: PRODUCT_BUNDLE_IDENTIFIER is still com.bridge.app. If signing reports a conflict, change it to a unique value such as com.<name>.bridge."
fi

echo
echo "== Devices =="
devices_output="$(xcrun xctrace list devices 2>&1 || true)"
echo "$devices_output"
if grep -Eq 'iPhone|iPad' <<<"$devices_output" && ! grep -Eq 'Simulator' <<<"$(grep -E 'iPhone|iPad' <<<"$devices_output" | head -1)"; then
  pass "A physical iOS/iPadOS device appears in xctrace"
else
  fail "No physical iPhone/iPad appears in xctrace. Connect the iPhone, unlock it, tap Trust This Computer, and enable Developer Mode if prompted."
fi

echo
echo "== Destinations =="
xcodebuild -showdestinations -project Bridge.xcodeproj -scheme Bridge

echo
if (( failures == 0 )); then
  echo "Device preflight passed. You can now build/run Bridge to the selected iPhone from Xcode."
else
  echo "Device preflight failed with $failures issue(s). Fix the items above before trying Cmd+R."
  exit 1
fi
