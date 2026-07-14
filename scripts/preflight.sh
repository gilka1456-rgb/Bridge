#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "== Bridge preflight =="
echo "repo: $ROOT_DIR"

echo
echo "== Git status =="
git status --short --branch

echo
./scripts/static_audit.sh

echo
echo "== Xcode =="
if ! xcode_path="$(xcode-select -p 2>/dev/null)"; then
  echo "xcode-select is not configured"
  exit 1
fi
echo "xcode-select: $xcode_path"

if ! xcodebuild -version; then
  echo
  echo "Full Xcode is required. Install Xcode 15+ and run:"
  echo "  sudo xcode-select -s /Applications/Xcode.app/Contents/Developer"
  exit 1
fi

echo
echo "== iPhoneOS SDK =="
xcrun --sdk iphoneos --show-sdk-path

echo
echo "== Xcode project =="
xcodebuild -list -project Bridge.xcodeproj

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
