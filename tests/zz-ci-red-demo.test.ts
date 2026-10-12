// Temporary: proves CI goes red when npm test fails (issue #14). Reverted before merge.
import { describe, it, expect } from "vitest";

describe("ci red demo", () => {
  it("fails on purpose", () => {
    expect(1).toBe(2);
  });
});
