# iPhone Single-Device MVP Test Plan

This plan verifies the first shippable Bridge milestone: one iPhone can scan a person, place the avatar in a real location, leave, return, relocalize, and open the correct comment card.

It does not verify CloudKit, cross-device visibility, TestFlight, moderation operations, or VPS.

## Prerequisites

- Mac with Xcode 15 or newer.
- iPhone with iOS 17 or newer and ARKit body/world tracking support.
- Apple ID selected in Xcode Signing & Capabilities.
- Unique Bundle Identifier if `com.bridge.app` conflicts.
- Camera, Location, and Motion permissions granted on first launch.
- A real indoor or outdoor space with stable visual features and enough light.

Before device testing:

```bash
./scripts/static_audit.sh
./scripts/preflight.sh
```

`preflight.sh` must pass on a Mac with full Xcode. If it fails before device install, fix compile/project errors first.

For signing, device trust, permissions, and diagnostic collection, follow `docs/iphone_device_setup.md`.

## Test Session Metadata

Record these values before testing:

| Field | Value |
| --- | --- |
| Date/time | |
| iPhone model | |
| iOS version | |
| Xcode version | |
| Build commit | |
| Test location | |
| Tester | |

## Pass Criteria

The single-device MVP passes only if all P0 items pass in one continuous session:

1. Create an avatar from at least two scan angles.
2. Place the avatar on a real detected plane.
3. Save an `ARWorldMap` without error.
4. Quit or leave the app.
5. Return to the same physical spot.
6. Discover relocalizes and renders the avatar in the original physical position.
7. Tapping the rendered avatar opens the matching placement message and comment thread.

## P0 Test Cases

| ID | Test | Steps | Expected result | Result |
| --- | --- | --- | --- | --- |
| P0-1 | Build and install | Open `Bridge.xcodeproj`, set Team, choose iPhone, run. | App installs and launches. No missing entitlement, signing, or Info.plist error. | |
| P0-2 | Permissions and first route | On first launch, allow camera, location, and motion permissions. | With no local avatars or placements, the app opens the Scan flow inside `虚像` so the MVP flow starts from body capture. AR camera feed appears; no silent black screen. | |
| P0-3 | Scan | Open Scan. Capture front plus at least one side/back angle. Re-capture one angle once, then save avatar. | Avatar saves. If body tracking is unsupported, app shows an explicit unsupported-device message. If no body is detected after Body Tracking starts, the app shows distance/light/full-body guidance and records the timeout. Stale timeout tasks after a restart/interruption are ignored instead of producing a misleading failure. Re-capturing an angle replaces that angle's segmentation mask; if the new segmentation fails, the old mask is not reused and Diagnostics records the segmentation failure reason. Diagnostics record Scan tracking state, captured view angles, total/valid/invalid segmentation masks, whether each mask can decode to its expected pixel count, and whether rendering is a visual-hull candidate or fallback skeleton. Invalid masks must be excluded from visual-hull mesh generation. | |
| P0-4 | Place | Open Place, select avatar, enter a short message, tap a real floor/wall plane. Adjust heading. | Preview avatar appears at tapped location. Heading changes do not drift or accumulate unexpectedly. Automatic compass initialization uses only fresh valid heading data; stale or invalid heading leaves manual adjustment intact. Diagnostics record Place tracking state if AR tracking is limited or recovers, and failed preview taps distinguish missing avatar selection, deleted selected avatar, and real plane raycast misses. | |
| P0-5 | Save world map | Tap save after mapping is mapped/extending and the preview anchor is ready; try tapping save repeatedly while it is saving. | Save is blocked until the preview anchor appears in the current ARFrame, duplicate save requests are ignored, then one placement appears under My Placements. Diagnostics record preview-anchor readiness, the WorldMap filename, anchor count, file size, mapping status, location availability, heading, and location/heading provider summary. If saving fails, the error must include the AR mapping status, current WorldMap anchor count, and the expected preview anchor ID when the map is missing that anchor. | |
| P0-6 | Leave app | Switch tab, background app, or close and reopen. | No crash; AR session resumes when returning to AR views. | |
| P0-7 | Relocalize | Return to same physical spot. Open Discover and slowly scan the original area. | Status changes to relocalized only after the saved WorldMap anchor is restored and the avatar appears at the original position. No avatar should appear before relocalization. The HUD shows current WorldMap attempt progress plus tracking/mapping/relocalizing state; diagnostics show the queue count, location/heading provider summary, distance summary, attempt number, saved WorldMap anchor count, expected placement anchor count, Discover tracking state, cached restored-anchor count, restored/expected anchor summary, and rendered/missing placement ID summaries. If ARKit removes a restored anchor, Discover clears stale rendered state and records the removal instead of keeping the old avatar visible. | |
| P0-8 | Hit test | Tap the visible avatar, then tap `留存`. Also confirm `留存` is unavailable before any avatar is rendered. | Correct placement card opens with the saved message and comment thread. `诊断` records the tapped placement ID, WorldMap filename, and message preview; the rendered placement ID summary and Diagnostics placement reference show the same placement/message context. The `留存` action is gated until relocalized content is rendered, then shows a shareable preview and records whether the ARView snapshot succeeded, the active/rendered WorldMap, rendered placement count, and snapshot pixel size. | |
| P0-9 | Comment | Add top-level comment, reply, reaction, and like. Reopen placement. | Engagement persists locally and comment actions are visible in `诊断` recent events. The visible two-level comment list and engagement count agree after restart; orphaned or over-nested replies from stale local JSON are cleaned. If a comment or placement was deleted before a reaction/like tap is processed, or a local comment JSON write fails, the app records a failed/warning event instead of a misleading durable-success event. | |
| P0-10 | Delete | Delete a placement from My Placements. Reopen Discover. Also delete one comment and one avatar if test data allows. | Deleted placement and related comments no longer appear. If Discover was holding a rendered avatar or open card for deleted local data, it clears stale state and rematches instead of keeping the old avatar/card visible. `诊断` records the deleted placement/avatar/comment ID, WorldMap cleanup summary, removed comment count, stale Discover cleanup when applicable, and any local deletion persistence warning if JSON writing fails. | |

## P1 Stability Checks

| ID | Test | Steps | Expected result | Result |
| --- | --- | --- | --- | --- |
| P1-1 | Low mapping quality | Try saving before scanning the room enough. | App explains the world map is unavailable, asks user to move/scan, and records the rejected mapping state in `诊断`. | |
| P1-2 | Wrong location | Open Discover far from the placement; also temporarily deny Location permission or disable system location if safe to do during the test. | App does not fake success; it eventually shows relocalization guidance. If location or heading is unavailable, stale, invalid, or permission is denied, Diagnostics shows the permission/service state and does not keep using stale GPS/heading values for candidate sorting, compass initialization, or newly saved placement coordinates. | |
| P1-3 | Multiple placements | Place two avatars in the same room. Relocalize and tap each. | Each tap opens the matching card, and `诊断` records a distinct placement ID/message preview for each tap. | |
| P1-4 | App restart | Force quit, reopen, and Discover at original spot. Also check Diagnostics immediately after any save/comment action unexpectedly fails or disappears. | Local avatar/placement/comment data loads; relocalization can still be attempted. If a local JSON file cannot decode after restart or cannot be written during the test session, the Diagnostics tab and exported report show a load/save warning instead of silently hiding the cause. | |
| P1-5 | Poor light | Repeat Discover with reduced light. | Failure is graceful; app does not render stale avatars as success. | |
| P1-6 | AR interruption and ARSession failure | During Scan, Place, and Discover, briefly background the app or trigger a system interruption, then return; if Xcode/device logs surface an ARSession failure, keep the app open and check the active screen state; also switch away from Discover after it renders a placement and come back. | App records interruption/recovery or ARSession failure cleanup in `诊断`; Scan clears cached body/frame data and restarts Body Tracking after interruption; Place clears the preview and requires a fresh plane tap before save; Discover clears rendered avatars/cards on interruption, ARSession failure, or view exit and restarts matching instead of keeping stale relocalized state. | |
| P1-7 | Leave Scan with unsaved data | Record one scan angle, switch Scan mode once, then record again and try both the navigation back action and switching to another tab. Choose to stay once, then leave after confirming discard; return to Scan. | Mode switching records that unsaved scan data was cleared. Both exit paths show the unsaved-scan confirmation; live body/frame cache is cleared; previously discarded scan data cannot be saved accidentally. | |
| P1-8 | Leave Place with preview | Create a placement preview, switch away from Place without saving, then return to Place. Also try leaving or creating a new preview while save is still in progress if the device is slow enough to observe it. | The old preview cannot be saved; user must tap a real plane again before saving. If a save finishes after the preview changed or the view was left, no stale placement is created and the temporary WorldMap is discarded with a diagnostic event. | |
| P1-9 | Delete selected avatar while placing | Select an avatar in Place, create a preview, delete that avatar from the avatar list if possible, then return/save. | Place clears the preview or refuses save; no placement referencing a missing avatar is created. | |
| P1-10 | Invalid local data | Delete a placement/avatar or use Diagnostics to confirm missing WorldMap, invalid WorldMap filename, invalid transform, or WorldMap-without-expected-anchor cases after repeated tests. If a stale rendered entity can still be tapped immediately after deleting its avatar, tap it once. | Discover explains when candidates are skipped because the avatar, `.worldmap` file, WorldMap filename, or expected placement anchor is missing/invalid; tapping a stale rendered entity whose avatar was deleted does not open a valid card. Diagnostics exposes invalid transform counts and cleanup can remove bad placement anchors. This is not counted as AR relocalization failure. | |
| P1-11 | Diagnostic persistence | Trigger at least one Scan/Place/Discover event, force quit, reopen, and open `诊断`. | Recent diagnostic events are still visible and included in the exported report. If the diagnostic event log itself cannot be written, `诊断` and the exported report show a diagnostic persistence warning instead of silently losing evidence. | |
| P1-12 | Invalid placement cleanup | Create or simulate an invalid placement, open `诊断`, and tap `清理无效放置`; also delete placements/avatars whose WorldMap is either unreferenced or still referenced by another placement. | Only placements missing avatar data, missing `.worldmap` files, invalid WorldMap filenames, or invalid transform data are removed. Diagnostics summarize invalid WorldMap filename counts separately from missing files, and deletion diagnostics show this operation's WorldMap cleanup result, including deleted/missing/still-referenced counts, without reusing an older maintenance summary. If local JSON writing fails, the maintenance summary warns that invalid placements or related comments may return after restart. | |
| P1-13 | Orphan WorldMap cleanup | After repeated save/cancel/failure tests, open `诊断` and compare WorldMap references, stored WorldMap files, and orphan WorldMap counts. If orphan count is nonzero, tap `清理孤儿 WorldMap`. | Unreferenced `.worldmap` files are visible as orphan WorldMaps and can be deleted without removing any valid placement, avatar, or comment data. The exported report includes referenced/stored/unreferenced WorldMap counts. | |
| P1-14 | Orphaned comment cleanup | Delete a placement or avatar with comments, force quit, reopen, and export `诊断`. Also delete a top-level comment that has replies after repeated local tests. | Comments/reactions/likes for deleted placements do not reappear after reload, deleting a comment removes its full reply tree, and `诊断` records the deletion action plus removed placement/comment counts. | |
| P1-15 | Stale engagement writes | Keep a placement detail card open, delete that placement from another view if possible, then try to comment/react from the stale card. | App shows that the placement no longer exists instead of rendering stale placement text or stale comments, disables new writes, records the refused action in `诊断`, and does not create comments/reactions/likes for missing placements or comments. | |

## Evidence to Collect

For every failed item, capture:

- Screen recording from before the action through the failure.
- Xcode console logs around the failure.
- App `诊断` tab export. It includes device AR support, local data counts, invalid WorldMap filename counts, referenced/stored/orphan WorldMap counts, WorldMap files with decode status and anchor counts, and recent scan/place/discover events.
- The test ID, physical location, distance from original placement, and lighting conditions.
- Whether the status badge said relocalized.
- Whether a visible avatar appeared before relocalization.
- Whether `诊断` contains ARSession interruption/recovery, Scan/Place/Discover tracking state, skipped candidate, location permission, GPS, or heading availability messages.
- Whether Scan recorded the first detected body anchor or a Body Tracking timeout when no full body was found.
- Whether `诊断` shows a local JSON load warning after restart or a current-session save warning if avatars, placements, comments, reactions, or likes unexpectedly disappear.
- Whether `诊断` shows each saved avatar's captured view count, mask count, mask validity state, joints count, and angle list.
- Whether `诊断` shows invalid joint or placement transform counts before treating a render/relocalization failure as an ARKit issue.
- Whether `诊断` reports invalid or missing WorldMap filenames as local data cleanup issues instead of trying to load an unexpected file path.
- Whether orphan WorldMap cleanup reports unreferenced `.worldmap` files after save/cancel/failure tests.
- Whether `诊断` contains the Place and Discover location/heading provider summaries, including authorization, GPS accuracy/age, heading availability, and stale GPS/heading cache clearing after location failures.
- Whether `诊断` shows the WorldMap candidate queue count, current attempt number, saved WorldMap anchor count, expected placement anchor count, and Discover tracking state when Discover tries or times out.
- Whether `诊断` shows the rendered placement ID summary and any missing placement IDs while waiting for restored anchors.
- Whether the screen recording shows the same WorldMap attempt progress and tracking/mapping/relocalizing state that appears in `诊断`.
- Whether WorldMap timeout events include tracking state, mapping status, relocalizing state, and the latest restored/expected anchor summary.
- Whether `诊断` shows the saved WorldMap can decode and contains restored anchors.
- Whether the placement `anchorIdentifier` in `诊断` matches the restored anchor behavior seen during Discover.
- Whether `诊断` includes the Discover restored-anchor summary with expected and restored anchor identifiers.
- Whether hit-test diagnostics show the tapped placement ID, WorldMap filename, and message preview for the card that opened.

Useful Xcode log filters:

```text
ARSession
WorldMap
relocal
tracking
location
Bridge
```

## Stop Rules

Stop expanding features if any P0 item fails. Fix in this order:

1. Build/sign/install errors.
2. ARSession permission or unsupported-device failures.
3. Scan/body tracking failures.
4. World map save/load failures.
5. Relocalization false success or timeout behavior.
6. Anchor transform/orientation mismatch.
7. Entity hit testing and card routing.
8. Local comment persistence.

Only start CloudKit work after all P0 items pass on one iPhone.
