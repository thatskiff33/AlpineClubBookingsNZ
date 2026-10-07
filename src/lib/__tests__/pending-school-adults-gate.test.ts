import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { isPendingSchoolAdultsWriteEnabled } from "@/lib/pending-school-adults-gate";

describe("pending school-adult write gate", () => {
  it("defaults disabled when either acknowledgement is absent", () => {
    expect(isPendingSchoolAdultsWriteEnabled({})).toBe(false);
    expect(
      isPendingSchoolAdultsWriteEnabled({ PENDING_SCHOOL_ADULTS_ENABLED: "1" }),
    ).toBe(false);
    expect(
      isPendingSchoolAdultsWriteEnabled({
        BLUE_GREEN_OLD_APP_AND_WORKERS_STOPPED: "1",
      }),
    ).toBe(false);
  });

  it("enables only when both operator acknowledgements are exact", () => {
    expect(
      isPendingSchoolAdultsWriteEnabled({
        PENDING_SCHOOL_ADULTS_ENABLED: "1",
        BLUE_GREEN_OLD_APP_AND_WORKERS_STOPPED: "1",
      }),
    ).toBe(true);
  });

  it("fails closed for malformed, spaced, and truthy-looking values", () => {
    for (const value of ["true", "yes", " 1", "1 ", "0", ""] as const) {
      expect(
        isPendingSchoolAdultsWriteEnabled({
          PENDING_SCHOOL_ADULTS_ENABLED: value,
          BLUE_GREEN_OLD_APP_AND_WORKERS_STOPPED: "1",
        }),
      ).toBe(false);
    }
  });
});
