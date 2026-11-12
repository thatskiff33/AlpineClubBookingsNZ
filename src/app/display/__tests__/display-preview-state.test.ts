// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";

import { readPreviewState } from "@/app/display/display-header-clock";

/*
  The header only simulates a real calendar day. A shape-only `2026-02-30`
  used to switch the clock to "simulating" a day the state route refuses.
*/
describe("readPreviewState", () => {
  afterEach(() => {
    window.history.pushState({}, "", "/display");
  });

  it("keeps a real calendar day as the simulated date", () => {
    window.history.pushState({}, "", "/display?preview=1&previewDate=2028-02-29");
    expect(readPreviewState()).toEqual({ isPreview: true, previewDate: "2028-02-29" });
  });

  it.each(["2026-02-30", "2026-8-1", "2026-08-01T00:00:00Z"])(
    "simulates nothing for %j",
    (value) => {
      window.history.pushState({}, "", `/display?preview=1&previewDate=${encodeURIComponent(value)}`);
      expect(readPreviewState()).toEqual({ isPreview: true, previewDate: null });
    },
  );
});
