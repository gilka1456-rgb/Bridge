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
grep -q "orientation.hasValidMaskData" Bridge/AR/VisualHull.swift || fail "visual hull must reject invalid RLE masks before mesh generation"
grep -q "failureReason" Bridge/Services/PersonSegmentationCapture.swift || fail "person segmentation capture must expose failure reasons"
ruby - <<'RUBY' || fail "Marching Cubes tables must have 256 edge rows and valid first 256 triangle rows"
source = File.read('Bridge/AR/MarchingCubesTables.swift')
edge_section = source[/static let edgeTable: \[Int\] = \[(.*?)\n    \]/m, 1] || ''
edge_values = edge_section.scan(/0x[0-9a-f]+/i)
abort "edgeTable has #{edge_values.length} entries" unless edge_values.length == 256

tri_section = source[/static let triTable: \[\[Int\]\] = \[(.*?)\n    \]\n\n    static let cornerOffsets/m, 1] || ''
tri_rows = tri_section.lines.map do |line|
  row = line.strip
  next unless row.start_with?('[')
  row.scan(/-?\d+/).map(&:to_i)
end.compact
abort "triTable has #{tri_rows.length} rows" if tri_rows.length < 256
tri_rows.first(256).each_with_index do |row, index|
  abort "triTable[#{index}] length #{row.length} is not divisible by 3" unless (row.length % 3).zero?
  invalid = row.find { |edge| edge.negative? || edge > 11 }
  abort "triTable[#{index}] has invalid edge #{invalid}" if invalid
end
RUBY
grep -q "routeInitialEmptyStateIfNeeded" Bridge/Views/MainTabView.swift || fail "app must route empty first-run state to scan"
grep -q "首次启动且无虚像/放置" Bridge/Views/MainTabView.swift || fail "empty first-run routing must be recorded in diagnostics"
grep -q "dispatchToMain" Bridge/AR/ARViewContainer.swift || fail "ARSession delegate callbacks must be dispatched to the main thread before mutating SwiftUI state"
grep -q "DispatchQueue.main.async" Bridge/AR/ARViewContainer.swift || fail "ARSession coordinator must use the main queue for delegate callback delivery"
ruby - <<'RUBY' || fail "AR view coordinator overrides must dispatch state-mutating callbacks to the main thread"
checks = {
  'Bridge/Views/ScanARView.swift' => ['dispatchToMain { [weak self] in', 'self?.onTrackingStateChanged?'],
  'Bridge/Views/PlaceARView.swift' => ['dispatchToMain { [weak self] in', 'self?.onTrackingStateChanged?'],
  'Bridge/Views/DiscoverARView.swift' => [
    'dispatchToMain { [weak self] in',
    'self?.onTrackingStateChanged?',
    'self?.onAnchorsAdded?',
    'self?.onAnchorsRemoved?'
  ]
}
checks.each do |file, needles|
  source = File.read(file)
  missing = needles.reject { |needle| source.include?(needle) }
  abort "#{file} missing #{missing.join(', ')}" unless missing.empty?
end
RUBY
ruby - <<'RUBY' || fail "AR view callbacks must ignore late state updates after the SwiftUI view disappears"
checks = {
  'Bridge/Views/ScanARView.swift' => [
    'onFrame: handleFrame',
    'private func handleBodyAnchor',
    'private func handleFrame',
    'private func handleTrackingState'
  ],
  'Bridge/Views/PlaceARView.swift' => [
    'onMappingStatus: updateMappingStatus',
    'private func updateMappingStatus',
    'private func handleFrame',
    'private func handleTap'
  ],
  'Bridge/Views/DiscoverARView.swift' => [
    'onMappingStatus: updateMappingStatus',
    'private func updateMappingStatus',
    'private func handleAnchorsAdded',
    'private func handleAnchorsRemoved',
    'private func handleTap'
  ]
}
checks.each do |file, needles|
  source = File.read(file)
  missing = needles.reject { |needle| source.include?(needle) }
  abort "#{file} missing #{missing.join(', ')}" unless missing.empty?
  guard_count = source.scan('guard isViewActive else { return }').length
  min_guard_count = file.include?('Scan') ? 5 : 6
  abort "#{file} has only #{guard_count} active-view guards" if guard_count < min_guard_count
end
RUBY
ruby - <<'RUBY' || fail "AR views must pause and explicitly resume AR sessions across app background/foreground transitions"
checks = {
  'Bridge/Views/ScanARView.swift' => [
    '@Environment(\\.scenePhase)',
    'shouldResumeAfterSceneActivation',
    'handleScenePhaseChanged',
    'scenePhase background：App 进入后台/非活跃，已暂停扫描',
    'scenePhase foreground：App 回到前台，重启扫描 Body Tracking'
  ],
  'Bridge/Views/PlaceARView.swift' => [
    '@Environment(\\.scenePhase)',
    'shouldResumeAfterSceneActivation',
    'handleScenePhaseChanged',
    'scenePhase background：App 进入后台/非活跃，已清除未保存放置预览',
    'scenePhase foreground：App 回到前台，重启放置 World Tracking'
  ],
  'Bridge/Views/DiscoverARView.swift' => [
    '@Environment(\\.scenePhase)',
    'shouldResumeAfterSceneActivation',
    'handleScenePhaseChanged',
    'scenePhase background：App 进入后台/非活跃，已清除看见页重定位与渲染状态',
    'scenePhase foreground：App 回到前台，重新匹配 WorldMap'
  ]
}
checks.each do |file, needles|
  source = File.read(file)
  missing = needles.reject { |needle| source.include?(needle) }
  abort "#{file} missing #{missing.join(', ')}" unless missing.empty?
end
RUBY
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
grep -q "切换扫描模式，已清空未保存扫描" Bridge/Views/ScanARView.swift || fail "scan mode changes must diagnose discarded unsaved captures"
grep -q "开始保存虚像" Bridge/Views/ScanARView.swift || fail "scan save must record the save attempt before local persistence"
grep -q "已保存虚像.*capturedOrientations.count" Bridge/Views/ScanARView.swift || fail "scan save diagnostics must include segmentation mask count"
grep -q "请至少记录 2 个方位（建议正面 + 侧面或背面）" Bridge/Views/ScanARView.swift || fail "scan minimum-angle guidance must be clear"
grep -q "validMaskCount.*hasValidMaskData" Bridge/Views/ScanARView.swift || fail "scan save diagnostics must count valid segmentation masks"
grep -q "invalidMasks.*capturedOrientations.filter" Bridge/Views/ScanARView.swift || fail "scan save diagnostics must include invalid segmentation mask count"
grep -q "validMaskCount >= 2.*visualHullCandidate" Bridge/Views/ScanARView.swift || fail "scan save diagnostics must match VisualHull valid-mask threshold"
grep -q "hull=.*hullState" Bridge/Views/ScanARView.swift || fail "scan save diagnostics must report visual hull candidate versus fallback state"
grep -q "maskStates" Bridge/Views/ScanARView.swift || fail "scan save diagnostics must include segmentation mask validation states"
grep -q "segmentationFailureReason" Bridge/Views/ScanARView.swift || fail "scan diagnostics must include person segmentation failure reasons"
grep -q "cleanedLabel = poseLabel.trimmingCharacters" Bridge/Views/ScanARView.swift || fail "scan save must trim blank avatar labels before persistence"
grep -q "discardUnsavedAvatar" Bridge/Services/LocalStore.swift || fail "local store must support rolling back in-memory avatars after failed scan persistence"
grep -q "保存虚像警告：本地写入失败，已撤回内存虚像并保留扫描草稿" Bridge/Views/ScanARView.swift || fail "scan save must keep the scan draft after local persistence failures without leaving duplicate in-memory avatars"
grep -q "重拍同一方位时先清掉旧 mask" Bridge/Views/ScanARView.swift || fail "scan recapture must not keep stale orientation masks"
grep -q "capturedOrientations.removeAll.*azimuth" Bridge/Views/ScanARView.swift || fail "scan recapture must remove stale mask before saving a new angle"
grep -q "重拍方位" Bridge/Views/ScanARView.swift || fail "scan recapture must diagnose replaced views and masks"
grep -q "replacedMask" Bridge/Views/ScanARView.swift || fail "scan recapture diagnostics must include replaced mask state"
grep -q "hasUnsavedScan = !capturedViews.isEmpty || !capturedOrientations.isEmpty" Bridge/Views/ScanARView.swift || fail "scan unsaved-state guard must include captured segmentation masks"
grep -q "persistWorldMap" Bridge/Views/PlaceARView.swift || fail "placement save must persist ARWorldMap"
grep -q "ensureSelectedAvatar" Bridge/Views/PlaceARView.swift || fail "place view must preserve valid selected avatar across appearances"
grep -q "请先在「虚像」中扫描创建一个虚像" Bridge/Views/PlaceARView.swift || fail "place empty state must match five-tab navigation"
grep -q "已保存放置.*worldMapInfo.mappingStatus.*locationSummary" Bridge/Views/PlaceARView.swift || fail "placement save diagnostics must include persisted world map mapping and location context"
grep -q "Place 定位/罗盘摘要" Bridge/Views/PlaceARView.swift || fail "placement save diagnostics must include location/heading provider summary"
grep -q "diagnosticsSummary" Bridge/Views/PlaceARView.swift || fail "location/heading provider must expose diagnostics summary"
grep -q "freshLocation" Bridge/Views/PlaceARView.swift || fail "location provider must expose fresh GPS filtering"
grep -q "GPS 已过期或精度无效" Bridge/Views/PlaceARView.swift || fail "location provider must diagnose stale GPS filtering"
grep -q "clearLocationCache" Bridge/Views/PlaceARView.swift || fail "location provider must clear stale GPS without keeping old coordinates in diagnostics"
grep -q "freshHeading" Bridge/Views/PlaceARView.swift || fail "location provider must expose fresh heading filtering"
grep -q "headingAccuracy >= 0" Bridge/Views/PlaceARView.swift || fail "location provider must reject invalid heading accuracy"
grep -q "罗盘 heading 已过期" Bridge/Views/PlaceARView.swift || fail "location provider must diagnose stale heading filtering"
grep -q "locationProvider.freshHeading()" Bridge/Views/PlaceARView.swift || fail "place must not initialize heading from stale compass data"
grep -q "locationProvider.freshLocation()" Bridge/Views/DiscoverARView.swift || fail "discover must not sort world maps with stale GPS"
grep -q "locationProvider.freshLocation()" Bridge/Views/PlaceARView.swift || fail "place save must not persist stale GPS"
grep -q "clearLocationAndHeadingCache" Bridge/Views/PlaceARView.swift || fail "location provider must clear stale GPS/heading when authorization or services are unavailable"
grep -q "定位更新失败，已清空旧 GPS/heading 缓存" Bridge/Views/PlaceARView.swift || fail "location provider must clear stale GPS/heading when location updates fail"
grep -q "clearHeadingCache" Bridge/Views/PlaceARView.swift || fail "location provider must clear stale heading when heading is unavailable"
grep -q "PersistedWorldMapInfo" Bridge/Services/AnchorPersistence.swift || fail "world map persistence must expose saved map diagnostics"
grep -q "mappingStatus: String" Bridge/Services/AnchorPersistence.swift || fail "world map persistence diagnostics must return actual saved mapping status"
grep -q "worldMapUnavailable(mappingStatus: String, anchorCount: Int)" Bridge/Services/AnchorPersistence.swift || fail "world map unavailable errors must carry mapping and anchor diagnostics"
grep -q "anchorMissingFromWorldMap(anchorIdentifier: UUID, anchorCount: Int)" Bridge/Services/AnchorPersistence.swift || fail "missing anchor errors must carry expected anchor diagnostics"
grep -q "worldMapDecodeFailed(filename: String)" Bridge/Services/AnchorPersistence.swift || fail "world map decode failures must be distinguishable from save failures"
grep -q "AR 空间地图文件无法解码，重定位一定会失败" Bridge/Services/AnchorPersistence.swift || fail "world map decode failures must guide relocalization debugging"
grep -q "writeFailed(filename: String, reason: String)" Bridge/Services/AnchorPersistence.swift || fail "world map write failures must carry filename and low-level reason diagnostics"
grep -q "无法保存 AR 空间地图文件" Bridge/Services/AnchorPersistence.swift || fail "world map write failures must be distinguishable from other local persistence failures"
grep -q "mappingStatusDescription" Bridge/Services/AnchorPersistence.swift || fail "world map diagnostics must name AR mapping status"
grep -q "latestFrame = session.currentFrame" Bridge/Services/AnchorPersistence.swift || fail "world map persistence must validate mapping status against the latest frame after getCurrentWorldMap returns"
grep -q "requiringAnchor: anchor.identifier" Bridge/Services/SpatialLocalizer.swift || fail "world map localizer must save maps only after the hosted anchor is included"
grep -q "invalidWorldMapFilename" Bridge/Services/AnchorPersistence.swift || fail "world map persistence must reject invalid filenames"
grep -q "isValidWorldMapFilename" Bridge/Services/AnchorPersistence.swift || fail "world map persistence must validate local world map filenames"
grep -q "URL(fileURLWithPath: filename).lastPathComponent" Bridge/Services/AnchorPersistence.swift || fail "world map filename validation must reject path components"
grep -q "开始保存放置：previewRevision" Bridge/Views/PlaceARView.swift || fail "placement save must record pre-worldmap save context"
grep -q "已保存放置.*anchorCount.*fileSizeBytes" Bridge/Views/PlaceARView.swift || fail "placement save diagnostics must include world map anchor count and size"
grep -q "discardUnsavedPlacement" Bridge/Services/LocalStore.swift || fail "local store must support rolling back in-memory placements after failed placement persistence"
grep -q "保存放置警告：本地写入失败，已撤回内存放置并保留预览" Bridge/Views/PlaceARView.swift || fail "place save must keep the preview after local persistence failures without leaving duplicate in-memory placements"
grep -q "cleanupResult.diagnosticDescription" Bridge/Views/PlaceARView.swift || fail "place save persistence failures must clean up the newly created world map"
grep -q "previewAnchorInCurrentFrame" Bridge/Views/PlaceARView.swift || fail "place save must wait until preview anchor appears in ARFrame"
grep -q "预览锚点已进入当前 ARFrame" Bridge/Views/PlaceARView.swift || fail "place diagnostics must report preview anchor frame readiness"
grep -q "保存放置失败：预览锚点尚未进入当前 ARFrame" Bridge/Views/PlaceARView.swift || fail "place save must reject preview anchors not yet in the current ARFrame"
grep -q "previewRevision" Bridge/Views/PlaceARView.swift || fail "place save must detect preview changes while world map save is pending"
grep -q "viewGeneration" Bridge/Views/PlaceARView.swift || fail "place save must distinguish a new Place view lifecycle from an old async save"
grep -q "保存放置取消：页面已离开、已重新进入或预览锚点已变化" Bridge/Views/PlaceARView.swift || fail "place save must cancel stale async world map saves"
grep -q "保存放置取消：页面已离开或已重新进入，忽略错误提示" Bridge/Views/PlaceARView.swift || fail "place save must not surface async save errors after leaving or re-entering the page"
grep -q "保存放置取消：虚像已删除" Bridge/Views/PlaceARView.swift || fail "place save must cancel async world map saves if the avatar is deleted before placement creation"
grep -q "removePreview()" Bridge/Views/PlaceARView.swift || fail "place save cancellation paths must clear invalid preview anchors"
grep -q "保存放置已在进行中，忽略重复保存请求" Bridge/Views/PlaceARView.swift || fail "place save must ignore duplicate save requests while saving"
grep -q "diagnosticDescription" Bridge/Services/AnchorPersistence.swift || fail "world map delete results must expose diagnostic descriptions"
grep -q "initialWorldMap" Bridge/Views/DiscoverARView.swift || fail "discover must use initialWorldMap for relocalization"
grep -q "discoverStatusTitle" Bridge/Views/DiscoverARView.swift || fail "discover HUD must distinguish empty local placement state"
grep -q "看见页没有本地放置，跳过 WorldMap 重定位" Bridge/Views/DiscoverARView.swift || fail "discover must not report relocalization failure when there are no local placements"
grep -q "placement.anchor.anchorIdentifier" Bridge/Views/DiscoverARView.swift || fail "discover must render only ARKit-restored placement anchors"
grep -q "WorldMap 候选队列" Bridge/Views/DiscoverARView.swift || fail "discover diagnostics must include world map candidate queue size"
grep -q "WorldMap 距离摘要" Bridge/Views/DiscoverARView.swift || fail "discover diagnostics must include world map distance summary"
grep -q "Discover 定位/罗盘摘要" Bridge/Views/DiscoverARView.swift || fail "discover diagnostics must include location/heading provider summary"
grep -q "跳过无效 WorldMap 文件名" Bridge/Views/DiscoverARView.swift || fail "discover diagnostics must distinguish invalid world map filenames from missing files"
grep -q "worldMapAttemptStatus" Bridge/Views/DiscoverARView.swift || fail "discover HUD must show world map attempt progress"
grep -q "relocalizationSessionStatus" Bridge/Views/DiscoverARView.swift || fail "discover HUD must show tracking/mapping/relocalizing state"
ruby - <<'RUBY' || fail "discover must reset stale mapping status across relocalization cleanup paths"
source = File.read('Bridge/Views/DiscoverARView.swift')
abort "mappingStatus reset count is too low" if source.scan('mappingStatus = .notAvailable').length < 3
RUBY
grep -q "开始尝试 WorldMap：attemptNumber=.*anchors=.*expected=" Bridge/Views/DiscoverARView.swift || fail "discover diagnostics must include world map attempt numbers and anchor counts"
grep -q "切换 WorldMap 尝试" Bridge/Views/DiscoverARView.swift || fail "discover must diagnose world map attempt switching"
grep -q "session.pause()" Bridge/Views/DiscoverARView.swift || fail "discover must pause stale AR sessions when switching or leaving world map attempts"
grep -q "isViewActive" Bridge/Views/ScanARView.swift || fail "scan must gate ARSession restarts on active view lifecycle"
grep -q "isViewActive" Bridge/Views/PlaceARView.swift || fail "place must gate ARSession restarts on active view lifecycle"
grep -q "isViewActive" Bridge/Views/DiscoverARView.swift || fail "discover must gate ARSession restarts on active view lifecycle"
grep -q "扫描页已离开，忽略 ARSession 中断结束回调" Bridge/Views/ScanARView.swift || fail "scan must ignore late interruption-ended callbacks after leaving the page"
grep -q "放置页已离开，忽略 ARSession 中断结束回调" Bridge/Views/PlaceARView.swift || fail "place must ignore late interruption-ended callbacks after leaving the page"
grep -q "看见页已离开，忽略 ARSession 中断结束回调" Bridge/Views/DiscoverARView.swift || fail "discover must ignore late interruption-ended callbacks after leaving the page"
grep -q "Discover tracking" Bridge/Views/DiscoverARView.swift || fail "discover view must report tracking state diagnostics"
grep -q "恢复锚点摘要" Bridge/Views/DiscoverARView.swift || fail "discover diagnostics must include restored anchor summaries"
grep -q "缺失 .*anchorSummary" Bridge/Views/DiscoverARView.swift || fail "discover diagnostics must include missing restored anchor identifiers"
grep -q "渲染恢复锚点放置.*placements=" Bridge/Views/DiscoverARView.swift || fail "discover render diagnostics must include rendered placement identifiers"
grep -q "等待恢复锚点.*placements=" Bridge/Views/DiscoverARView.swift || fail "discover missing-anchor diagnostics must include affected placement identifiers"
grep -q "placementSummary" Bridge/Views/DiscoverARView.swift || fail "discover diagnostics must summarize placement identifiers"
grep -q "restoredAnchorsByID" Bridge/Views/DiscoverARView.swift || fail "discover must cache restored anchors that arrive before tracking is renderable"
grep -q "clearWorldMapAttemptState" Bridge/Views/DiscoverARView.swift || fail "discover must clear restored anchor cache when world map attempts fail"
grep -q "缓存恢复锚点" Bridge/Views/DiscoverARView.swift || fail "discover diagnostics must report cached restored anchor counts"
grep -q "lastCachedRestoredAnchorCount" Bridge/Views/DiscoverARView.swift || fail "discover cached-anchor diagnostics must be deduplicated"
grep -q "handleAnchorsRemoved" Bridge/Views/DiscoverARView.swift || fail "discover must handle ARKit removing restored anchors"
grep -q "恢复锚点被移除" Bridge/Views/DiscoverARView.swift || fail "discover diagnostics must report removed restored anchors"
grep -q "已清除被移除锚点对应的看见页渲染状态" Bridge/Views/DiscoverARView.swift || fail "discover must clear stale rendered state when restored anchors are removed"
grep -q "expectedAnchorIdentifiers" Bridge/Views/DiscoverARView.swift || fail "discover must validate world maps contain expected placement anchors"
grep -q "renderablePlacements(for worldMapFilename" Bridge/Views/DiscoverARView.swift || fail "discover must compute restored/expected anchors from renderable placements only"
grep -q "跳过 WorldMap：缺少预期放置锚点" Bridge/Views/DiscoverARView.swift || fail "discover diagnostics must report world maps missing expected anchors"
grep -q "lastWorldMapAttemptFailureSummary" Bridge/Views/DiscoverARView.swift || fail "discover must carry the last world map attempt failure into final relocalization guidance"
grep -q "preservingFailureSummary: true" Bridge/Views/DiscoverARView.swift || fail "discover must preserve final world map failure details when exhausting the queue"
grep -q "无法匹配附近放置：.*lastWorldMapAttemptFailureSummary" Bridge/Views/DiscoverARView.swift || fail "discover final relocalization guidance must include the last world map failure detail"
grep -q "worldMapTimeoutMessage" Bridge/Views/DiscoverARView.swift || fail "discover timeout diagnostics must include tracking/mapping/anchor context"
grep -q "observedRelocalizing" Bridge/Views/DiscoverARView.swift || fail "discover timeout diagnostics must report relocalizing state"
grep -q "忽略过期 WorldMap 超时" Bridge/Views/DiscoverARView.swift || fail "discover must ignore stale world map timeout tasks"
grep -q "worldMapAttemptGeneration" Bridge/Views/DiscoverARView.swift || fail "discover timeout watchdog must distinguish relocalization attempts across re-entry"
grep -q "generation=.*worldMap" Bridge/Views/DiscoverARView.swift || fail "discover timeout watchdog must diagnose generation-mismatched stale timeouts"
grep -q "看见页已离开，跳过下一张 WorldMap 尝试" Bridge/Views/DiscoverARView.swift || fail "discover must not start new world map attempts after leaving the page"
grep -q "看见页已离开，忽略 WorldMap 超时回调" Bridge/Views/DiscoverARView.swift || fail "discover must ignore world map timeout callbacks after leaving the page"
grep -q "activeWorldMapName == filename" Bridge/Views/DiscoverARView.swift || fail "discover timeout watchdog must only advance its active world map"
grep -q "entity(at:" Bridge/Views/DiscoverARView.swift || fail "discover must support entity hit testing"
grep -q "点击未命中虚像实体" Bridge/Views/DiscoverARView.swift || fail "discover hit testing must report missed taps"
grep -q "点击命中过期放置" Bridge/Views/DiscoverARView.swift || fail "discover hit testing must report stale placement hits"
grep -q "点击命中放置.*worldMap=.*message=" Bridge/Views/DiscoverARView.swift || fail "discover hit diagnostics must include world map and message preview"
grep -q "点击命中缺失虚像的放置" Bridge/Views/DiscoverARView.swift || fail "discover hit handling must reject placements whose avatar was deleted"
grep -q "ShareLink" Bridge/Views/DiscoverARView.swift || fail "discover snapshots must be shareable from the retention preview"
grep -q "看见留存成功.*worldMap=.*rendered=.*pixels=" Bridge/Views/DiscoverARView.swift || fail "discover snapshot diagnostics must record successful capture context and pixel size"
grep -q "看见留存分享文件生成失败" Bridge/Views/DiscoverARView.swift || fail "discover snapshot diagnostics must report share-file generation failures"
grep -q "reason=.*errorMessage" Bridge/Views/DiscoverARView.swift || fail "discover snapshot share-file failures must include a diagnostic reason"
grep -q "png-encode-failed" Bridge/Views/DiscoverARView.swift || fail "discover snapshot diagnostics must distinguish image encoding failures"
grep -q "clearSnapshotState" Bridge/Views/DiscoverARView.swift || fail "discover must clear stale retention snapshots when relocalization resets"
grep -q "snapshotGeneration" Bridge/Views/DiscoverARView.swift || fail "discover snapshots must reject stale async snapshot callbacks"
grep -q "忽略过期看见留存回调" Bridge/Views/DiscoverARView.swift || fail "discover snapshots must diagnose ignored stale async snapshot callbacks"
grep -q "看见留存失败.*ARView snapshot 为空" Bridge/Views/DiscoverARView.swift || fail "discover snapshot diagnostics must record failed captures"
grep -q "canCaptureSnapshot" Bridge/Views/DiscoverARView.swift || fail "discover snapshots must be gated on relocalized rendered content"
grep -q "看见留存拒绝：尚未重定位或未渲染虚像" Bridge/Views/DiscoverARView.swift || fail "discover snapshots must diagnose rejected pre-relocalization captures"
grep -q "handleLocalPlacementDataChanged" Bridge/Views/DiscoverARView.swift || fail "discover must clear rendered state when local placement/avatar data changes"
grep -q "livePlacementsByID" Bridge/Views/DiscoverARView.swift || fail "discover must treat rendered placements with deleted avatars as stale"
grep -q "本地放置数据变化，已清除看见页 stale 状态" Bridge/Views/DiscoverARView.swift || fail "discover diagnostics must report stale local data cleanup"
grep -q "bridge_diagnostics_events.json" Bridge/Services/BridgeDiagnostics.swift || fail "diagnostic events must persist across app restart"
grep -q "lastPersistenceWarning" Bridge/Services/BridgeDiagnostics.swift || fail "diagnostics must expose event persistence failures"
grep -q "诊断日志写入失败" Bridge/Services/BridgeDiagnostics.swift || fail "diagnostics must warn when event persistence fails"
grep -q "maxPersistedEvents = 200" Bridge/Services/BridgeDiagnostics.swift || fail "diagnostic events must retain enough history for full iPhone MVP tests"
grep -q "AnchorPersistence.loadWorldMap" Bridge/Services/BridgeDiagnostics.swift || fail "diagnostics must decode world maps for anchor count"
grep -q "AnchorPersistence.storedWorldMapFilenames" Bridge/Services/BridgeDiagnostics.swift || fail "diagnostics must include unreferenced stored world map files"
grep -q "AnchorPersistence.isValidWorldMapFilename" Bridge/Services/BridgeDiagnostics.swift || fail "diagnostics must validate world map filenames before file access"
grep -q "validFilename && !.*exists" Bridge/Services/BridgeDiagnostics.swift || fail "diagnostic report must not count invalid filenames as missing world maps"
grep -q "filename invalid" Bridge/Services/BridgeDiagnostics.swift || fail "diagnostic report must include invalid world map filename state"
grep -q "Invalid WorldMap filenames" Bridge/Services/BridgeDiagnostics.swift || fail "diagnostic report must summarize invalid world map filenames"
grep -q "Unreferenced WorldMaps" Bridge/Services/BridgeDiagnostics.swift || fail "diagnostic report must summarize unreferenced world maps"
grep -q "文件名无效，重定位一定会失败" Bridge/Views/DiagnosticsView.swift || fail "diagnostics view must show invalid world map filenames"
grep -q "无效 WorldMap 文件名" Bridge/Views/DiagnosticsView.swift || fail "diagnostics view must summarize invalid world map filenames"
grep -q "孤儿 WorldMap" Bridge/Views/DiagnosticsView.swift || fail "diagnostics view must summarize unreferenced world maps"
grep -q "清理孤儿 WorldMap" Bridge/Views/DiagnosticsView.swift || fail "diagnostics view must clean unreferenced world maps"
grep -q "validFilename && !.*exists" Bridge/Views/DiagnosticsView.swift || fail "diagnostics view must not count invalid filenames as missing world maps"
grep -q "WorldMap 文件名无效或 transform 异常" Bridge/Views/DiagnosticsView.swift || fail "invalid placement cleanup footer must match current cleanup criteria"
grep -q "decodeError" Bridge/Services/BridgeDiagnostics.swift || fail "diagnostics must report world map decode errors"
grep -q "invalidTransforms" Bridge/Services/BridgeDiagnostics.swift || fail "diagnostic report must include invalid joint transform counts"
grep -q "transformState" Bridge/Services/BridgeDiagnostics.swift || fail "diagnostic report must include placement transform state"
grep -q "invalid(.*placement.anchor.transform.count" Bridge/Services/BridgeDiagnostics.swift || fail "diagnostic report must include invalid placement transform count"
grep -q "worldMap:.*worldMapState" Bridge/Services/BridgeDiagnostics.swift || fail "diagnostic report placement details must include world map state"
grep -q "filename invalid" Bridge/Services/BridgeDiagnostics.swift || fail "diagnostic report placement details must distinguish invalid world map filenames"
grep -q "validMasks" Bridge/Services/BridgeDiagnostics.swift || fail "diagnostic report must include valid avatar mask counts"
grep -q "hull:.*hullState" Bridge/Services/BridgeDiagnostics.swift || fail "diagnostic report must include avatar visual hull candidate state"
grep -q "invalidMasks" Bridge/Services/BridgeDiagnostics.swift || fail "diagnostic report must include invalid mask counts"
grep -q "maskStates" Bridge/Services/BridgeDiagnostics.swift || fail "diagnostic report must include mask validation states"
grep -q "lastLoadSummary" Bridge/Services/LocalStore.swift || fail "local store must expose load failure warnings"
grep -q "lastSaveSummary" Bridge/Services/LocalStore.swift || fail "local store must expose save failure warnings"
grep -q "appendLoadWarning" Bridge/Services/LocalStore.swift || fail "local store must accumulate load failure warnings"
grep -q "appendSaveWarning" Bridge/Services/LocalStore.swift || fail "local store must accumulate save failure warnings"
grep -q "func save() -> Bool" Bridge/Services/LocalStore.swift || fail "local store snapshot saves must report persistence success"
grep -q "本地昵称写入失败" Bridge/Services/LocalStore.swift || fail "local store must report author name persistence failures"
grep -q 'label: "评论"' Bridge/Services/LocalStore.swift || fail "local store must label comment JSON load warnings"
grep -q "数据加载失败" Bridge/Services/LocalStore.swift || fail "local store must report JSON load failures"
grep -q "Last load warning" Bridge/Services/BridgeDiagnostics.swift || fail "diagnostic report must include local load warnings"
grep -q "Last save warning" Bridge/Services/BridgeDiagnostics.swift || fail "diagnostic report must include local save warnings"
grep -q "Comment integrity" Bridge/Services/BridgeDiagnostics.swift || fail "diagnostic report must include comment integrity diagnostics"
grep -q "Avatars" Bridge/Services/BridgeDiagnostics.swift || fail "diagnostic report must include avatar scan quality details"
grep -q "masks:" Bridge/Services/BridgeDiagnostics.swift || fail "diagnostic report must include avatar mask count"
grep -q "anchorIdentifier:" Bridge/Services/BridgeDiagnostics.swift || fail "diagnostic report must include placement anchor identifiers"
grep -q "虚像数据" Bridge/Views/DiagnosticsView.swift || fail "diagnostics view must show avatar scan quality details"
grep -q "anchor .*anchorIdentifier" Bridge/Views/DiagnosticsView.swift || fail "diagnostics view must show placement anchor identifiers"
grep -q "placement.anchor.latitude" Bridge/Views/DiagnosticsView.swift || fail "diagnostics view must show placement location context"
grep -q "WorldMap 文件名无效" Bridge/Views/DiagnosticsView.swift || fail "diagnostics view placement details must distinguish invalid world map filenames"
grep -q "store.lastLoadSummary" Bridge/Views/DiagnosticsView.swift || fail "diagnostics view must show local load warnings"
grep -q "store.lastSaveSummary" Bridge/Views/DiagnosticsView.swift || fail "diagnostics view must show local save warnings"
grep -q "diagnostics.lastPersistenceWarning" Bridge/Views/DiagnosticsView.swift || fail "diagnostics view must show diagnostic event persistence warnings"
grep -q "评论完整性" Bridge/Views/DiagnosticsView.swift || fail "diagnostics view must show comment integrity diagnostics"
grep -q "坏 transform" Bridge/Views/DiagnosticsView.swift || fail "diagnostics view must show invalid transform counts"
grep -q "有效 mask" Bridge/Views/DiagnosticsView.swift || fail "diagnostics view must show valid avatar mask counts"
grep -q "hull .*hullState" Bridge/Views/DiagnosticsView.swift || fail "diagnostics view must show avatar visual hull candidate state"
grep -q "坏 mask" Bridge/Views/DiagnosticsView.swift || fail "diagnostics view must show invalid mask counts"
grep -q "Self.preview(placement.message)" Bridge/Views/DiagnosticsView.swift || fail "diagnostics view must show placement message preview"
grep -q "purgeInvalidPlacements" Bridge/Services/LocalStore.swift || fail "local store must support invalid placement cleanup"
grep -q "purgeUnreferencedWorldMapFiles" Bridge/Services/LocalStore.swift || fail "local store must support orphan world map cleanup"
grep -q "storedWorldMapFilenames" Bridge/Services/AnchorPersistence.swift || fail "anchor persistence must enumerate stored world maps"
grep -q "func deleteAvatar(_ avatar: AvatarPose) -> Bool" Bridge/Services/LocalStore.swift || fail "avatar deletion must report local persistence success"
grep -q "func deletePlacement(_ placement: Placement) -> Bool" Bridge/Services/LocalStore.swift || fail "placement deletion must report local persistence success"
grep -q "previousAvatars" Bridge/Services/LocalStore.swift || fail "avatar deletion persistence failures must roll back avatar state"
grep -q "previousPlacements" Bridge/Services/LocalStore.swift || fail "placement deletion persistence failures must roll back placement state"
grep -q "removePlacementEngagementInMemory" Bridge/Services/LocalStore.swift || fail "placement deletion must stage engagement cleanup before persistence"
grep -q "WorldMap 清理：本地删除写入失败，已跳过地图清理" Bridge/Services/LocalStore.swift || fail "deletion persistence failures must skip world map cleanup"
grep -q "func deleteComment(id: UUID) -> Bool" Bridge/Services/LocalStore.swift || fail "comment deletion must report local persistence success"
grep -q "坏 transform" Bridge/Services/LocalStore.swift || fail "invalid placement cleanup must count bad transforms"
grep -q "WorldMap 文件名无效" Bridge/Services/LocalStore.swift || fail "invalid placement cleanup must count invalid world map filenames separately"
grep -q "worldMapSummary" Bridge/Services/LocalStore.swift || fail "invalid placement cleanup must preserve world map cleanup results"
grep -q "snapshotPersisted" Bridge/Services/LocalStore.swift || fail "invalid placement cleanup must report snapshot persistence failures"
grep -q "engagementPersisted" Bridge/Services/LocalStore.swift || fail "invalid placement cleanup must report engagement persistence failures"
grep -q "无效放置清理：本地写入失败，本次清理已回滚" Bridge/Services/LocalStore.swift || fail "invalid placement cleanup must roll back local persistence failures"
grep -q "WorldMap 清理已跳过" Bridge/Services/LocalStore.swift || fail "invalid placement cleanup must skip world map cleanup when JSON persistence fails"
grep -q "仍被引用" Bridge/Services/LocalStore.swift || fail "world map cleanup diagnostics must report still-referenced maps"
grep -q "文件名无效.*invalidFilenameCount" Bridge/Services/LocalStore.swift || fail "world map cleanup diagnostics must separate invalid filenames from delete failures"
grep -q "无需清理" Bridge/Services/LocalStore.swift || fail "world map cleanup diagnostics must refresh no-op summaries"
grep -q "purgeOrphanedEngagement" Bridge/Services/LocalStore.swift || fail "local store must purge orphaned comments after placement cleanup"
grep -q "orphanedCommentIDs" Bridge/Services/LocalStore.swift || fail "local store must purge orphaned reply trees after restart"
grep -q "重启后孤立评论可能恢复" Bridge/Services/LocalStore.swift || fail "orphaned comment cleanup must warn when local persistence fails"
grep -q "parent.placementID == comment.placementID" Bridge/Services/LocalStore.swift || fail "orphaned reply cleanup must reject cross-placement parent links"
grep -q "parent.parentID == nil" Bridge/Services/LocalStore.swift || fail "local store must keep comments to a visible two-level thread model"
grep -q "toRemove.contains(parentID)" Bridge/Services/LocalStore.swift || fail "comment deletion must recursively remove stale nested descendants"
grep -q "LocalStoreConsistencyError" Bridge/Services/LocalStore.swift || fail "local store must reject stale placement/comment engagement writes"
grep -q "topLevelCommentHasExistingPlacement" Bridge/Services/LocalStore.swift || fail "comment reactions must only apply to valid top-level comments"
grep -q "replyCommentHasExistingPlacement" Bridge/Services/LocalStore.swift || fail "comment likes must only apply to valid reply comments"
grep -q "func setCommentReaction(commentID: UUID, kind: ReactionKind) -> Bool" Bridge/Services/LocalStore.swift || fail "comment reaction writes must report stale comment failures"
grep -q "func toggleCommentLike(commentID: UUID) -> Bool" Bridge/Services/LocalStore.swift || fail "comment like writes must report stale comment failures"
grep -q "previousReactions" Bridge/Services/LocalStore.swift || fail "comment reaction persistence failures must roll back in-memory reaction changes"
grep -q "previousLikes" Bridge/Services/LocalStore.swift || fail "comment like persistence failures must roll back in-memory like changes"
grep -q "persisted: Bool" Bridge/Services/LocalStore.swift || fail "comment writes must report local persistence success"
grep -q "private func persistComments() -> Bool" Bridge/Services/LocalStore.swift || fail "comment persistence must return write success"
grep -q "comments.removeAll.*comment.id" Bridge/Services/LocalStore.swift || fail "comment persistence failures must roll back in-memory comments"
grep -q "commentIntegritySummary" Bridge/Services/LocalStore.swift || fail "local store must expose comment integrity diagnostics"
grep -q "placementExists" Bridge/Views/Components/CommentThreadView.swift || fail "comment thread must detect stale/missing placements"
grep -q "activeThreadContent" Bridge/Views/Components/CommentThreadView.swift || fail "comment thread must hide stale comments for missing placements"
grep -q "评论失败" Bridge/Views/Components/CommentThreadView.swift || fail "comment thread must surface stale comment write failures"
grep -q "评论警告：本地写入失败，已撤回内存评论并保留输入" Bridge/Views/Components/CommentThreadView.swift || fail "comment thread must keep top-level input after local comment persistence failures"
grep -q "回复警告：本地写入失败，已撤回内存回复并保留输入" Bridge/Views/Components/CommentThreadView.swift || fail "comment thread must keep reply input after local reply persistence failures"
grep -q "评论反应失败.*本次切换已回滚" Bridge/Views/Components/CommentThreadView.swift || fail "comment thread must surface rolled-back reaction write failures"
grep -q "评论点赞失败.*本次切换已回滚" Bridge/Views/Components/CommentThreadView.swift || fail "comment thread must surface rolled-back like write failures"
grep -q "scope: \"Comments\"" Bridge/Views/Components/CommentThreadView.swift || fail "comment actions must be recorded in diagnostics"
grep -q "previousComments" Bridge/Services/LocalStore.swift || fail "comment deletion persistence failures must roll back in-memory comment deletion"
grep -q "放置已删除" Bridge/Views/PlacementDetailView.swift || fail "placement detail must not render stale deleted placement data"
grep -q "删除放置" Bridge/Views/MyPlacementsView.swift || fail "placement deletion must be recorded in diagnostics"
grep -q "删除放置警告：本地写入失败，本次删除已回滚" Bridge/Views/MyPlacementsView.swift || fail "placement deletion must surface rolled-back local persistence failures"
grep -q "删除虚像" Bridge/Views/AvatarsListView.swift || fail "avatar list deletion must be recorded in diagnostics"
grep -q "删除虚像警告：本地写入失败，本次删除已回滚" Bridge/Views/AvatarsListView.swift || fail "avatar list deletion must surface rolled-back local persistence failures"
grep -q "删除虚像" Bridge/Views/AvatarDetailView.swift || fail "avatar detail deletion must be recorded in diagnostics"
grep -q "删除虚像警告：本地写入失败，本次删除已回滚" Bridge/Views/AvatarDetailView.swift || fail "avatar detail deletion must surface rolled-back local persistence failures"
grep -q "if persisted" Bridge/Views/AvatarDetailView.swift || fail "avatar detail must stay open when deletion persistence rolls back"
grep -q "删除评论警告：本地写入失败，本次删除已回滚" Bridge/Views/Components/CommentThreadView.swift || fail "comment deletion must surface rolled-back local persistence failures"
grep -q "ARSession 被中断，已清除扫描缓存" Bridge/Views/ScanARView.swift || fail "scan view must clear stale body/frame data after AR interruption"
grep -q "ARSession 失败，已清除扫描缓存" Bridge/Views/ScanARView.swift || fail "scan view must clear stale body/frame data after AR session failure"
grep -q "离开扫描页，已清除实时人体缓存" Bridge/Views/ScanARView.swift || fail "scan view must clear live body/frame cache when leaving"
grep -q "Scan tracking" Bridge/Views/ScanARView.swift || fail "scan view must report tracking state diagnostics"
grep -q "Body Tracking 超时未检测到人体" Bridge/Views/ScanARView.swift || fail "scan view must report body detection timeouts"
grep -q "bodyDetectionWatchdogGeneration" Bridge/Views/ScanARView.swift || fail "scan body detection watchdog must guard stale timeout tasks"
grep -q "忽略过期 Body Tracking 超时" Bridge/Views/ScanARView.swift || fail "scan view must diagnose stale body detection timeout tasks"
grep -q "Body Tracking 已检测到人体 anchor" Bridge/Views/ScanARView.swift || fail "scan view must report first body anchor detection"
grep -q "ARSession 被中断，已清除放置预览" Bridge/Views/PlaceARView.swift || fail "place view must clear stale preview anchors after AR interruption"
grep -q "ARSession 失败，已清除放置预览" Bridge/Views/PlaceARView.swift || fail "place view must clear stale preview anchors after AR session failure"
grep -q "离开放置页，已清除未保存放置预览" Bridge/Views/PlaceARView.swift || fail "place view must clear unsaved preview anchors when leaving"
grep -q "Place tracking" Bridge/Views/PlaceARView.swift || fail "place view must report tracking state diagnostics"
grep -q "放置预览失败：未选择虚像" Bridge/Views/PlaceARView.swift || fail "place preview must distinguish missing avatar selection from raycast misses"
grep -q "放置预览失败：选中的虚像已删除" Bridge/Views/PlaceARView.swift || fail "place preview must distinguish deleted selected avatars from raycast misses"
grep -q "放置预览失败：未命中平面" Bridge/Views/PlaceARView.swift || fail "place preview must report real plane raycast misses"
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
grep -q "scenePhase background/foreground" docs/iphone_mvp_test_plan.md || fail "iPhone MVP test plan must cover app background/foreground AR cleanup"
grep -q "lock the phone or background the app" docs/iphone_mvp_test_plan.md || fail "P0 test plan must cover lock/background during active AR pages"
grep -q "Diagnostic persistence" docs/iphone_mvp_test_plan.md || fail "iPhone MVP test plan must cover diagnostic persistence"
grep -q "Invalid placement cleanup" docs/iphone_mvp_test_plan.md || fail "iPhone MVP test plan must cover invalid placement cleanup"
grep -q "still-referenced counts" docs/iphone_mvp_test_plan.md || fail "iPhone MVP test plan must cover current world map cleanup summaries"
grep -q "orphan WorldMap cleanup" docs/iphone_mvp_test_plan.md || fail "iPhone MVP test plan must cover orphan world map cleanup"
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
