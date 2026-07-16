import { describe, expect, it } from "vitest";
import { defaultPublicLocation, validatePublicLocation } from "./privacy";

describe("public location privacy", () => {
  it("keeps broad public places", () => {
    expect(defaultPublicLocation("滨江公园")).toBe("滨江公园");
    expect(validatePublicLocation(" 滨江公园 ")).toBe("滨江公园");
  });

  it.each(["人民路123号", "2栋301室", "31.2304, 121.4737"])(
    "rejects precise location %s",
    (location) => {
      expect(defaultPublicLocation(location)).toBe("附近");
      expect(() => validatePublicLocation(location)).toThrow("公开地点不能包含");
    },
  );

  it("uses a safe fallback and caps labels", () => {
    expect(validatePublicLocation("")).toBe("附近");
    expect(validatePublicLocation("一个非常非常非常非常非常非常非常非常非常非常长的公园名称"))
      .toHaveLength(24);
  });
});
