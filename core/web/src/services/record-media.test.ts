import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RecordMediaStore } from "./record-media";

let store: RecordMediaStore;

beforeEach(() => {
  store = new RecordMediaStore(`bridge-media-test-${crypto.randomUUID()}`);
});

afterEach(async () => {
  await store.clear();
  store.dispose();
});

describe("RecordMediaStore ownership", () => {
  it("copies a post asset independently from its captured photo", async () => {
    expect(await store.save("capture:1", "data:text/plain;base64,YnJpZGdl")).toBe(true);
    expect(await store.copy("capture:1", "post:1")).not.toBeNull();

    await store.delete("capture:1");

    expect(await store.load("capture:1")).toBeNull();
    expect(await store.load("post:1")).not.toBeNull();
  });

  it("purges only media not referenced by metadata", async () => {
    await store.save("capture:keep", "data:text/plain;base64,a2VlcA==");
    await store.save("post:orphan", "data:text/plain;base64,b3JwaGFu");

    expect(await store.purgeOrphans(new Set(["capture:keep"]))).toEqual(["post:orphan"]);
    expect(await store.keys()).toEqual(["capture:keep"]);
  });
});
