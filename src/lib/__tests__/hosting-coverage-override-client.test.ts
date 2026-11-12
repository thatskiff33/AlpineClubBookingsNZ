import { describe, expect, it } from "vitest";

import {
  hostingCoverageMutationSignature,
  readHostingCoverageOverridePrompt,
} from "@/lib/hosting-coverage-override-client";

const VALID = {
  error: "Review the exact affected booking.",
  code: "SAME_OWNER_COVERAGE_OVERRIDE_REQUIRED",
  requiresOverrideReason: true,
  strandedStateKey: `v1:${"a".repeat(64)}`,
  strandedBookings: [
    {
      bookingId: "private-id",
      reference: "ACB-1234",
      lodgeName: "Example Lodge",
      nights: ["2026-08-01"],
    },
  ],
};

describe("hosting coverage override client contract", () => {
  it("accepts only the complete typed 409 prompt", () => {
    expect(readHostingCoverageOverridePrompt(VALID)).toEqual({
      message: VALID.error,
      strandedStateKey: VALID.strandedStateKey,
      strandedBookings: VALID.strandedBookings,
    });
    for (const invalid of [
      null,
      { ...VALID, code: "SOMETHING_ELSE" },
      { ...VALID, requiresOverrideReason: false },
      { ...VALID, error: "" },
      { ...VALID, strandedStateKey: "bad" },
      { ...VALID, strandedBookings: [] },
      {
        ...VALID,
        strandedBookings: [{ ...VALID.strandedBookings[0], reference: "" }],
      },
      {
        ...VALID,
        strandedBookings: [{ ...VALID.strandedBookings[0], nights: ["tomorrow"] }],
      },
      {
        ...VALID,
        strandedBookings: [{ ...VALID.strandedBookings[0], nights: ["2026-02-30"] }],
      },
    ]) {
      expect(readHostingCoverageOverridePrompt(invalid)).toBeNull();
    }
  });

  it("signs the complete mutation deterministically and includes notify choice", () => {
    expect(
      hostingCoverageMutationSignature({
        notifyMember: false,
        checkOut: "2026-08-03",
        nested: { b: 2, a: 1, omitted: undefined },
      }),
    ).toBe(
      hostingCoverageMutationSignature({
        nested: { a: 1, b: 2 },
        checkOut: "2026-08-03",
        notifyMember: false,
      }),
    );
    expect(
      hostingCoverageMutationSignature({ notifyMember: false }),
    ).not.toBe(hostingCoverageMutationSignature({ notifyMember: true }));
  });
});
