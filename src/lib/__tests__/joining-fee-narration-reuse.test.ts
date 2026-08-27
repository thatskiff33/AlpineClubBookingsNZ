// #1931 (E5, item 15) — the referential-reuse contract, proven by SENTINEL,
// not string equality: the Xero invoice line's default description and the
// admin preview's defaultNarration must both be produced BY the shared
// buildJoiningFeeNarration function (in @/lib/joining-fee-narration). Mocking
// that module with a sentinel intercepts both call sites — if either surface
// re-authored the copy locally, its output would keep the real wording and
// fail these assertions.
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  narrationSpy,
  joiningFeeFindFirst,
  memberFindUnique,
  memberFindMany,
  assignmentFindMany,
  membershipTypeFindMany,
} = vi.hoisted(() => ({
  narrationSpy: vi.fn((label: string) => `SENTINEL-NARRATION(${label})`),
  joiningFeeFindFirst: vi.fn(),
  memberFindUnique: vi.fn(),
  memberFindMany: vi.fn(),
  assignmentFindMany: vi.fn(),
  membershipTypeFindMany: vi.fn(),
}));

vi.mock("@/lib/joining-fee-narration", () => ({
  buildJoiningFeeNarration: narrationSpy,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    joiningFee: { findFirst: joiningFeeFindFirst },
    member: { findUnique: memberFindUnique, findMany: memberFindMany },
    seasonalMembershipAssignment: { findMany: assignmentFindMany },
    membershipType: { findMany: membershipTypeFindMany, findFirst: vi.fn() },
  },
}));

// Minimal mocks so importing the Xero invoice line builder is side-effect-free.
vi.mock("@/lib/logger", () => ({ default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/xero-error-alert", () => ({ notifyXeroSyncError: vi.fn() }));
vi.mock("@/lib/xero-api-client", () => ({ callXeroApi: vi.fn(), getAuthenticatedXeroClient: vi.fn() }));
vi.mock("@/lib/xero-contacts", () => ({ findOrCreateXeroContact: vi.fn(), retryXeroWriteWithContactRepair: vi.fn() }));

import { getJoiningFeePreviewForMember } from "@/lib/joining-fee";
import { buildEntranceFeeLineItem } from "@/lib/xero-entrance-fee-invoices";

beforeEach(() => {
  vi.clearAllMocks();
  memberFindUnique.mockResolvedValue({ ageTier: "ADULT" });
  memberFindMany.mockResolvedValue([
    { id: "m1", firstName: "A", lastName: "B", email: "a@b.c", role: "MEMBER", ageTier: "ADULT" },
  ]);
  assignmentFindMany.mockResolvedValue([]);
  membershipTypeFindMany.mockResolvedValue([
    { id: "type-full", key: "FULL", name: "FULL", isActive: true, isBuiltIn: true, bookingBehavior: "MEMBER_RATE", subscriptionBehavior: "REQUIRED" },
  ]);
  joiningFeeFindFirst.mockResolvedValue({ amountCents: 10000, effectiveFrom: new Date("2026-01-01") });
});

describe("joining-fee narration referential reuse (sentinel)", () => {
  it("the Xero invoice line's default description comes FROM buildJoiningFeeNarration", () => {
    const line = buildEntranceFeeLineItem("Adult", 10000);

    expect(narrationSpy).toHaveBeenCalledWith("Adult");
    expect(line.description).toBe("SENTINEL-NARRATION(Adult)");
  });

  it("the preview's defaultNarration comes FROM the same function, matching the invoice line", async () => {
    const preview = await getJoiningFeePreviewForMember("m1", {
      // #3123 - `asOf` is required; this suite is about narration, not dates.
      asOf: new Date("2026-07-01T00:00:00.000Z"),
    });

    expect(narrationSpy).toHaveBeenCalledWith("Adult");
    expect(preview.defaultNarration).toBe("SENTINEL-NARRATION(Adult)");
    expect(preview.defaultAmountCents).toBe(10000);

    // Same call, same function object, same output as the invoice line.
    narrationSpy.mockClear();
    const line = buildEntranceFeeLineItem("Adult", 10000);
    expect(line.description).toBe(preview.defaultNarration);
    expect(narrationSpy).toHaveBeenCalledTimes(1);
  });
});
