import { describe, expect, it, vi } from "vitest";
import { PageScope } from "./page-scope";

describe("PageScope", () => {
  it("invalidates stale asynchronous work after disposal", () => {
    const scope = new PageScope();
    const action = vi.fn();

    expect(scope.runIfActive(action)).toBe(true);
    scope.dispose();
    expect(scope.signal.aborted).toBe(true);
    expect(scope.runIfActive(action)).toBe(false);
    expect(action).toHaveBeenCalledTimes(1);
  });
});
