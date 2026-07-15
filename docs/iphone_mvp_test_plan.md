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
| P0-2 | Permissions and first route | On first launch, allow camera, location, and motion permissions. | With no local avatars or placements, the app opens on Scan so the MVP flow starts from body capture. AR camera feed appears; no silent black screen. | |
| P0-3 | Scan | Open Scan. Capture front plus at least one side/back angle. Save avatar. | Avatar saves. If body tracking is unsupported, app shows an explicit unsupported-device message. If no body is detected after Body Tracking starts, the app shows distance/light/full-body guidance and records the timeout. Diagnostics record Scan tracking state, captured view angles, how many segmentation masks were captured, and whether each mask can decode to its expected pixel count. | |
| P0-4 | Place | Open Place, select avatar, enter a short message, tap a real floor/wall plane. Adjust heading. | Preview avatar appears at tapped location. Heading changes do not drift or accumulate unexpectedly. Diagnostics record Place tracking state if AR tracking is limited or recovers. | |
| P0-5 | Save world map | Tap save after mapping is mapped/extending. | Save succeeds and placement appears under My Placements. Diagnostics record the WorldMap filename, anchor count, file size, mapping status, location availability, heading, and location/heading provider summary. | |
| P0-6 | Leave app | Switch tab, background app, or close and reopen. | No crash; AR session resumes when returning to AR views. | |
| P0-7 | Relocalize | Return to same physical spot. Open Discover and slowly scan the original area. | Status changes to relocalized only after the saved WorldMap anchor is restored and the avatar appears at the original position. No avatar should appear before relocalization. The HUD shows current WorldMap attempt progress plus tracking/mapping/relocalizing state; diagnostics show the queue count, location/heading provider summary, distance summary, attempt number, and Discover tracking state. | |
| P0-8 | Hit test | Tap the visible avatar. | Correct placement card opens with the saved message and comment thread. `诊断` records the tapped placement ID, WorldMap filename, and message preview; the Diagnostics placement reference shows the same message preview and location context. | |
| P0-9 | Comment | Add top-level comment, reply, reaction, and like. Reopen placement. | Engagement persists locally and comment actions are visible in `诊断` recent events. | |
| P0-10 | Delete | Delete a placement from My Placements. Reopen Discover. | Deleted placement and related comments no longer appear. `诊断` records the deleted placement ID, WorldMap cleanup summary, and removed comment count. | |

## P1 Stability Checks

| ID | Test | Steps | Expected result | Result |
| --- | --- | --- | --- | --- |
| P1-1 | Low mapping quality | Try saving before scanning the room enough. | App explains the world map is unavailable, asks user to move/scan, and records the rejected mapping state in `诊断`. | |
| P1-2 | Wrong location | Open Discover far from the placement. | App does not fake success; it eventually shows relocalization guidance. | |
| P1-3 | Multiple placements | Place two avatars in the same room. Relocalize and tap each. | Each tap opens the matching card, and `诊断` records a distinct placement ID/message preview for each tap. | |
| P1-4 | App restart | Force quit, reopen, and Discover at original spot. | Local avatar/placement/comment data loads; relocalization can still be attempted. If a local JSON file cannot decode, the Diagnostics tab and exported report show a load warning instead of silently hiding the cause. | |
| P1-5 | Poor light | Repeat Discover with reduced light. | Failure is graceful; app does not render stale avatars as success. | |
| P1-6 | AR interruption | During Scan, Place, and Discover, briefly background the app or trigger a system interruption, then return. | App records interruption/recovery in `诊断`; Scan clears cached body/frame data and restarts Body Tracking; Place clears the preview and requires a fresh plane tap before save; Discover clears rendered avatars/cards and restarts matching instead of keeping stale relocalized state. | |
| P1-7 | Leave Scan with unsaved data | Record one scan angle, choose to stay, then leave after confirming discard; return to Scan. | Live body/frame cache is cleared; previously discarded scan data cannot be saved accidentally. | |
| P1-8 | Leave Place with preview | Create a placement preview, switch away from Place without saving, then return to Place. | The old preview cannot be saved; user must tap a real plane again before saving. | |
| P1-9 | Delete selected avatar while placing | Select an avatar in Place, create a preview, delete that avatar from the avatar list if possible, then return/save. | Place clears the preview or refuses save; no placement referencing a missing avatar is created. | |
| P1-10 | Invalid local data | Delete a placement/avatar or use Diagnostics to confirm missing WorldMap or invalid transform cases after repeated tests. | Discover explains when candidates are skipped because the avatar or `.worldmap` file is missing; Diagnostics exposes invalid transform counts and cleanup can remove bad placement anchors. This is not counted as AR relocalization failure. | |
| P1-11 | Diagnostic persistence | Trigger at least one Scan/Place/Discover event, force quit, reopen, and open `诊断`. | Recent diagnostic events are still visible and included in the exported report. | |
| P1-12 | Invalid placement cleanup | Create or simulate an invalid placement, open `诊断`, and tap `清理无效放置`; also delete placements/avatars whose WorldMap is either unreferenced or still referenced by another placement. | Only placements missing avatar data or `.worldmap` files are removed; deletion diagnostics show this operation's WorldMap cleanup result, including deleted/missing/still-referenced counts, without reusing an older maintenance summary. | |
| P1-13 | Orphaned comment cleanup | Delete a placement or avatar with comments, force quit, reopen, and export `诊断`. | Comments/reactions/likes for deleted placements do not reappear after reload, and `诊断` records the deletion action plus removed placement/comment counts. | |
| P1-14 | Stale engagement writes | Keep a placement detail card open, delete that placement from another view if possible, then try to comment/react from the stale card. | App shows that the placement no longer exists instead of rendering stale placement text, disables new writes, records the refused action in `诊断`, and does not create comments/reactions/likes for missing placements or comments. | |

## Evidence to Collect

For every failed item, capture:

- Screen recording from before the action through the failure.
- Xcode console logs around the failure.
- App `诊断` tab export. It includes device AR support, local data counts, referenced WorldMap files with decode status and anchor counts, and recent scan/place/discover events.
- The test ID, physical location, distance from original placement, and lighting conditions.
- Whether the status badge said relocalized.
- Whether a visible avatar appeared before relocalization.
- Whether `诊断` contains ARSession interruption/recovery, Scan/Place/Discover tracking state, skipped candidate, location permission, GPS, or heading availability messages.
- Whether Scan recorded the first detected body anchor or a Body Tracking timeout when no full body was found.
- Whether `诊断` shows a local JSON load warning after restart if avatars, placements, comments, reactions, or likes unexpectedly disappear.
- Whether `诊断` shows each saved avatar's captured view count, mask count, mask validity state, joints count, and angle list.
- Whether `诊断` shows invalid joint or placement transform counts before treating a render/relocalization failure as an ARKit issue.
- Whether `诊断` contains the Place and Discover location/heading provider summaries, including authorization, GPS accuracy/age, and heading availability.
- Whether `诊断` shows the WorldMap candidate queue count, current attempt number, and Discover tracking state when Discover tries or times out.
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
