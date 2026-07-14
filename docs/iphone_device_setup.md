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

Useful logs:

- Xcode console output.
- iPhone screen recording.
- Exact test case ID from `docs/iphone_mvp_test_plan.md`.
- Test location, lighting, and distance from original placement.
- Whether the Discover status showed relocalized before the avatar appeared.

Useful console filters:

```text
ARSession
WorldMap
relocal
tracking
location
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
| Tap opens wrong card | Collision/hit-test routing issue | Record which avatar was tapped and which placement opened |

## 8. Stop Rule

Do not start CloudKit, VPS, moderation expansion, or backend work until the P0 section of `docs/iphone_mvp_test_plan.md` passes on one iPhone.
