# iPhone Device Setup and Diagnostics

Use this guide before running `docs/iphone_mvp_test_plan.md`.

## 1. Prepare Xcode

Install Xcode 15 or newer, then select it:

```bash
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
xcodebuild -version
./scripts/preflight.sh
```

`preflight.sh` must complete before device testing. It verifies static project settings, Web build, and an iOS build with signing disabled.
If it reports that `xcode-select` points to Command Line Tools, install full Xcode and run the exact `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer` command shown by the script before trying to sign or install on iPhone.

If full Xcode is not installed yet, the least ambiguous path is the Mac App Store:

```bash
open 'macappstore://apps.apple.com/app/xcode/id497799835?mt=12'
```

Click `Get` / `Install` in the App Store UI and complete the Apple ID or administrator password prompts locally on the Mac. CLI helpers can reduce navigation but do not remove credentials:

```bash
brew install mas xcodes
mas install 497799835
xcodes install 26.3 --directory /Applications --select
```

`mas` may still require an administrator password through macOS, and `xcodes` requires Apple Developer authentication. Do not paste Apple ID or Mac passwords into Codex chat.

## 2. Configure Signing

Open `Bridge.xcodeproj` in Xcode.

1. Select the Bridge project.
2. Select target `Bridge`.
3. Open `Signing & Capabilities`.
4. Enable `Automatically manage signing`.
5. Choose a Team.
6. If the bundle ID conflicts, change `com.bridge.app` to a unique value, for example `com.<yourname>.bridge`.

Notes:

- A free Apple ID can install to a local device for short-lived testing.
- A paid Apple Developer account is required for TestFlight, long-running distribution, and later CloudKit production work.
- Do not add iCloud/CloudKit capability for the single-device MVP unless you are explicitly starting the CloudKit milestone.

## 3. Connect iPhone

Use a cable for the first install. Wireless debugging is optional after the device is trusted.

On the iPhone:

1. Unlock the phone.
2. Tap Trust This Computer if prompted.
3. If Developer Mode is required, enable it in Settings and restart the phone.

In Xcode:

1. Choose the physical iPhone as the run destination.
2. Press `Cmd+R`.
3. If signing fails, fix Team or Bundle Identifier before changing code.

## 4. Trust Developer Certificate

If the app installs but will not open:

1. Open iPhone Settings.
2. Go to General.
3. Open VPN & Device Management.
4. Trust the developer certificate for the selected Apple ID.
5. Launch Bridge again.

## 5. Grant Runtime Permissions

On first launch, allow:

- Camera
- Location While Using
- Motion & Fitness / motion access if prompted

If a permission was denied:

1. Open iPhone Settings.
2. Find Bridge.
3. Enable Camera and Location.
4. Relaunch the app.

## 6. Capture Diagnostics

Keep Xcode open while testing.

Generate the repository diagnostics bundle:

```bash
./scripts/collect_diagnostics.sh
```

The script writes to `diagnostics/bridge-<timestamp>/`. Zip that directory together with screen recordings and Xcode console excerpts when reporting a failed test.
The bundle includes `preflight.txt`, which is the fastest way to see whether the Mac has full Xcode, the iPhoneOS SDK, and a compilable unsigned iOS target.
It also includes `git_revision.txt`, `git_status.txt`, and `git_diff_check.txt` so the failure can be tied back to the exact branch, commit, local changes, and whitespace/conflict-marker state that produced the device build.

Useful logs:

- App `诊断` tab export.
- Recent `诊断` events persist across app restart and keep the latest 200 entries, so export the report before clearing events even if you had to force quit Bridge.
- Placement details in the report include avatar reference state, WorldMap filename, location, heading, message preview, and `anchorInWorldMap`.
- Xcode console output.
- iPhone screen recording.
- Exact test case ID from `docs/iphone_mvp_test_plan.md`.
- Test location, lighting, and distance from original placement.
- Whether the Discover status showed relocalized before the avatar appeared.
- Whether the App `诊断` tab reported location permission, GPS, or heading availability issues.
- Whether the App `诊断` tab reported `scenePhase background` / `scenePhase foreground` during lock screen, app switch, or system interruption tests.
- Whether invalid local data cleanup reported `WorldMap 解码失败` or `WorldMap 缺少目标锚点` before treating Discover failure as an ARKit relocalization issue.

Useful console filters:

```text
ARSession
WorldMap
relocal
tracking
location
scenePhase
anchorInWorldMap
WorldMap 解码失败
WorldMap 缺少目标锚点
Bridge
```

## 7. Common Failures

| Symptom | Likely cause | First action |
| --- | --- | --- |
| Xcode cannot install | Signing or bundle ID conflict | Select Team and use a unique Bundle Identifier |
| App opens to black AR view | Camera permission or ARSession failure | Check iPhone permission and Xcode console |
| Scan never detects body | Unsupported device, poor lighting, distance issue | Confirm AR body tracking support, improve lighting, step back |
| Save world map fails | Mapping not good enough | Move slowly and scan more stable room features |
| Discover shows avatar too early | Relocalization false success | Record screen and logs; fix relocalization gating before feature work |
| Discover never relocalizes | Not at original spot, low visual overlap, weak map | Return to exact placement area and slowly scan original surfaces |
| Discover skips a saved placement | Missing avatar, missing/corrupt WorldMap, or WorldMap missing the expected anchor | Check `anchorInWorldMap` and cleanup summary in the App `诊断` tab |
| GPS sorting does not seem active | Location permission denied, system location off, or no GPS fix yet | Check the App `诊断` tab for location status messages |
| Avatar faces the wrong direction | Compass heading unavailable or manually adjusted heading was wrong | Check heading diagnostics, then adjust the Place heading slider and retry |
| Tap opens wrong card | Collision/hit-test routing issue | Record which avatar was tapped and which placement opened |

## 8. Stop Rule

Do not start CloudKit, VPS, moderation expansion, or backend work until the P0 section of `docs/iphone_mvp_test_plan.md` passes on one iPhone.
