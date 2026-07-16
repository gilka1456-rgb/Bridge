import { describe, expect, it } from "vitest";
import { binarizePersonMask, decodePersonMaskRLE, encodePersonMaskRLE } from "./segmentation";

describe("person mask encoding", () => {
  it("binarizes MediaPipe category masks", () => {
    expect([...binarizePersonMask(new Uint8Array([0, 1, 2, 1]))]).toEqual([0, 1, 0, 1]);
  });

  it.each([
    [[]],
    [[0]],
    [[1]],
    [[0, 0, 1, 1, 0, 1]],
    [[1, 1, 0, 0, 1, 0, 1]],
  ] satisfies Array<[number[]]>)("round trips %j", (values) => {
    const mask = new Uint8Array(values);
    expect([...decodePersonMaskRLE(encodePersonMaskRLE(mask), mask.length)]).toEqual(values);
  });
});
