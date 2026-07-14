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
| P0-2 | Permissions | On first launch, allow camera, location, and motion permissions. | AR camera feed appears; no silent black screen. | |
| P0-3 | Scan | Open Scan. Capture front plus at least one side/back angle. Save avatar. | Avatar saves. If body tracking is unsupported, app shows an explicit unsupported-device message. Diagnostics record how many segmentation masks were captured. | |
| P0-4 | Place | Open Place, select avatar, enter a short message, tap a real floor/wall plane. Adjust heading. | Preview avatar appears at tapped location. Heading changes do not drift or accumulate unexpectedly. | |
| P0-5 | Save world map | Tap save after mapping is mapped/extending. | Save succeeds and placement appears under My Placements. Diagnostics record the WorldMap filename, mapping status, location availability, and heading. | |
| P0-6 | Leave app | Switch tab, background app, or close and reopen. | No crash; AR session resumes when returning to AR views. | |
| P0-7 | Relocalize | Return to same physical spot. Open Discover and slowly scan the original area. | Status changes to relocalized only after the saved WorldMap anchor is restored and the avatar appears at the original position. No avatar should appear before relocalization. Diagnostics show the WorldMap queue count, distance summary, and attempt number. | |
| P0-8 | Hit test | Tap the visible avatar. | Correct placement card opens with the saved message and comment thread. The Diagnostics placement reference shows the same message preview and location context. | |
| P0-9 | Comment | Add top-level comment, reply, reaction, and like. Reopen placement. | Engagement persists locally. | |
| P0-10 | Delete | Delete a placement from My Placements. Reopen Discover. | Deleted placement and related comments no longer appear. | |

## P1 Stability Checks

| ID | Test | Steps | Expected result | Result |
| --- | --- | --- | --- | --- |
| P1-1 | Low mapping quality | Try saving before scanning the room enough. | App explains the world map is unavailable and asks user to move/scan. | |
| P1-2 | Wrong location | Open Discover far from the placement. | App does not fake success; it eventually shows relocalization guidance. | |
| P1-3 | Multiple placements | Place two avatars in the same room. Relocalize and tap each. | Each tap opens the matching card. | |
| P1-4 | App restart | Force quit, reopen, and Discover at original spot. | Local avatar/placement data loads; relocalization can still be attempted. | |
| P1-5 | Poor light | Repeat Discover with reduced light. | Failure is graceful; app does not render stale avatars as success. | |
| P1-6 | AR interruption | During Scan, Place, and Discover, briefly background the app or trigger a system interruption, then return. | App records interruption/recovery in `诊断`; Scan clears cached body/frame data and restarts Body Tracking; Place clears the preview and requires a fresh plane tap before save; Discover clears rendered avatars/cards and restarts matching instead of keeping stale relocalized state. | |
| P1-7 | Leave Scan with unsaved data | Record one scan angle, choose to stay, then leave after confirming discard; return to Scan. | Live body/frame cache is cleared; previously discarded scan data cannot be saved accidentally. | |
| P1-8 | Leave Place with preview | Create a placement preview, switch away from Place without saving, then return to Place. | The old preview cannot be saved; user must tap a real plane again before saving. | |
| P1-9 | Delete selected avatar while placing | Select an avatar in Place, create a preview, delete that avatar from the avatar list if possible, then return/save. | Place clears the preview or refuses save; no placement referencing a missing avatar is created. | |
| P1-10 | Invalid local data | Delete a placement/avatar or use Diagnostics to confirm missing WorldMap cases after repeated tests. | Discover explains when candidates are skipped because the avatar or `.worldmap` file is missing; this is not counted as AR relocalization failure. | |
| P1-11 | Diagnostic persistence | Trigger at least one Scan/Place/Discover event, force quit, reopen, and open `诊断`. | Recent diagnostic events are still visible and included in the exported report. | |
| P1-12 | Invalid placement cleanup | Create or simulate an invalid placement, open `诊断`, and tap `清理无效放置`. | Only placements missing avatar data or `.worldmap` files are removed; maintenance result is recorded in diagnostics. | |
| P1-13 | Orphaned comment cleanup | Delete a placement with comments, force quit, reopen, and export `诊断`. | Comments/reactions/likes for deleted placements do not reappear after reload. | |
| P1-14 | Stale engagement writes | Keep a placement detail card open, delete that placement from another view if possible, then try to comment/react from the stale card. | App refuses stale comments and does not create comments/reactions/likes for missing placements or comments. | |

## Evidence to Collect

For every failed item, capture:

- Screen recording from before the action through the failure.
- Xcode console logs around the failure.
- App `诊断` tab export. It includes device AR support, local data counts, referenced WorldMap files, and recent scan/place/discover events.
- The test ID, physical location, distance from original placement, and lighting conditions.
- Whether the status badge said relocalized.
- Whether a visible avatar appeared before relocalization.
- Whether `诊断` contains ARSession interruption/recovery, skipped candidate, location permission, GPS, or heading availability messages.
- Whether `诊断` shows the WorldMap candidate queue count and current attempt number when Discover tries or times out.

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
