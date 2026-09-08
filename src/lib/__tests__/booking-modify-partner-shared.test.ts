import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/capacity", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/capacity");
  return {
    ...actual,
    checkCapacityForPartnerSharedAdmission: vi.fn(),
  };
});

import { checkCapacityForPartnerSharedAdmission } from "@/lib/capacity";
import { resolvePartnerSharedCapacity } from "@/lib/booking-modify-plan";
import { parseDateOnly } from "@/lib/date-only";
import { ApiError } from "@/lib/api-error";

const CHECK_IN = parseDateOnly("2026-08-10");
const CHECK_OUT = parseDateOnly("2026-08-12");

const okResult = {
  available: true,
  reason: null,
  minAvailable: 1,
  partnerSharedHeadroom: 1,
  nightDetails: [],
};

function range(memberId: string | null) {
  return { stayStart: CHECK_IN, stayEnd: CHECK_OUT, memberId };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(checkCapacityForPartnerSharedAdmission).mockResolvedValue(okResult);
});

describe("resolvePartnerSharedCapacity", () => {
  it("splits flagged member guests into sharers and passes the rest as ordinary", async () => {
    await resolvePartnerSharedCapacity({
      lodgeId: "lodge-a",
      rangeStart: CHECK_IN,
      rangeEnd: CHECK_OUT,
      proposedRanges: [range("m-partner"), range("m-sharer"), range(null)],
      partnerSharedGuests: [
        { memberId: "m-sharer", partnerMemberId: "m-partner" },
      ],
      excludeBookingId: "b1",
    });

    const [, , , ordinary, sharers, excludeBookingId] = vi.mocked(
      checkCapacityForPartnerSharedAdmission,
    ).mock.calls[0];
    expect(sharers).toEqual([
      {
        range: range("m-sharer"),
        memberId: "m-sharer",
        partnerMemberId: "m-partner",
      },
    ]);
    expect(ordinary).toEqual([range("m-partner"), range(null)]);
    expect(excludeBookingId).toBe("b1");
  });

  it("matches a duplicated member range once; later duplicates stay ordinary", async () => {
    await resolvePartnerSharedCapacity({
      lodgeId: "lodge-a",
      rangeStart: CHECK_IN,
      rangeEnd: CHECK_OUT,
      proposedRanges: [range("m-partner"), range("m-sharer"), range("m-sharer")],
      partnerSharedGuests: [
        { memberId: "m-sharer", partnerMemberId: "m-partner" },
      ],
      excludeBookingId: "b1",
    });

    const [, , , ordinary, sharers] = vi.mocked(
      checkCapacityForPartnerSharedAdmission,
    ).mock.calls[0];
    expect(sharers).toHaveLength(1);
    expect(ordinary).toEqual([range("m-partner"), range("m-sharer")]);
  });

  it("throws when the same member is flagged twice", async () => {
    await expect(
      resolvePartnerSharedCapacity({
        lodgeId: "lodge-a",
        rangeStart: CHECK_IN,
        rangeEnd: CHECK_OUT,
        proposedRanges: [range("m-partner"), range("m-sharer")],
        partnerSharedGuests: [
          { memberId: "m-sharer", partnerMemberId: "m-partner" },
          { memberId: "m-sharer", partnerMemberId: "m-other" },
        ],
        excludeBookingId: "b1",
      }),
    ).rejects.toThrow(/more than once/i);
    expect(checkCapacityForPartnerSharedAdmission).not.toHaveBeenCalled();
  });

  it("throws when a flagged sharer matches no proposed guest", async () => {
    await expect(
      resolvePartnerSharedCapacity({
        lodgeId: "lodge-a",
        rangeStart: CHECK_IN,
        rangeEnd: CHECK_OUT,
        proposedRanges: [range("m-partner")],
        partnerSharedGuests: [
          { memberId: "m-ghost", partnerMemberId: "m-partner" },
        ],
        excludeBookingId: "b1",
      }),
    ).rejects.toThrow(ApiError);
    expect(checkCapacityForPartnerSharedAdmission).not.toHaveBeenCalled();
  });
});
