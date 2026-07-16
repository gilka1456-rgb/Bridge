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

echo
echo "== Git status =="
git status --short --branch

echo
./scripts/static_audit.sh

echo
echo "== Xcode =="
if ! xcode_path="$(xcode-select -p 2>/dev/null)"; then
  fail_xcode_setup "xcode-select is not configured."
fi
echo "xcode-select: $xcode_path"

if [[ "$xcode_path" == *"/CommandLineTools"* ]]; then
  fail_xcode_setup "xcode-select points to Command Line Tools: $xcode_path"
fi

if ! xcodebuild -version; then
  fail_xcode_setup "xcodebuild is unavailable or Xcode setup is incomplete."
fi

echo
echo "== iPhoneOS SDK =="
if ! xcrun --sdk iphoneos --show-sdk-path; then
  fail_xcode_setup "iPhoneOS SDK is unavailable."
fi

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
