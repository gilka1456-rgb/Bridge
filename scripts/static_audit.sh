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
grep -q "Command Line Tools" scripts/preflight.sh || fail "preflight must explain Command Line Tools vs full Xcode"
grep -q "sudo xcode-select -s /Applications/Xcode.app/Contents/Developer" scripts/preflight.sh || fail "preflight must show the shortest Xcode select command"
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
grep -q "hasValidTransform" Bridge/Models/AvatarPose.swift || fail "avatar joints must guard invalid transform arrays"
grep -q "hasValidTransform" Bridge/Models/Placement.swift || fail "placement anchors must expose transform validation"
grep -q "hasValidMaskData" Bridge/Models/OrientationMask.swift || fail "orientation masks must expose validation"
grep -q "decodedRunTotal" Bridge/Services/PersonMaskRLE.swift || fail "mask RLE must expose decoded run totals"
grep -q "routeInitialEmptyStateIfNeeded" Bridge/Views/MainTabView.swift || fail "app must route empty first-run state to scan"
grep -q "首次启动且无虚像/放置" Bridge/Views/MainTabView.swift || fail "empty first-run routing must be recorded in diagnostics"
grep -q "case records" Bridge/Views/MainTabView.swift || fail "main tabs must include Records"
grep -q "Label(\"记录\"" Bridge/Views/MainTabView.swift || fail "main tabs must expose Records tab"
grep -q "Label(\"我的\"" Bridge/Views/MainTabView.swift || fail "main tabs must expose My tab"
if grep -q "Label(\"扫描\"" Bridge/Views/MainTabView.swift; then
  fail "Scan must be an internal Avatars flow, not a standalone main tab"
fi
grep -q "openScanOnAvatarsAppear" Bridge/Views/MainTabView.swift || fail "empty first-run routing must open Scan inside Avatars"
grep -q "navigationDestination(isPresented: scanPresentation)" Bridge/Views/AvatarsListView.swift || fail "Avatars must launch the Scan flow internally"
grep -q "scanPresentation" Bridge/Views/AvatarsListView.swift || fail "Avatars scan flow must intercept unsaved navigation dismissal"
grep -q "扫描尚未保存" Bridge/Views/AvatarsListView.swift || fail "Avatars scan flow must confirm before discarding unsaved scans"
grep -q "discardGeneration += 1" Bridge/Views/AvatarsListView.swift || fail "Avatars scan discard must reset the scan session"
grep -q "DiagnosticsView" Bridge/Views/MainTabView.swift || fail "Diagnostics must remain reachable from My"
grep -q "已保存虚像.*capturedOrientations.count" Bridge/Views/ScanARView.swift || fail "scan save diagnostics must include segmentation mask count"
grep -q "validMaskCount.*hasValidMaskData" Bridge/Views/ScanARView.swift || fail "scan save diagnostics must count valid segmentation masks"
grep -q "invalidMasks.*capturedOrientations.filter" Bridge/Views/ScanARView.swift || fail "scan save diagnostics must include invalid segmentation mask count"
grep -q "validMaskCount >= 2.*visualHullCandidate" Bridge/Views/ScanARView.swift || fail "scan save diagnostics must match VisualHull valid-mask threshold"
grep -q "hull=.*hullState" Bridge/Views/ScanARView.swift || fail "scan save diagnostics must report visual hull candidate versus fallback state"
grep -q "maskStates" Bridge/Views/ScanARView.swift || fail "scan save diagnostics must include segmentation mask validation states"
grep -q "persistWorldMap" Bridge/Views/PlaceARView.swift || fail "placement save must persist ARWorldMap"
grep -q "ensureSelectedAvatar" Bridge/Views/PlaceARView.swift || fail "place view must preserve valid selected avatar across appearances"
grep -q "请先在「虚像」中扫描创建一个虚像" Bridge/Views/PlaceARView.swift || fail "place empty state must match five-tab navigation"
grep -q "已保存放置.*mappingStatusName.*locationSummary" Bridge/Views/PlaceARView.swift || fail "placement save diagnostics must include mapping and location context"
grep -q "Place 定位/罗盘摘要" Bridge/Views/PlaceARView.swift || fail "placement save diagnostics must include location/heading provider summary"
grep -q "diagnosticsSummary" Bridge/Views/PlaceARView.swift || fail "location/heading provider must expose diagnostics summary"
grep -q "clearLocationAndHeadingCache" Bridge/Views/PlaceARView.swift || fail "location provider must clear stale GPS/heading when authorization or services are unavailable"
grep -q "定位更新失败，已清空旧 GPS/heading 缓存" Bridge/Views/PlaceARView.swift || fail "location provider must clear stale GPS/heading when location updates fail"
grep -q "clearHeadingCache" Bridge/Views/PlaceARView.swift || fail "location provider must clear stale heading when heading is unavailable"
grep -q "PersistedWorldMapInfo" Bridge/Services/AnchorPersistence.swift || fail "world map persistence must expose saved map diagnostics"
grep -q "invalidWorldMapFilename" Bridge/Services/AnchorPersistence.swift || fail "world map persistence must reject invalid filenames"
grep -q "isValidWorldMapFilename" Bridge/Services/AnchorPersistence.swift || fail "world map persistence must validate local world map filenames"
grep -q "URL(fileURLWithPath: filename).lastPathComponent" Bridge/Services/AnchorPersistence.swift || fail "world map filename validation must reject path components"
grep -q "已保存放置.*anchorCount.*fileSizeBytes" Bridge/Views/PlaceARView.swift || fail "placement save diagnostics must include world map anchor count and size"
grep -q "previewAnchorInCurrentFrame" Bridge/Views/PlaceARView.swift || fail "place save must wait until preview anchor appears in ARFrame"
grep -q "预览锚点已进入当前 ARFrame" Bridge/Views/PlaceARView.swift || fail "place diagnostics must report preview anchor frame readiness"
grep -q "保存放置失败：预览锚点尚未进入当前 ARFrame" Bridge/Views/PlaceARView.swift || fail "place save must reject preview anchors not yet in the current ARFrame"
grep -q "previewRevision" Bridge/Views/PlaceARView.swift || fail "place save must detect preview changes while world map save is pending"
grep -q "保存放置取消：预览锚点已变化" Bridge/Views/PlaceARView.swift || fail "place save must cancel stale async world map saves"
grep -q "保存放置已在进行中，忽略重复保存请求" Bridge/Views/PlaceARView.swift || fail "place save must ignore duplicate save requests while saving"
grep -q "diagnosticDescription" Bridge/Services/AnchorPersistence.swift || fail "world map delete results must expose diagnostic descriptions"
grep -q "initialWorldMap" Bridge/Views/DiscoverARView.swift || fail "discover must use initialWorldMap for relocalization"
grep -q "placement.anchor.anchorIdentifier" Bridge/Views/DiscoverARView.swift || fail "discover must render only ARKit-restored placement anchors"
grep -q "WorldMap 候选队列" Bridge/Views/DiscoverARView.swift || fail "discover diagnostics must include world map candidate queue size"
grep -q "WorldMap 距离摘要" Bridge/Views/DiscoverARView.swift || fail "discover diagnostics must include world map distance summary"
grep -q "Discover 定位/罗盘摘要" Bridge/Views/DiscoverARView.swift || fail "discover diagnostics must include location/heading provider summary"
grep -q "跳过无效 WorldMap 文件名" Bridge/Views/DiscoverARView.swift || fail "discover diagnostics must distinguish invalid world map filenames from missing files"
grep -q "worldMapAttemptStatus" Bridge/Views/DiscoverARView.swift || fail "discover HUD must show world map attempt progress"
grep -q "relocalizationSessionStatus" Bridge/Views/DiscoverARView.swift || fail "discover HUD must show tracking/mapping/relocalizing state"
grep -q "开始尝试 WorldMap.*attemptNumber" Bridge/Views/DiscoverARView.swift || fail "discover diagnostics must include world map attempt numbers"
grep -q "Discover tracking" Bridge/Views/DiscoverARView.swift || fail "discover view must report tracking state diagnostics"
grep -q "恢复锚点摘要" Bridge/Views/DiscoverARView.swift || fail "discover diagnostics must include restored anchor summaries"
grep -q "缺失 .*anchorSummary" Bridge/Views/DiscoverARView.swift || fail "discover diagnostics must include missing restored anchor identifiers"
grep -q "restoredAnchorsByID" Bridge/Views/DiscoverARView.swift || fail "discover must cache restored anchors that arrive before tracking is renderable"
grep -q "缓存恢复锚点" Bridge/Views/DiscoverARView.swift || fail "discover diagnostics must report cached restored anchor counts"
grep -q "lastCachedRestoredAnchorCount" Bridge/Views/DiscoverARView.swift || fail "discover cached-anchor diagnostics must be deduplicated"
grep -q "handleAnchorsRemoved" Bridge/Views/DiscoverARView.swift || fail "discover must handle ARKit removing restored anchors"
grep -q "恢复锚点被移除" Bridge/Views/DiscoverARView.swift || fail "discover diagnostics must report removed restored anchors"
grep -q "已清除被移除锚点对应的看见页渲染状态" Bridge/Views/DiscoverARView.swift || fail "discover must clear stale rendered state when restored anchors are removed"
grep -q "expectedAnchorIdentifiers" Bridge/Views/DiscoverARView.swift || fail "discover must validate world maps contain expected placement anchors"
grep -q "跳过 WorldMap：缺少预期放置锚点" Bridge/Views/DiscoverARView.swift || fail "discover diagnostics must report world maps missing expected anchors"
grep -q "worldMapTimeoutMessage" Bridge/Views/DiscoverARView.swift || fail "discover timeout diagnostics must include tracking/mapping/anchor context"
grep -q "observedRelocalizing" Bridge/Views/DiscoverARView.swift || fail "discover timeout diagnostics must report relocalizing state"
grep -q "entity(at:" Bridge/Views/DiscoverARView.swift || fail "discover must support entity hit testing"
grep -q "点击未命中虚像实体" Bridge/Views/DiscoverARView.swift || fail "discover hit testing must report missed taps"
grep -q "点击命中过期放置" Bridge/Views/DiscoverARView.swift || fail "discover hit testing must report stale placement hits"
grep -q "点击命中放置.*worldMap=.*message=" Bridge/Views/DiscoverARView.swift || fail "discover hit diagnostics must include world map and message preview"
grep -q "看见留存成功.*worldMap=.*rendered=" Bridge/Views/DiscoverARView.swift || fail "discover snapshot diagnostics must record successful capture context"
grep -q "看见留存失败.*ARView snapshot 为空" Bridge/Views/DiscoverARView.swift || fail "discover snapshot diagnostics must record failed captures"
grep -q "handleLocalPlacementDataChanged" Bridge/Views/DiscoverARView.swift || fail "discover must clear rendered state when local placement/avatar data changes"
grep -q "本地放置数据变化，已清除看见页 stale 状态" Bridge/Views/DiscoverARView.swift || fail "discover diagnostics must report stale local data cleanup"
grep -q "bridge_diagnostics_events.json" Bridge/Services/BridgeDiagnostics.swift || fail "diagnostic events must persist across app restart"
grep -q "maxPersistedEvents = 200" Bridge/Services/BridgeDiagnostics.swift || fail "diagnostic events must retain enough history for full iPhone MVP tests"
grep -q "AnchorPersistence.loadWorldMap" Bridge/Services/BridgeDiagnostics.swift || fail "diagnostics must decode world maps for anchor count"
grep -q "AnchorPersistence.isValidWorldMapFilename" Bridge/Services/BridgeDiagnostics.swift || fail "diagnostics must validate world map filenames before file access"
grep -q "filename invalid" Bridge/Services/BridgeDiagnostics.swift || fail "diagnostic report must include invalid world map filename state"
grep -q "文件名无效，重定位一定会失败" Bridge/Views/DiagnosticsView.swift || fail "diagnostics view must show invalid world map filenames"
grep -q "decodeError" Bridge/Services/BridgeDiagnostics.swift || fail "diagnostics must report world map decode errors"
grep -q "invalidTransforms" Bridge/Services/BridgeDiagnostics.swift || fail "diagnostic report must include invalid joint transform counts"
grep -q "transformState" Bridge/Services/BridgeDiagnostics.swift || fail "diagnostic report must include placement transform state"
grep -q "invalid(.*placement.anchor.transform.count" Bridge/Services/BridgeDiagnostics.swift || fail "diagnostic report must include invalid placement transform count"
grep -q "invalidMasks" Bridge/Services/BridgeDiagnostics.swift || fail "diagnostic report must include invalid mask counts"
grep -q "maskStates" Bridge/Services/BridgeDiagnostics.swift || fail "diagnostic report must include mask validation states"
grep -q "lastLoadSummary" Bridge/Services/LocalStore.swift || fail "local store must expose load failure warnings"
grep -q "appendLoadWarning" Bridge/Services/LocalStore.swift || fail "local store must accumulate load failure warnings"
grep -q 'label: "评论"' Bridge/Services/LocalStore.swift || fail "local store must label comment JSON load warnings"
grep -q "数据加载失败" Bridge/Services/LocalStore.swift || fail "local store must report JSON load failures"
grep -q "Last load warning" Bridge/Services/BridgeDiagnostics.swift || fail "diagnostic report must include local load warnings"
grep -q "Avatars" Bridge/Services/BridgeDiagnostics.swift || fail "diagnostic report must include avatar scan quality details"
grep -q "masks:" Bridge/Services/BridgeDiagnostics.swift || fail "diagnostic report must include avatar mask count"
grep -q "anchorIdentifier:" Bridge/Services/BridgeDiagnostics.swift || fail "diagnostic report must include placement anchor identifiers"
grep -q "虚像数据" Bridge/Views/DiagnosticsView.swift || fail "diagnostics view must show avatar scan quality details"
grep -q "anchor .*anchorIdentifier" Bridge/Views/DiagnosticsView.swift || fail "diagnostics view must show placement anchor identifiers"
grep -q "placement.anchor.latitude" Bridge/Views/DiagnosticsView.swift || fail "diagnostics view must show placement location context"
grep -q "store.lastLoadSummary" Bridge/Views/DiagnosticsView.swift || fail "diagnostics view must show local load warnings"
grep -q "坏 transform" Bridge/Views/DiagnosticsView.swift || fail "diagnostics view must show invalid transform counts"
grep -q "坏 mask" Bridge/Views/DiagnosticsView.swift || fail "diagnostics view must show invalid mask counts"
grep -q "Self.preview(placement.message)" Bridge/Views/DiagnosticsView.swift || fail "diagnostics view must show placement message preview"
grep -q "purgeInvalidPlacements" Bridge/Services/LocalStore.swift || fail "local store must support invalid placement cleanup"
grep -q "坏 transform" Bridge/Services/LocalStore.swift || fail "invalid placement cleanup must count bad transforms"
grep -q "WorldMap 文件名无效" Bridge/Services/LocalStore.swift || fail "invalid placement cleanup must count invalid world map filenames separately"
grep -q "worldMapSummary" Bridge/Services/LocalStore.swift || fail "invalid placement cleanup must preserve world map cleanup results"
grep -q "仍被引用" Bridge/Services/LocalStore.swift || fail "world map cleanup diagnostics must report still-referenced maps"
grep -q "无需清理" Bridge/Services/LocalStore.swift || fail "world map cleanup diagnostics must refresh no-op summaries"
grep -q "purgeOrphanedEngagement" Bridge/Services/LocalStore.swift || fail "local store must purge orphaned comments after placement cleanup"
grep -q "orphanedCommentIDs" Bridge/Services/LocalStore.swift || fail "local store must purge orphaned reply trees after restart"
grep -q "parent.placementID == comment.placementID" Bridge/Services/LocalStore.swift || fail "orphaned reply cleanup must reject cross-placement parent links"
grep -q "parent.parentID == nil" Bridge/Services/LocalStore.swift || fail "local store must keep comments to a visible two-level thread model"
grep -q "toRemove.contains(parentID)" Bridge/Services/LocalStore.swift || fail "comment deletion must recursively remove stale nested descendants"
grep -q "LocalStoreConsistencyError" Bridge/Services/LocalStore.swift || fail "local store must reject stale placement/comment engagement writes"
grep -q "commentHasExistingPlacement" Bridge/Services/LocalStore.swift || fail "comment reactions/likes must reject orphaned comments"
grep -q "func setCommentReaction(commentID: UUID, kind: ReactionKind) -> Bool" Bridge/Services/LocalStore.swift || fail "comment reaction writes must report stale comment failures"
grep -q "func toggleCommentLike(commentID: UUID) -> Bool" Bridge/Services/LocalStore.swift || fail "comment like writes must report stale comment failures"
grep -q "placementExists" Bridge/Views/Components/CommentThreadView.swift || fail "comment thread must detect stale/missing placements"
grep -q "activeThreadContent" Bridge/Views/Components/CommentThreadView.swift || fail "comment thread must hide stale comments for missing placements"
grep -q "评论失败" Bridge/Views/Components/CommentThreadView.swift || fail "comment thread must surface stale comment write failures"
grep -q "评论反应失败" Bridge/Views/Components/CommentThreadView.swift || fail "comment thread must surface stale reaction write failures"
grep -q "评论点赞失败" Bridge/Views/Components/CommentThreadView.swift || fail "comment thread must surface stale like write failures"
grep -q "scope: \"Comments\"" Bridge/Views/Components/CommentThreadView.swift || fail "comment actions must be recorded in diagnostics"
grep -q "放置已删除" Bridge/Views/PlacementDetailView.swift || fail "placement detail must not render stale deleted placement data"
grep -q "删除放置" Bridge/Views/MyPlacementsView.swift || fail "placement deletion must be recorded in diagnostics"
grep -q "删除虚像" Bridge/Views/AvatarsListView.swift || fail "avatar list deletion must be recorded in diagnostics"
grep -q "删除虚像" Bridge/Views/AvatarDetailView.swift || fail "avatar detail deletion must be recorded in diagnostics"
grep -q "ARSession 被中断，已清除扫描缓存" Bridge/Views/ScanARView.swift || fail "scan view must clear stale body/frame data after AR interruption"
grep -q "ARSession 失败，已清除扫描缓存" Bridge/Views/ScanARView.swift || fail "scan view must clear stale body/frame data after AR session failure"
grep -q "离开扫描页，已清除实时人体缓存" Bridge/Views/ScanARView.swift || fail "scan view must clear live body/frame cache when leaving"
grep -q "Scan tracking" Bridge/Views/ScanARView.swift || fail "scan view must report tracking state diagnostics"
grep -q "Body Tracking 超时未检测到人体" Bridge/Views/ScanARView.swift || fail "scan view must report body detection timeouts"
grep -q "Body Tracking 已检测到人体 anchor" Bridge/Views/ScanARView.swift || fail "scan view must report first body anchor detection"
grep -q "ARSession 被中断，已清除放置预览" Bridge/Views/PlaceARView.swift || fail "place view must clear stale preview anchors after AR interruption"
grep -q "ARSession 失败，已清除放置预览" Bridge/Views/PlaceARView.swift || fail "place view must clear stale preview anchors after AR session failure"
grep -q "离开放置页，已清除未保存放置预览" Bridge/Views/PlaceARView.swift || fail "place view must clear unsaved preview anchors when leaving"
grep -q "Place tracking" Bridge/Views/PlaceARView.swift || fail "place view must report tracking state diagnostics"
grep -q "保存放置失败：缺少预览锚点" Bridge/Views/PlaceARView.swift || fail "place save must reject missing preview anchors with diagnostics"
grep -q "保存放置失败：mapping=.*WorldMap 尚不可保存" Bridge/Views/PlaceARView.swift || fail "place save must reject weak mapping with diagnostics"
grep -q "保存放置失败：选中的虚像已删除" Bridge/Views/PlaceARView.swift || fail "place view must reject saving placements for deleted avatars"
grep -q "ARSession 被中断，已清除看见页渲染状态" Bridge/Views/DiscoverARView.swift || fail "discover view must clear stale rendered anchors after AR interruption"
grep -q "ARSession 失败，已清除看见页重定位状态" Bridge/Views/DiscoverARView.swift || fail "discover view must clear stale relocalization state after AR session failure"
grep -q "离开看见页，已清除重定位与渲染状态" Bridge/Views/DiscoverARView.swift || fail "discover view must clear stale relocalization state when leaving"
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
grep -q "ARSession failure" docs/iphone_mvp_test_plan.md || fail "iPhone MVP test plan must cover AR session failure cleanup"
grep -q "Diagnostic persistence" docs/iphone_mvp_test_plan.md || fail "iPhone MVP test plan must cover diagnostic persistence"
grep -q "Invalid placement cleanup" docs/iphone_mvp_test_plan.md || fail "iPhone MVP test plan must cover invalid placement cleanup"
grep -q "still-referenced counts" docs/iphone_mvp_test_plan.md || fail "iPhone MVP test plan must cover current world map cleanup summaries"
grep -q "invalid transform" docs/iphone_mvp_test_plan.md || fail "iPhone MVP test plan must cover invalid transform diagnostics"
grep -q "mask validity state" docs/iphone_mvp_test_plan.md || fail "iPhone MVP test plan must cover mask validation diagnostics"
grep -q "local JSON load warning" docs/iphone_mvp_test_plan.md || fail "iPhone MVP test plan must cover local JSON load warnings"
grep -q "Body Tracking timeout" docs/iphone_mvp_test_plan.md || fail "iPhone MVP test plan must cover body detection timeout evidence"
grep -q "Scan flow inside" docs/iphone_mvp_test_plan.md || fail "iPhone MVP test plan must require empty first-run scan route"
grep -q "tracking/mapping/relocalizing" docs/iphone_mvp_test_plan.md || fail "iPhone MVP test plan must require visible relocalization session state"
grep -q "git_revision" scripts/collect_diagnostics.sh || fail "diagnostics bundle must include git revision evidence"
grep -q "git_diff_check" scripts/collect_diagnostics.sh || fail "diagnostics bundle must include git diff whitespace checks"
grep -q "preflight.txt for Mac/Xcode readiness" scripts/collect_diagnostics.sh || fail "diagnostics README must explain preflight evidence"
grep -q "git_revision.txt" docs/iphone_device_setup.md || fail "device setup docs must explain git revision evidence"
pass "handoff docs match current MVP validation state"

echo
echo "Static audit passed."
