// #1931 (E5): joining-fee resolution is type-driven (Family = the Family type
// only, composition heuristic removed), the N/A-tier exemption is evaluated
// BEFORE type resolution, INFANT folds onto the CHILD amount, and the preview's
// default narration is produced by the SAME builder the Xero invoice line uses
// (item 15 referential-reuse contract).
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  joiningFeeFindFirst,
  memberFindUnique,
  memberFindMany,
  assignmentFindMany,
  membershipTypeFindMany,
  membershipTypeFindFirst,
} = vi.hoisted(() => ({
  joiningFeeFindFirst: vi.fn(),
  memberFindUnique: vi.fn(),
  memberFindMany: vi.fn(),
  assignmentFindMany: vi.fn(),
  membershipTypeFindMany: vi.fn(),
  membershipTypeFindFirst: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    joiningFee: { findFirst: joiningFeeFindFirst },
    member: { findUnique: memberFindUnique, findMany: memberFindMany },
    seasonalMembershipAssignment: { findMany: assignmentFindMany },
    membershipType: { findMany: membershipTypeFindMany, findFirst: membershipTypeFindFirst },
  },
}));

// Keep the current season deterministic so policy resolution is stable.

// Minimal mocks so importing the Xero invoice line builder is side-effect-free.
vi.mock("@/lib/logger", () => ({ default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/xero-error-alert", () => ({ notifyXeroSyncError: vi.fn() }));
vi.mock("@/lib/xero-api-client", () => ({ callXeroApi: vi.fn(), getAuthenticatedXeroClient: vi.fn() }));
vi.mock("@/lib/xero-contacts", () => ({ findOrCreateXeroContact: vi.fn(), retryXeroWriteWithContactRepair: vi.fn() }));

import {
  buildJoiningFeeNarration,
  deriveJoiningFeeCategory,
  getJoiningFeePreviewForInputs,
  getJoiningFeePreviewForMember,
  JOINING_FEE_EXEMPT_MESSAGE,
  joiningFeeCategoryLabel,
  resolveMemberJoiningFeeClassification,
} from "@/lib/joining-fee";
import { buildEntranceFeeLineItem } from "@/lib/xero-entrance-fee-invoices";

const builtInType = (id: string, key: string) => ({
  id, key, name: key, isActive: true, isBuiltIn: true,
  bookingBehavior: "MEMBER_RATE", subscriptionBehavior: "REQUIRED",
});

// joiningFee.findFirst driven by the queried age tier: an age-tier row for
// per-tier types, a flat NULL row for the Family type.
function stubJoiningFee(byTier: Record<string, number>, flat: number | null) {
  joiningFeeFindFirst.mockImplementation((args: { where: { ageTier: string | null } }) => {
    const tier = args.where.ageTier;
    if (tier == null) return Promise.resolve(flat == null ? null : { amountCents: flat, effectiveFrom: new Date("2026-02-01") });
    const amount = byTier[tier];
    return Promise.resolve(amount == null ? null : { amountCents: amount, effectiveFrom: new Date("2026-01-01") });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  memberFindMany.mockResolvedValue([]);
  assignmentFindMany.mockResolvedValue([]);
  membershipTypeFindMany.mockResolvedValue([]);
});

/**
 * The club's day, supplied explicitly (#3123): the joining-fee preview's `asOf`
 * is required now, because defaulting it read the environment's zone and quoted
 * a fee schedule row a day before it took effect.
 */
const CLUB_TODAY = new Date("2026-07-01T00:00:00.000Z");

describe("deriveJoiningFeeCategory", () => {
  it("is type-driven for Family and age-driven otherwise (INFANT folds to CHILD)", () => {
    expect(deriveJoiningFeeCategory("FAMILY", "ADULT")).toBe("FAMILY");
    expect(deriveJoiningFeeCategory("FULL", "YOUTH")).toBe("YOUTH");
    expect(deriveJoiningFeeCategory("FULL", "CHILD")).toBe("CHILD");
    expect(deriveJoiningFeeCategory("FULL", "INFANT")).toBe("CHILD");
    expect(deriveJoiningFeeCategory("ASSOCIATE", "ADULT")).toBe("ADULT");
  });
});

describe("resolveMemberJoiningFeeClassification", () => {
  it("refuses a transaction client with no explicit season", async () => {
    /*
      A CONCURRENCY GUARD, tested directly because nothing else can reach it.

      This function is three hops below `approveMemberApplication`
      (`enqueueXeroEntranceFeeInvoiceOperation` -> `getEntranceFeeContext` -> here),
      inside a transaction holding `pg_advisory_xact_lock('member-application:<id>')`
      plus one `member-lifecycle:<memberId>` lock per MAP target. Resolving the
      club's zone here is an UNCACHED read on the GLOBAL Prisma client, so a second
      pool connection under those locks — and `readPersistedClubTimeZoneRow` swallows
      every throw, so a pool timeout would resolve the season from the environment
      seed and pick the `JoiningFee` row whose amount lands on an IMMUTABLE invoice.

      The approval threads its pre-transaction season, so the refusal is unreachable
      from any current caller — which is exactly why removing it SURVIVED the
      approval suite (measured). A guard whose only protection is that today's
      callers happen to be correct needs its own test, or the next caller reopens
      the hole silently.
    */
    const txLike = { member: { findUnique: memberFindUnique } } as never;

    await expect(
      resolveMemberJoiningFeeClassification("m1", txLike),
    ).rejects.toThrow(/needs an explicit seasonYear when it is given a transaction client/);
    // It refuses BEFORE reading anything, so no query is made under the caller's locks.
    expect(memberFindUnique).not.toHaveBeenCalled();
  });

  it("accepts a transaction client when the season is supplied", async () => {
    memberFindUnique.mockResolvedValue({ ageTier: "NOT_APPLICABLE" });
    const txLike = { member: { findUnique: memberFindUnique } } as never;

    await expect(
      resolveMemberJoiningFeeClassification("org1", txLike, 2026),
    ).resolves.toMatchObject({ exempt: true });
  });

  it("exempts N/A members BEFORE resolving a membership type", async () => {
    memberFindUnique.mockResolvedValue({ ageTier: "NOT_APPLICABLE" });

    const result = await resolveMemberJoiningFeeClassification("org1");

    expect(result.exempt).toBe(true);
    expect(result.exemptReason).toBe(JOINING_FEE_EXEMPT_MESSAGE);
    // Type resolution never ran.
    expect(memberFindMany).not.toHaveBeenCalled();
    expect(assignmentFindMany).not.toHaveBeenCalled();
  });

  it("classifies a FULL adult as ADULT (role default, no season assignment)", async () => {
    memberFindUnique.mockResolvedValue({ ageTier: "ADULT" });
    memberFindMany.mockResolvedValue([{ id: "m1", firstName: "A", lastName: "B", email: "a@b.c", role: "MEMBER", ageTier: "ADULT" }]);
    membershipTypeFindMany.mockResolvedValue([builtInType("type-full", "FULL")]);

    const result = await resolveMemberJoiningFeeClassification("m1");

    expect(result.exempt).toBe(false);
    expect(result.category).toBe("ADULT");
    expect(result.membershipTypeId).toBe("type-full");
    expect(result.ageTier).toBe("ADULT");
  });

  it("classifies an assigned Family member as FAMILY regardless of age", async () => {
    memberFindUnique.mockResolvedValue({ ageTier: "ADULT" });
    memberFindMany.mockResolvedValue([{ id: "m1", firstName: "A", lastName: "B", email: "a@b.c", role: "MEMBER", ageTier: "ADULT" }]);
    assignmentFindMany.mockResolvedValue([
      { memberId: "m1", seasonYear: 2026, membershipType: builtInType("type-family", "FAMILY") },
    ]);

    const result = await resolveMemberJoiningFeeClassification("m1");

    expect(result.category).toBe("FAMILY");
    expect(result.membershipTypeId).toBe("type-family");
  });
});

describe("getJoiningFeePreviewForMember", () => {
  it("returns the ADULT amount + narration that the invoice line would produce (referential reuse)", async () => {
    memberFindUnique.mockResolvedValue({ ageTier: "ADULT" });
    memberFindMany.mockResolvedValue([{ id: "m1", firstName: "A", lastName: "B", email: "a@b.c", role: "MEMBER", ageTier: "ADULT" }]);
    membershipTypeFindMany.mockResolvedValue([builtInType("type-full", "FULL")]);
    stubJoiningFee({ ADULT: 10000 }, null);

    const preview = await getJoiningFeePreviewForMember("m1", { asOf: CLUB_TODAY });

    expect(preview.exempt).toBe(false);
    expect(preview.defaultAmountCents).toBe(10000);
    expect(preview.source).toBe("SCHEDULE");
    expect(preview.effectiveFrom).toBe("2026-01-01");

    // Byte-equality here is the copy-level check; the PROOF that both
    // surfaces call the same function BY REFERENCE (not two identical
    // strings) is the sentinel-spy test in
    // joining-fee-narration-reuse.test.ts, which mocks
    // @/lib/joining-fee-narration and asserts both outputs are the sentinel.
    const label = joiningFeeCategoryLabel("ADULT");
    const invoiceLine = buildEntranceFeeLineItem(label, 10000);
    expect(invoiceLine.description).toBe(buildJoiningFeeNarration(label));
    expect(preview.defaultNarration).toBe(invoiceLine.description);
  });

  it("resolves the flat family fee for an assigned Family member (INFANT and ADULT alike)", async () => {
    memberFindUnique.mockResolvedValue({ ageTier: "INFANT" });
    memberFindMany.mockResolvedValue([{ id: "m1", firstName: "A", lastName: "B", email: "a@b.c", role: "MEMBER", ageTier: "INFANT" }]);
    assignmentFindMany.mockResolvedValue([
      { memberId: "m1", seasonYear: 2026, membershipType: builtInType("type-family", "FAMILY") },
    ]);
    stubJoiningFee({}, 20000);

    const preview = await getJoiningFeePreviewForMember("m1", { asOf: CLUB_TODAY });
    expect(preview.defaultAmountCents).toBe(20000);
    expect(preview.defaultNarration).toBe(buildJoiningFeeNarration("Family"));
  });

  it("gracefully skips a type with no joining-fee rows (NON_MEMBER/SCHOOL)", async () => {
    memberFindUnique.mockResolvedValue({ ageTier: "ADULT" });
    memberFindMany.mockResolvedValue([{ id: "s1", firstName: "S", lastName: "S", email: "s@s.s", role: "SCHOOL", ageTier: "ADULT" }]);
    membershipTypeFindMany.mockResolvedValue([builtInType("type-school", "SCHOOL")]);
    stubJoiningFee({}, null);

    const preview = await getJoiningFeePreviewForMember("s1", { asOf: CLUB_TODAY });
    expect(preview.exempt).toBe(false);
    expect(preview.defaultAmountCents).toBeNull();
    expect(preview.source).toBe("NONE");
  });
});

describe("getJoiningFeePreviewForInputs", () => {
  it("resolves from raw type key + age tier and threads a transaction client", async () => {
    membershipTypeFindFirst.mockResolvedValue({ id: "type-full" });
    // A distinct fake tx store proves the optional client is threaded through.
    const txJoiningFee = vi.fn().mockResolvedValue({ amountCents: 7500, effectiveFrom: new Date("2026-03-01") });
    const tx = {
      membershipType: { findFirst: vi.fn().mockResolvedValue({ id: "type-full" }), findUnique: vi.fn() },
      joiningFee: { findFirst: txJoiningFee },
    } as never;

    const preview = await getJoiningFeePreviewForInputs(
      { membershipTypeKey: "FULL", ageTier: "YOUTH" },
      { store: tx, asOf: CLUB_TODAY },
    );

    expect(preview.defaultAmountCents).toBe(7500);
    expect(preview.defaultNarration).toBe(buildJoiningFeeNarration("Youth"));
    expect(txJoiningFee).toHaveBeenCalled();
    // The global prisma joiningFee mock was never touched.
    expect(joiningFeeFindFirst).not.toHaveBeenCalled();
  });

  it("exempts a NOT_APPLICABLE age tier in raw-inputs mode", async () => {
    const preview = await getJoiningFeePreviewForInputs(
      { membershipTypeKey: "SCHOOL", ageTier: "NOT_APPLICABLE" },
      { asOf: CLUB_TODAY },
    );
    expect(preview.exempt).toBe(true);
    expect(preview.exemptReason).toBe(JOINING_FEE_EXEMPT_MESSAGE);
    expect(preview.defaultAmountCents).toBeNull();
  });
});
