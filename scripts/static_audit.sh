#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

pass() {
  echo "PASS: $*"
}

echo "== Bridge static audit =="

[[ -f Bridge.xcodeproj/project.pbxproj ]] || fail "Bridge.xcodeproj/project.pbxproj is missing"
[[ -f Bridge/Info.plist ]] || fail "Bridge/Info.plist is missing"
[[ -f core/web/package.json ]] || fail "core/web/package.json is missing"
pass "required project files exist"

echo
echo "== Info.plist capabilities =="
python3 - <<'PY'
import plistlib
import sys

with open("Bridge/Info.plist", "rb") as handle:
    plist = plistlib.load(handle)

for key in [
    "NSCameraUsageDescription",
    "NSLocationWhenInUseUsageDescription",
    "NSMotionUsageDescription",
]:
    value = plist.get(key)
    if not value:
        print(f"FAIL: Info.plist missing {key}", file=sys.stderr)
        sys.exit(1)
    print(f"{key}: {value}")

capabilities = plist.get("UIRequiredDeviceCapabilities", [])
if "arkit" not in capabilities:
    print("FAIL: Info.plist must require arkit device capability", file=sys.stderr)
    sys.exit(1)
PY
pass "AR privacy and device capability keys are present"

echo
echo "== Xcode build settings =="
pbx="Bridge.xcodeproj/project.pbxproj"
grep -q "IPHONEOS_DEPLOYMENT_TARGET = 17.0;" "$pbx" || fail "IPHONEOS_DEPLOYMENT_TARGET must be 17.0"
grep -q "INFOPLIST_FILE = Bridge/Info.plist;" "$pbx" || fail "INFOPLIST_FILE must point to Bridge/Info.plist"
grep -q "TARGETED_DEVICE_FAMILY = 1;" "$pbx" || fail "TARGETED_DEVICE_FAMILY must target iPhone"
grep -q "CODE_SIGN_STYLE = Automatic;" "$pbx" || fail "CODE_SIGN_STYLE must be Automatic"
grep -q "DEVELOPMENT_TEAM = \"\";" "$pbx" && echo "WARN: DEVELOPMENT_TEAM is empty; set Team in Xcode before device install"
pass "core Xcode settings are present"

echo
echo "== Swift source membership =="
ruby - <<'RUBY'
pbx = File.read('Bridge.xcodeproj/project.pbxproj')
files = Dir['Bridge/**/*.swift'].sort
compile_section = pbx[/\/\* Begin PBXSourcesBuildPhase section \*\/(.*?)\/\* End PBXSourcesBuildPhase section \*\//m, 1] || ''
missing_refs = files.reject { |f| pbx.include?("path = #{File.basename(f)}") || pbx.include?("path = #{f}") }
missing_sources = files.reject { |f| compile_section.include?(File.basename(f)) }
puts "Swift files: #{files.length}"
unless missing_refs.empty? && missing_sources.empty?
  warn "Missing project refs:"
  warn missing_refs.join("\n")
  warn "Missing sources phase refs:"
  warn missing_sources.join("\n")
  exit 1
end
RUBY
pass "all Swift files are referenced by the Xcode project"

echo
echo "== Single-device MVP markers =="
grep -q "ARWorldTrackingConfiguration" Bridge/Views/PlaceARView.swift Bridge/Views/DiscoverARView.swift || fail "world tracking views are missing"
grep -q "ARBodyTrackingConfiguration" Bridge/Views/ScanARView.swift || fail "body tracking scan view is missing"
grep -q "persistWorldMap" Bridge/Views/PlaceARView.swift || fail "placement save must persist ARWorldMap"
grep -q "initialWorldMap" Bridge/Views/DiscoverARView.swift || fail "discover must use initialWorldMap for relocalization"
grep -q "entity(at:" Bridge/Views/DiscoverARView.swift || fail "discover must support entity hit testing"
grep -q "bridge_diagnostics_events.json" Bridge/Services/BridgeDiagnostics.swift || fail "diagnostic events must persist across app restart"
grep -q "purgeInvalidPlacements" Bridge/Services/LocalStore.swift || fail "local store must support invalid placement cleanup"
grep -q "ARSession 被中断，已清除扫描缓存" Bridge/Views/ScanARView.swift || fail "scan view must clear stale body/frame data after AR interruption"
grep -q "ARSession 被中断，已清除放置预览" Bridge/Views/PlaceARView.swift || fail "place view must clear stale preview anchors after AR interruption"
pass "single-device AR MVP markers are present"

echo
echo "== CloudKit boundary =="
if grep -q "CloudKitSyncService" Bridge/Services/CloudSyncService.swift; then
  echo "WARN: CloudKit service is present but still a skeleton; do not treat cross-device sync as complete"
fi

echo
echo "== Handoff docs =="
grep -q "33 个 Swift 文件" README.md || fail "README must reflect current Swift file count"
if grep -q "heading(罗盘朝向)尚未完全接入" README.md; then
  fail "README contains stale heading status"
fi
grep -q "AR interruption" docs/iphone_mvp_test_plan.md || fail "iPhone MVP test plan must cover AR session interruption"
grep -q "Diagnostic persistence" docs/iphone_mvp_test_plan.md || fail "iPhone MVP test plan must cover diagnostic persistence"
grep -q "Invalid placement cleanup" docs/iphone_mvp_test_plan.md || fail "iPhone MVP test plan must cover invalid placement cleanup"
pass "handoff docs match current MVP validation state"

echo
echo "Static audit passed."
