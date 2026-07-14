#!/usr/bin/env bash
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

timestamp="$(date +"%Y%m%d-%H%M%S")"
out_dir="diagnostics/bridge-$timestamp"
mkdir -p "$out_dir"

run_and_capture() {
  local name="$1"
  shift
  {
    echo "== $name =="
    echo "command: $*"
    echo
    "$@"
    local status=$?
    echo
    echo "exit_status: $status"
    return "$status"
  } > "$out_dir/$name.txt" 2>&1
}

run_shell_and_capture() {
  local name="$1"
  local command="$2"
  {
    echo "== $name =="
    echo "command: $command"
    echo
    bash -lc "$command"
    local status=$?
    echo
    echo "exit_status: $status"
    return "$status"
  } > "$out_dir/$name.txt" 2>&1
}

echo "Collecting Bridge diagnostics into $out_dir"

run_and_capture git_status git status --short --branch || true
run_and_capture git_log git log --oneline -10 || true
run_and_capture git_remote git remote -v || true
run_and_capture static_audit ./scripts/static_audit.sh || true
run_and_capture preflight ./scripts/preflight.sh || true
run_shell_and_capture xcode "xcode-select -p; xcodebuild -version; xcrun --sdk iphoneos --show-sdk-path" || true
run_shell_and_capture xcode_project "xcodebuild -list -project Bridge.xcodeproj" || true
run_shell_and_capture ios_unsigned_build "xcodebuild -project Bridge.xcodeproj -scheme Bridge -destination 'generic/platform=iOS' CODE_SIGNING_ALLOWED=NO build" || true
run_shell_and_capture web_build "npm --prefix core/web run build" || true

if command -v gh >/dev/null 2>&1; then
  run_shell_and_capture github_runs "gh run list --limit 5 --json databaseId,headSha,status,conclusion,name,createdAt,url" || true
else
  echo "gh is not installed" > "$out_dir/github_runs.txt"
fi

cat > "$out_dir/README.txt" <<'EOF'
Bridge diagnostics bundle.

Attach this directory or a zip of it when reporting a failed iPhone MVP test.

Also include:
- iPhone screen recording
- Xcode console excerpt during the failure
- Test case ID from docs/iphone_mvp_test_plan.md
- Physical location, lighting, and distance from original placement
- Whether Discover showed relocalized before an avatar appeared
EOF

echo
echo "Diagnostics written to $out_dir"
echo "To share:"
echo "  zip -r $out_dir.zip $out_dir"
