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

run_shell_and_capture git_revision "git branch --show-current; git rev-parse --short HEAD; git rev-parse HEAD; git rev-parse --short origin/main 2>/dev/null || true; git rev-parse origin/main 2>/dev/null || true" || true
run_and_capture git_status git status --short --branch || true
run_and_capture git_log git log --oneline -10 || true
run_and_capture git_remote git remote -v || true
run_and_capture git_diff_check git diff --check || true
run_and_capture static_audit ./scripts/static_audit.sh || true
run_and_capture preflight ./scripts/preflight.sh || true
run_shell_and_capture xcode "xcode-select -p; xcodebuild -version; xcrun --sdk iphoneos --show-sdk-path" || true
run_shell_and_capture xcode_install_state "ls -ld /Applications/Xcode.app /Applications/Xcode.appdownload /Users/chenrongrong/Applications/Xcode.app 2>/dev/null || true; du -sh /Applications/Xcode.appdownload 2>/dev/null || true; command -v mas || true; command -v xcodes || true; mas info 497799835 2>/dev/null || true; pgrep -fl 'storedownloadd|appstoreagent|App Store|installd|Xcode' || true" || true
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

Start with:
- preflight.txt for Mac/Xcode readiness
- xcode_install_state.txt for Xcode.app, Xcode.appdownload, mas, xcodes, and App Store install process state
- git_revision.txt for branch, local commit, and origin/main commit
- git_status.txt for uncommitted local changes
- git_diff_check.txt for whitespace/conflict-marker issues
- github_runs.txt for recent CI run status
- static_audit.txt for single-device MVP guardrails

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
