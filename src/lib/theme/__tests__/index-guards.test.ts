import { describe, expect, it } from "vitest";
import { must } from "../index-guards";

describe("must", () => {
  it("returns the value unchanged when it is defined", () => {
    expect(must(0, "should not throw")).toBe(0);
    expect(must("", "should not throw")).toBe("");
    expect(must("hex", "should not throw")).toBe("hex");
  });

  it("throws the given message when the value is undefined", () => {
    expect(() => must(undefined, "no step at index 12")).toThrow("no step at index 12");
  });
});
