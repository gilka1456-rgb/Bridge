# Bridge Web → iOS / CloudKit integration contract

This file is the handoff contract for the Mac/Xcode implementation. The Web
prototype defines product behavior; iOS remains the production app and the
only spatial-AR client.

## 1. Ownership and identity

- Never upload the literal local placeholder owner ID `"me"`.
- On iOS, derive a stable signed-in owner identifier from CloudKit user
  identity and persist it locally.
- Every cloud mutation must include that owner ID. Deletion, visibility
  changes and moderation must verify ownership server-side through CloudKit
  record ownership, not only through a client field.

## 2. Visibility has two independent controls

These controls must not be merged:

1. **Placement visibility** is set per placement by its owner.
   - `public`: other users may discover it.
   - `private`: only its owner may see/manage it.
   - Delete is permanent (or a cloud tombstone during sync).
   - Web prototype field `Placement.hidden == true` maps to iOS
     `Placement.visibility == .private`.
2. **Discover ownership filter** is a local viewer preference.
   - Setting: `discoverFilter` with `all / others / mine`.
   - It only filters the current user's Discover camera.
   - It does not change what anybody else can see.
   - Filter after nearby records are merged with the local cache:
     `visibility allows viewer && ownership matches discoverFilter`.

## 3. Drift mode

`driftMode` is a viewer preference, not a content visibility state.

When enabled:

- Hide the Friends/social interface.
- Placement detail exposes only placement-level Like.
- Scene records remain readable/shareable and may be liked, but their comment
  UI is hidden.
- Hide conversations and chat composition.
- Do not expose comment lists, comment creation, replies or comment
  reactions to that user.
- Do not deliver comment/social notifications to that user.
- Keep fetching/syncing comments normally as cache consistency requires.
- Other users who are not in drift mode can still see and comment on this
  user's public placements.

Turning drift mode off must immediately restore the social UI and existing
comments. Never delete or suppress cloud comments because an owner/viewer is
in drift mode.

## 4. Settings model

Persist these locally on iOS (AppStorage or a Codable settings file):

```text
nickname: String
driftMode: Bool = false
notifications: Bool = false
discoverFilter: DiscoverFilter = .all
```

- Notification UI may only show enabled after notification authorization is
  granted.
- Camera status comes from `AVCaptureDevice.authorizationStatus`.
- Location status comes from `CLLocationManager.authorizationStatus`.
- Permission actions must call the native request APIs and handle denied /
  restricted states by offering a link to system Settings.

## 5. Placement likes (different from comment likes)

Add a separate `PlacementLike` model. Do not reuse `CommentLike`.

Recommended CloudKit record:

```text
PlacementLikeRecord
  placementID: String (queryable)
  actorID: String (queryable)
  createdAt: Date
```

Use a deterministic record name such as
`"<placementUUID>:<actorID>"` (or a stable hash) so one account can only like
a placement once. Toggling Like saves/deletes this record. Displayed totals
come from CloudKit aggregation/query results; the local Web prototype's 0/1
count represents only the current device and is not a real global count.

## 6. Friends

The Web prototype stores a simple local list. Production iOS needs explicit
relationship state:

```text
FriendshipRecord
  requesterID: String (queryable)
  addresseeID: String (queryable)
  status: pending | accepted | blocked
  createdAt: Date
  updatedAt: Date
```

Do not treat a locally typed nickname as identity. Friend search/add must
resolve a real user profile first. Drift mode hides this interface but does
not silently delete existing friendships.

## 7. CloudKit records to add or complete

Existing records remain: `PlacementRecord`, `AvatarPoseRecord`,
`CommentRecord`, `CommentReactionRecord`, `CommentLikeRecord`.

Add:

- `UserProfileRecord`: `ownerID`, `nickname`, `createdAt`, `updatedAt`.
- `PlacementLikeRecord`: fields from section 5.
- `FriendshipRecord`: fields from section 6.
- `CapturedPhoto` is private local media created only by the Discover shutter:
  `id`, image asset, visible `placementIDs`, `locationLabel`, `discoverFilter`,
  `createdAt`. It is not uploaded until the user publishes it.
- `SceneRecord`: `ownerID`, `sourcePhotoID`, optional `placementID`/`avatarPoseID`, `title`,
  `caption`, `locationLabel`, image `CKAsset`, `createdAt`.
- `SceneRecordLike`: deterministic record per `recordID + actorID`.
- `SceneRecordComment`: `recordID`, `authorID`, `text`, `createdAt`.
- `ConversationRecord`: deterministic record for the two participant IDs.
- `ChatMessageRecord`: `conversationID`, `senderID`, `text`, `createdAt`,
  `readAt`; protect these records so only participants can read them.

Complete current CloudKit TODOs before claiming multi-user support:

- Nearby public placement query by indexed `location`.
- Upload/download avatar joints, views and orientation masks.
- Upload/download comments, replies, reactions and comment likes.
- Placement-like upsert/delete/count.
- Friendship request/accept/remove/block.
- Scene-record upload/feed query/like/comment and image asset lifecycle.
- Conversation membership checks, message sync and unread state.
- Local cache merge and retry queue for offline writes.
- Delete/tombstone propagation and ownership checks.

## 8. OrientationMask v2 contract

Web V2 scans no longer store the raw full-camera mask. Both clients must use
the same normalized body-space contract:

```text
OrientationMask
  azimuth: 0 | 90 | 180 | 270
  width: number
  height: number
  mask: string                 # unchanged base64 + Uint32 RLE
  normalized: true             # missing means legacy full-frame mask
  personAspect: number         # source person bounding-box width / height
  frameCount: number           # Web V2 currently fuses five stable frames
  quality: number              # 0...1 capture quality
```

Normalization rules are part of the data contract:

1. Binarize the person class and keep the largest connected component.
2. Close small holes, compute the person bounding box and preserve its aspect.
3. Scale the person to 90% of a 1:2 canvas height and center it horizontally.
4. Never stretch width independently from height.
5. Legacy masks without `normalized` must be normalized after decoding before
   visual-hull projection; do not rewrite the stored legacy record in place.

The current Web canvas is `128 x 256`. Consumers must rely on `width` and
`height`, not hard-code those values. iOS capture and `VisualHull.swift` must
mirror the normalization/projection semantics before cross-client avatar sync
is enabled. Existing RLE byte order and run semantics do not change.

## 9. Native UI acceptance criteria

- Use a five-item bottom tab bar in this order:
  `看见 / 虚像 / 放置(raised center action) / 记录 / 我的`.
- Scan is an internal flow of `虚像`, not a separate tab.
- Friends/messages and Settings are header actions, not bottom tabs.
- Discover shows only the AR camera/scene plus small floating controls.
- Tapping an entity opens a bottom sheet for that exact placement.
- Standard mode sheet: placement info, placement Like, comments/replies.
- Drift mode sheet: placement info and placement Like only.
- Discover includes `全部展示 / 只看别人 / 只看自己`, backed by
  `discoverFilter`, plus a shutter that composites the camera frame and AR
  virtual content.
- My Placements supports per-placement public/private and destructive delete.
- My contains separate `我的放置` and `我的照片` sections. `我的照片` is the
  private Discover photo library, not the public forum post list.
- `记录` is a photo forum. New posts can only select images from `我的照片`;
  arbitrary gallery uploads are not accepted.
- `CapturedPhoto.locationLabel` remains private. Publishing creates a separate
  post asset and a separately entered, coarse public `SceneRecord.locationLabel`.
  Reject street numbers, room/building identifiers and precise coordinates.
  Apply the shared takedown/report/blocking rules in `PRIVACY_POLICY.md`.
- Profile identity/editing belongs to `我的`; Settings contains only mode,
  notification, discover filtering, permissions and local-data controls.
- `虚像` does not create an AR/3D preview until the user selects an avatar.
- `放置` first asks the user to choose an avatar; only then should the AR
  camera session start. Leaving the placement flow clears that selection.
- A placement can create a scene record using `ARView.snapshot`; publishing a
  record must not alter or delete the source placement.
- Records use an image-card feed, support Like/comment/share, and preserve
  their captured image if the source placement is later deleted.
- Friends opens a conversation list with add-friend inside it. The local Web
  nickname prototype must become real CloudKit identity lookup on iOS.
- Settings includes drift, hide-own, notifications and live native permission
  states, but no duplicate profile card.
- Friends is absent while drift mode is enabled.
- Keep scan model output compatible with existing `AvatarPose`,
  `PoseView`, and `OrientationMask`; scan quality/tuning remains a Mac +
  physical-device task.

## 10. Required Mac validation order

1. Build existing project with Xcode 15+ and fix compile issues without
   changing the data semantics above.
2. Run local-only UI/state tests for visibility, hide-own and drift mode.
3. Validate camera/location/notification permission flows on a real iPhone.
4. Validate scan and visual-hull quality on device.
5. Validate `ARView.snapshot`, scene-record composition and native share
   sheet on device.
6. Configure CloudKit capability/schema, then implement multi-user likes,
   records, friends/chat, comments and nearby discovery.
7. Test with two different iCloud accounts. A single device cannot validate
   friend identity, chat privacy, received-like totals or cross-user
   visibility.

