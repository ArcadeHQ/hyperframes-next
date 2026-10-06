import { describe, expect, it } from "vitest";
import { isJumpSeek } from "./frameCapture.js";

describe("isJumpSeek", () => {
  it("treats a fresh session's first seek mid-timeline as a jump", () => {
    expect(isJumpSeek(undefined, 22.4)).toBe(true);
  });

  it("treats a fresh session's first seek at the composition top as a step", () => {
    expect(isJumpSeek(undefined, 0)).toBe(false);
    expect(isJumpSeek(undefined, 1 / 60)).toBe(false);
  });

  it("treats frame steps as steps at 24/30/60fps", () => {
    for (const fps of [24, 30, 60]) {
      expect(isJumpSeek(22.4, 22.4 + 1 / fps)).toBe(false);
    }
  });

  it("treats multi-second forward and backward moves as jumps", () => {
    expect(isJumpSeek(1.0, 22.4)).toBe(true);
    expect(isJumpSeek(22.4, 1.0)).toBe(true);
  });
});
