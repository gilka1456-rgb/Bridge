#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "== Bridge preflight =="
echo "repo: $ROOT_DIR"

print_xcode_install_help() {
  echo "Detected Xcode install state:"
  if [[ -d /Applications/Xcode.app ]]; then
    echo "  - /Applications/Xcode.app exists."
    echo "  - Select it with: sudo xcode-select -s /Applications/Xcode.app/Contents/Developer"
    echo "  - Or run this preflight without global selection:"
    echo "      DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer ./scripts/preflight.sh"
  else
    echo "  - /Applications/Xcode.app is missing."
  fi

  if command -v mas >/dev/null 2>&1; then
    echo "  - mas is installed. App Store path:"
    echo "      open 'macappstore://apps.apple.com/app/xcode/id497799835?mt=12'"
    echo "      mas install 497799835"
    echo "    Note: App Store install may still require an Apple ID or administrator password in the macOS UI."
  else
    echo "  - mas is not installed. Optional CLI install: brew install mas"
  fi

  if command -v xcodes >/dev/null 2>&1; then
    echo "  - xcodes is installed. Apple Developer download path:"
    echo "      xcodes install 26.3 --directory /Applications --select"
    echo "    Note: xcodes requires Apple Developer authentication and may not work without an interactive login."
  else
    echo "  - xcodes is not installed. Optional CLI install: brew install xcodes"
  fi
}

fail_xcode_setup() {
  local detail="${1:-Full Xcode is not selected.}"
  echo
  echo "FAIL: $detail"
  echo
  echo "Bridge iPhone testing requires full Xcode, not only Command Line Tools."
  print_xcode_install_help
  echo
  echo "Shortest fix:"
  echo "  1. Install Xcode 15+ from the Mac App Store or Apple Developer downloads."
  echo "  2. Run: sudo xcode-select -s /Applications/Xcode.app/Contents/Developer"
  echo "  3. Run: sudo xcodebuild -license accept"
  echo "  4. Re-run: ./scripts/preflight.sh"
  exit 1
}

fail_xcode_license() {
  echo
  echo "FAIL: Xcode license has not been accepted."
  echo
  echo "Accept the license locally on this Mac, then re-run preflight:"
  echo "  sudo xcodebuild -license accept"
  echo "  ./scripts/preflight.sh"
  echo
  echo "If Terminal asks for a password, enter the Mac administrator password locally. Do not paste Apple ID or Mac passwords into Codex chat."
  exit 1
}

echo
echo "== Git status =="
git status --short --branch

echo
./scripts/static_audit.sh

echo
echo "== Xcode =="
selected_xcode_path=""
if ! xcode_path="$(xcode-select -p 2>/dev/null)"; then
  fail_xcode_setup "xcode-select is not configured."
fi
echo "xcode-select: $xcode_path"

if [[ -n "${DEVELOPER_DIR:-}" ]]; then
  selected_xcode_path="$DEVELOPER_DIR"
  echo "DEVELOPER_DIR: $selected_xcode_path"
elif [[ "$xcode_path" == *"/CommandLineTools"* && -d /Applications/Xcode.app/Contents/Developer ]]; then
  export DEVELOPER_DIR="/Applications/Xcode.app/Contents/Developer"
  selected_xcode_path="$DEVELOPER_DIR"
  echo "DEVELOPER_DIR: $selected_xcode_path (auto-selected because xcode-select points to Command Line Tools)"
elif [[ "$xcode_path" == *"/CommandLineTools"* ]]; then
  fail_xcode_setup "xcode-select points to Command Line Tools: $xcode_path"
else
  selected_xcode_path="$xcode_path"
fi

if [[ "$selected_xcode_path" == *"/CommandLineTools"* || ! -d "$selected_xcode_path/Platforms/iPhoneOS.platform" ]]; then
  fail_xcode_setup "Selected developer directory is not a full Xcode with iPhoneOS platform: $selected_xcode_path"
fi

if ! xcodebuild_output="$(xcodebuild -version 2>&1)"; then
  echo "$xcodebuild_output"
  if [[ "$xcodebuild_output" == *"license"* || "$xcodebuild_output" == *"License"* ]]; then
    fail_xcode_license
  fi
  fail_xcode_setup "xcodebuild is unavailable or Xcode setup is incomplete."
fi
echo "$xcodebuild_output"

echo
echo "== iPhoneOS SDK =="
if ! iphoneos_sdk_path="$(xcrun --sdk iphoneos --show-sdk-path 2>&1)"; then
  echo "$iphoneos_sdk_path"
  if [[ "$iphoneos_sdk_path" == *"license"* || "$iphoneos_sdk_path" == *"License"* ]]; then
    fail_xcode_license
  fi
  fail_xcode_setup "iPhoneOS SDK is unavailable."
fi
echo "$iphoneos_sdk_path"

echo
echo "== Xcode project =="
xcodebuild -list -project Bridge.xcodeproj

echo
echo "== iOS compile check =="
xcodebuild \
  -project Bridge.xcodeproj \
  -scheme Bridge \
  -destination 'generic/platform=iOS' \
  CODE_SIGNING_ALLOWED=NO \
  build

echo
echo "== Swift file membership =="
ruby - <<'RUBY'
pbx = File.read('Bridge.xcodeproj/project.pbxproj')
files = Dir['Bridge/**/*.swift'].sort
compile_section = pbx[/\/\* Begin PBXSourcesBuildPhase section \*\/(.*?)\/\* End PBXSourcesBuildPhase section \*\//m, 1] || ''
missing_refs = files.reject { |f| pbx.include?("path = #{File.basename(f)}") || pbx.include?("path = #{f}") }
missing_sources = files.reject { |f| compile_section.include?(File.basename(f)) }
puts "Swift files: #{files.length}"
if missing_refs.empty? && missing_sources.empty?
  puts "All Swift files are referenced by the project and sources phase."
else
  puts "Missing project refs:"
  puts missing_refs
  puts "Missing sources phase refs:"
  puts missing_sources
  exit 1
end
RUBY

echo
echo "== Web build =="
npm --prefix core/web install
npm --prefix core/web run build

echo
echo "Preflight passed."
