import { describe, expect, it, vi } from "vitest";
import type { AvatarPose, CapturedPhoto, Placement, SceneRecord } from "../models/types";
import { LOCAL_OWNER_ID, LocalStore, StoragePersistenceError } from "./store";

const avatar = (id = "avatar-1"): AvatarPose => ({
  id,
  label: "测试虚像",
  style: "wraith",
  landmarks: [],
  views: [],
  schema: "mediapipe-33",
  createdAt: "2026-07-16T00:00:00.000Z",
});

const placement = (id = "placement-1", avatarPoseId = "avatar-1"): Placement => ({
  id,
  avatarPoseId,
  message: "你好",
  locationLabel: "滨江公园",
  rotationY: 0,
  offsetX: 0,
  offsetZ: 0,
  createdAt: "2026-07-16T00:00:00.000Z",
});

const photo = (id = "photo-1"): CapturedPhoto => ({
  id,
  mediaKey: `capture:${id}`,
  placementIds: ["placement-1"],
  locationLabel: "滨江公园",
  discoverFilter: "all",
  createdAt: "2026-07-16T00:01:00.000Z",
});

const record = (id = "record-1", sourcePhotoId = "photo-1"): SceneRecord => ({
  id,
  sourcePhotoId,
  placementId: "placement-1",
  avatarPoseId: "avatar-1",
  title: "记录",
  caption: "正文",
  locationLabel: "滨江公园",
  mediaKey: `post:${id}`,
  authorId: LOCAL_OWNER_ID,
  authorName: "我",
  createdAt: "2026-07-16T00:02:00.000Z",
});

describe("LocalStore integrity", () => {
  it("recovers from corrupted local data", () => {
    localStorage.setItem("bridge-core-snapshot-v1", "{broken");
    localStorage.setItem("bridge-core-captured-photos-v1", "not-json");

    const store = new LocalStore();

    expect(store.getAvatars()).toEqual([]);
    expect(store.getPlacements()).toEqual([]);
    expect(store.getCapturedPhotos()).toEqual([]);
  });

  it("rolls back an in-memory photo when persistence fails", () => {
    const store = new LocalStore();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });

    expect(() => store.addCapturedPhoto(photo())).toThrow(StoragePersistenceError);
    expect(store.getCapturedPhotos()).toEqual([]);
  });

  it("detaches historical photos and posts when deleting an avatar", () => {
    const store = new LocalStore();
    store.addAvatar(avatar());
    store.addPlacement(placement());
    store.addCapturedPhoto(photo());
    store.addSceneRecord(record());

    store.deleteAvatar("avatar-1");

    expect(store.getAvatars()).toEqual([]);
    expect(store.getPlacements()).toEqual([]);
    expect(store.getCapturedPhoto("photo-1")?.placementIds).toEqual([]);
    expect(store.getSceneRecord("record-1")).toMatchObject({
      avatarPoseId: undefined,
      placementId: undefined,
    });
  });

  it("requires a local source photo and prevents duplicate publishing", () => {
    const store = new LocalStore();
    expect(() => store.addSceneRecord(record())).toThrow("必须来自");

    store.addCapturedPhoto(photo());
    store.addSceneRecord(record());
    expect(() => store.addSceneRecord(record("record-2"))).toThrow("已经发布");
  });

  it("enforces drift mode for local comment writes", () => {
    const store = new LocalStore();
    store.addAvatar(avatar());
    store.addPlacement(placement());
    store.updateSettings({ driftMode: true });

    expect(() => store.addComment("placement-1", "评论", null)).toThrow("漂流模式");
  });

  it("applies discover ownership filters", () => {
    localStorage.setItem("bridge-core-snapshot-v1", JSON.stringify({
      avatars: [avatar()],
      placements: [
        placement("mine"),
        { ...placement("other"), ownerId: "demo-user" },
      ],
    }));
    const store = new LocalStore();

    store.updateSettings({ discoverFilter: "others" });
    expect(store.getDiscoverPlacements().map((item) => item.id)).toEqual(["other"]);
    store.updateSettings({ discoverFilter: "mine" });
    expect(store.getDiscoverPlacements().map((item) => item.id)).toEqual(["mine"]);
  });
});
