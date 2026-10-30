import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  settings: { findUnique: vi.fn() },
  coverage: { findMany: vi.fn() },
  subscriptions: { findMany: vi.fn() },
  members: { findMany: vi.fn() },
  membershipTypes: { findMany: vi.fn() },
  charges: { findMany: vi.fn() },
  // #2147 FINDING 1: family-level dedup reads FamilyGroupMember rows for members
  // already billed (live invoice / active coverage) and groups them for sizes.
  familyGroupMembers: { findMany: vi.fn(), groupBy: vi.fn() },
  // #2161 (D2): active operator family markers read by the billing builder.
  familyMarkers: { findMany: vi.fn() },
  // #2109 FIX-4d: the closed-loop test runs the REAL getSubscriptionItemCodes
  // resolver over these fee-component rows. getSubscriptionItemCodes folds in the
  // flat subscriptionIncome item code via the module-INTERNAL
  // getResolvedAccountMapping (which reads xeroAccountMapping directly, not the
  // mocked export), so the resolver's item code is supplied here.
  feeComponents: { findMany: vi.fn() },
  accountMapping: { findUnique: vi.fn() },
  // CT-4 group F1 (#2870): the default decision date is now the CLUB's calendar
  // day, read from this row. Present so the suite can set a zone the environment
  // does NOT hold and see the difference.
  clubTimeSettings: { findUnique: vi.fn() },
  // The approval path (`queueApprovedMembershipSubscriptionCharges`) writes
  // through a transaction; with no members in scope the only writers it reaches
  // are the exception ones.
  billingExceptions: { updateMany: vi.fn(), upsert: vi.fn() },
  // `INV-LOCK-001`: the confirm step takes a global advisory lock inside its
  // transaction, so the double has to answer the raw call.
  executeRaw: vi.fn(),
  audit: vi.fn(),
  enqueueChargeOperation: vi.fn(),
  effectiveFee: vi.fn(),
  // Subscription-category decoupling: the category-axis fee resolver.
  effectiveCategoryFee: vi.fn(),
  familyMode: vi.fn(),
  mapping: vi.fn(),
}));

vi.mock("@/lib/authoritative-fees", () => ({
  getEffectiveMembershipAnnualFee: mocks.effectiveFee,
  getEffectiveSubscriptionCategoryFee: mocks.effectiveCategoryFee,
  getFamilyBillingMode: mocks.familyMode,
}));
// Keep getResolvedAccountMapping mocked (billing relies on the mock), but expose
// the REAL getSubscriptionItemCodes so the #2109 FIX-4d closed-loop test can
// assert the codes billing stamps are a subset of the detection resolver output.
vi.mock("@/lib/xero-mappings", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/xero-mappings");
  return {
    ...actual,
    getResolvedAccountMapping: mocks.mapping,
  };
});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    membershipSubscriptionBillingSettings: mocks.settings,
    membershipSubscriptionChargeCoverage: mocks.coverage,
    memberSubscription: mocks.subscriptions,
    member: mocks.members,
    membershipType: mocks.membershipTypes,
    membershipSubscriptionCharge: mocks.charges,
    familyGroupMember: mocks.familyGroupMembers,
    familyGroupSeasonInvoiceMarker: mocks.familyMarkers,
    membershipAnnualFeeComponent: mocks.feeComponents,
    xeroAccountMapping: mocks.accountMapping,
    clubTimeSettings: mocks.clubTimeSettings,
    membershipBillingException: mocks.billingExceptions,
    $transaction: (
      run: (tx: unknown) => unknown,
    ) => run(billingTransactionClient()),
  },
}));

vi.mock("@/lib/audit", () => ({ createAuditLog: mocks.audit }));
vi.mock("@/lib/xero-subscription-invoices", () => ({
  enqueueMembershipSubscriptionChargeOperation: mocks.enqueueChargeOperation,
}));

/**
 * The delegates the confirm step reaches inside its transaction when NO member is
 * in scope. Deliberately narrow: a wider double would let a future change write
 * somewhere this suite is not watching and still pass.
 */
function billingTransactionClient() {
  return {
    $executeRaw: mocks.executeRaw,
    membershipBillingException: mocks.billingExceptions,
    membershipSubscriptionChargeCoverage: mocks.coverage,
    memberSubscription: mocks.subscriptions,
    membershipSubscriptionCharge: mocks.charges,
    member: mocks.members,
    membershipType: mocks.membershipTypes,
    familyGroupMember: mocks.familyGroupMembers,
    familyGroupSeasonInvoiceMarker: mocks.familyMarkers,
    membershipAnnualFeeComponent: mocks.feeComponents,
    membershipSubscriptionBillingSettings: mocks.settings,
    xeroAccountMapping: mocks.accountMapping,
  };
}

import {
  buildComponentLineDescription,
  buildSubscriptionBillingPreview,
  calculateMembershipCharge,
  queueApprovedMembershipSubscriptionCharges,
} from "@/lib/membership-subscription-billing";
import { withTimeZoneAsync } from "@/lib/__tests__/helpers/timezone";
import { defaultMembershipTypeKeyForRole } from "@/lib/membership-types";
import { getSubscriptionItemCodes } from "@/lib/xero-mappings";
import { stableDigest } from "@/lib/stable-digest";
import {
  __setFinancialYearEndMonthForTesting,
  DEFAULT_FINANCIAL_YEAR_END_MONTH,
} from "@/lib/financial-year";

/**
 * A stored `@db.Date` date of birth: the calendar day, at UTC midnight
 * (INV-DATE-024).
 *
 * THESE FIXTURES USED TO BE `new Date(2016, 3, 1)`, host-local midnight — the
 * spelling INV-DATE-024 names as forbidden for this column, and one that means a
 * DIFFERENT day for a run on a UTC container and a run on this repository's own
 * `Pacific/Auckland` pin. `computeAge`'s stored-day guard now refuses it (#3082),
 * which is how thirteen of them were found: they had been passing on CI and
 * describing an age-tier price boundary with a value no writer produces.
 */
function storedDateOfBirth(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

function fee(overrides: Record<string, unknown> = {}) {
  return {
    id: "fee-1",
    amountCents: 12_001,
    billingBasis: "PER_MEMBER",
    prorationRule: "REMAINING_MONTHS_INCLUSIVE",
    effectiveFrom: new Date("2026-04-01T00:00:00.000Z"),
    effectiveTo: null,
    ...overrides,
  };
}

function member(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    firstName: `First-${id}`,
    lastName: "Member",
    email: `${id}@example.test`,
    role: "USER",
    // #2067: the annual fee resolves per the member's age tier (default ADULT).
    ageTier: "ADULT",
    seasonalMembershipAssignments: [{
      membershipType: {
        id: "type-1",
        key: "FULL",
        name: "Full",
        subscriptionBehavior: "REQUIRED",
        annualFees: [fee()],
      },
    }],
    familyGroupMemberships: [],
    ...overrides,
  };
}

function familyMembership(recipientOverrides: Record<string, unknown> = {}) {
  return {
    familyGroupId: "family-1",
    familyGroup: {
      billingMembership: {
        familyGroupId: "family-1",
        member: {
          id: "billing-1",
          firstName: "Bill",
          lastName: "Member",
          email: "bill@example.test",
          active: true,
          archivedAt: null,
          ...recipientOverrides,
        },
      },
    },
  };
}

function comp(overrides: Record<string, unknown> = {}) {
  return { label: "Component", amountCents: 0, prorate: true, xeroAccountCode: null, xeroItemCode: null, sortOrder: 0, ...overrides };
}

function familyMembershipFor(familyGroupId: string, recipientOverrides: Record<string, unknown> = {}) {
  return {
    familyGroupId,
    familyGroup: {
      billingMembership: {
        familyGroupId,
        member: {
          id: `billing-${familyGroupId}`,
          firstName: "Bill",
          lastName: "Member",
          email: `bill-${familyGroupId}@example.test`,
          active: true,
          archivedAt: null,
          ...recipientOverrides,
        },
      },
    },
  };
}

const OLDER_CHARGE = { id: "charge-older", createdAt: new Date("2026-05-01T00:00:00.000Z") };
const NEWER_CHARGE = { id: "charge-newer", createdAt: new Date("2026-06-01T00:00:00.000Z") };

describe("membership subscription billing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.settings.findUnique.mockResolvedValue({ invoiceDueDays: 30 });
    mocks.coverage.findMany.mockResolvedValue([]);
    mocks.subscriptions.findMany.mockResolvedValue([]);
    mocks.members.findMany.mockResolvedValue([]);
    mocks.membershipTypes.findMany.mockResolvedValue([]);
    mocks.charges.findMany.mockResolvedValue([]);
    mocks.familyGroupMembers.findMany.mockResolvedValue([]);
    mocks.familyGroupMembers.groupBy.mockResolvedValue([]);
    mocks.familyMarkers.findMany.mockResolvedValue([]);
    mocks.feeComponents.findMany.mockResolvedValue([]);
    mocks.effectiveFee.mockResolvedValue(fee());
    // Subscription-category decoupling: no category fee by default — every
    // existing test's members have no subscriptionCategory on their
    // assignment, so this resolver is never even reached by them.
    mocks.effectiveCategoryFee.mockResolvedValue(null);
    mocks.familyMode.mockResolvedValue("BILL_FAMILY_VIA_BILLING_MEMBER");
    mocks.mapping.mockResolvedValue({ code: "203", itemCode: "SUB", codeExplicitlyConfigured: true });
    mocks.clubTimeSettings.findUnique.mockResolvedValue(null);
    mocks.billingExceptions.updateMany.mockResolvedValue({ count: 0 });
    mocks.billingExceptions.upsert.mockResolvedValue({});
    mocks.executeRaw.mockResolvedValue(0);
    mocks.audit.mockResolvedValue(undefined);
    mocks.enqueueChargeOperation.mockResolvedValue(undefined);
    __setFinancialYearEndMonthForTesting(DEFAULT_FINANCIAL_YEAR_END_MONTH);
  });

  /**
   * THE DEFAULT DECISION DATE IS THE CLUB'S DAY, NOT THE ENVIRONMENT'S.
   *
   * This is the money half of CT-4 group F1 (#2870). With no explicit decision
   * date this value bounds the season a subscription charge — and the Xero invoice
   * queued from it — is written against, and the charge is immutable once created.
   * It used to come from `getTodayDateOnly()`, i.e. from `APP_TIME_ZONE`, which is
   * the container's environment and not the club's persisted zone. A deployment
   * that sets only `TZ` had the two disagree by up to a day.
   *
   * THE ASSERTION IS DISCRIMINATING BY CONSTRUCTION, which is the thing this epic
   * keeps failing to achieve elsewhere. `APP_TIME_ZONE` resolves to
   * `Pacific/Auckland` under test, so the fixture persists `America/Denver` — a
   * zone the environment does NOT hold — and at the frozen instant
   * (2026-07-01T00:00:00Z) the two zones are on DIFFERENT calendar days: Auckland
   * is on 1 July, Denver still on 30 June. Any implementation that reads the
   * environment, the host, or the UTC clock answers 2026-07-01 and fails.
   */
  describe("the default decision date", () => {
    // One block below pins its own instant to put the club's day on a season edge;
    // the root hook re-freezes the DEFAULT rather than a suite's pin, so hand it
    // back explicitly (`AGENTS.md`).
    afterEach(() => {
      vi.setSystemTime(new Date("2026-07-01T00:00:00.000Z"));
    });

    it("is the club's own calendar day, from the persisted zone", async () => {
      mocks.clubTimeSettings.findUnique.mockResolvedValue({
        timeZone: "America/Denver",
      });

      const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026 });

      expect(preview.decisionDate).toBe("2026-06-30");
    });

    it("moves with the persisted zone rather than staying on the environment's day", async () => {
      // The same instant, a club east of Greenwich: now the club really is on
      // 1 July. Pinning both halves is what stops the assertion above passing for
      // a wrong reason — a hard-coded "yesterday" would fail here.
      mocks.clubTimeSettings.findUnique.mockResolvedValue({
        timeZone: "Pacific/Auckland",
      });

      const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026 });

      expect(preview.decisionDate).toBe("2026-07-01");
    });

    /**
     * THE HIGHEST-CONSEQUENCE LINE IN THIS LANE, and it needs TWO axes moved at
     * once to be testable at all.
     *
     * Approving a membership application reaches
     * `queueApprovedMembershipSubscriptionCharges` with no decision date, and the
     * season it derives is written into an IMMUTABLE subscription charge and the
     * Xero invoice queued from it. Two different mistakes produce a wrong season
     * there, and a fixture that moves only one axis is blind to the other.
     *
     * AXIS 1, THE ZONE. Reading `APP_TIME_ZONE` instead of the club's persisted
     * setting. The first version of this test persisted `Pacific/Auckland`, which
     * is exactly what `APP_TIME_ZONE` resolves to under vitest with no `TZ` — so
     * persisted, environment and a hard-coded `"Pacific/Auckland"` were the same
     * string. Measured by a review lens: swapping the read for the environment
     * zone, and swapping it for that literal, each SURVIVED all tests. The club
     * zone here is therefore `Pacific/Kiritimati` (UTC+14), which the environment
     * does not hold.
     *
     * AXIS 2, THE HOST. Once the decision date is minted as the club's own day at
     * UTC midnight, a host-LOCAL read of it gives the same answer on any host at or
     * east of Greenwich — including the CI runner, which resolves `UTC`. That is
     * the class owner decision 3 (#2870) recorded as uncatchable without moving the
     * host, so `process.env.TZ` is pinned behind Greenwich.
     *
     * ONE INSTANT COVERS BOTH. At 11:00Z on 30 June, with a June year-end:
     *   - the club (UTC+14) is on 1 July — the FIRST day of season 2026;
     *   - `APP_TIME_ZONE` (UTC+12) is still on 30 June — season 2025;
     *   - UTC is on 30 June — season 2025;
     *   - and a Denver host reading the minted `2026-07-01T00:00:00Z` with local
     *     getters sees 30 June — season 2025.
     * So every one of the four wrong implementations answers 2025 and the correct
     * one answers 2026.
     *
     * The kill is loud rather than subtle: 2025 fails
     * `buildSubscriptionBillingPreview`'s own bounds check, so the approval throws
     * `Decision date must fall within membership year 2025.` instead of billing
     * quietly against the wrong year.
     */
    it("bills an approval in the club's season — not the environment's, the host's, or UTC's", async () => {
      __setFinancialYearEndMonthForTesting(6);
      mocks.clubTimeSettings.findUnique.mockResolvedValue({
        timeZone: "Pacific/Kiritimati",
      });
      vi.setSystemTime(new Date("2026-06-30T11:00:00.000Z"));

      await withTimeZoneAsync("America/Denver", async () => {
        const result = await queueApprovedMembershipSubscriptionCharges({
          memberIds: [],
          approvedByMemberId: "admin-1",
        });
        expect(result.chargeIds).toEqual([]);
      });

      // The season the preview was actually built for: 2026, the year the club's
      // own 1 July belongs to under a June year-end.
      expect(mocks.billingExceptions.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ seasonYear: 2026 }),
        }),
      );
    });

    it("refuses to default it inside a transaction, where the zone read would sit under the season lock", async () => {
      // The zone is a database read; `getTodayDateOnly()` was pure. Both
      // in-module callers that pass `store` hold `pg_advisory_xact_lock` on the
      // season and both already supply the date, so this refusal turns a
      // coincidence into a contract rather than changing any live behaviour.
      await expect(
        buildSubscriptionBillingPreview({
          seasonYear: 2026,
          store: billingTransactionClient() as never,
        }),
      ).rejects.toThrow(/must be given its decision date/);
    });

    it("refuses to resolve the year-end inside a transaction, where it could call Xero under the season lock (#3116)", async () => {
      // Resolving the financial year-end reads MembershipLockoutSettings and,
      // with no admin override, CALLS XERO for the organisation's accounting
      // year. Under a held `pg_advisory_xact_lock` that is a provider call
      // inside a transaction, which this repository forbids outright. A
      // transactional caller has a preview in hand and passes its frozen value.
      //
      // The decision date is supplied here so this asserts the year-end guard
      // specifically, rather than passing for the decision-date reason above.
      await expect(
        buildSubscriptionBillingPreview({
          seasonYear: 2026,
          decisionDate: new Date("2026-04-01T00:00:00.000Z"),
          store: billingTransactionClient() as never,
        }),
      ).rejects.toThrow(/must be given its financial year-end month/);
    });

    it("accepts an explicit year-end inside a transaction and names the season from it (#3116)", async () => {
      // The other side of the guard: given the value, a transactional preview
      // builds - and the description follows the year-end it was handed, not the
      // process cache.
      const preview = await buildSubscriptionBillingPreview({
        seasonYear: 2026,
        decisionDate: new Date("2026-04-01T00:00:00.000Z"),
        yearEndMonth: 12,
        store: billingTransactionClient() as never,
      });
      expect(preview.yearEndMonth).toBe(12);
    });

    it("still honours an explicit decision date", async () => {
      mocks.clubTimeSettings.findUnique.mockResolvedValue({
        timeZone: "America/Denver",
      });

      const preview = await buildSubscriptionBillingPreview({
        seasonYear: 2026,
        decisionDate: new Date("2026-05-15T00:00:00.000Z"),
      });

      expect(preview.decisionDate).toBe("2026-05-15");
    });
  });

  // #2109 FIX-4d closed loop: drive the REAL billing line-builder for a type +
  // components fixture, collect the item codes it stamps onto invoice lines, and
  // assert every one is in the detection resolver's output (derived from the
  // same fee-component data) — so look-through detection can never miss a code
  // billing can stamp. Replaces the former hardcoded-array assertion.
  it("stamps only item codes the detection resolver also matches (closed loop)", async () => {
    const componentCodes = ["FULL-ADULT", "FULL-YOUTH"];
    const annual = fee({
      components: [
        comp({ label: "Adult", amountCents: 9_000, xeroItemCode: "FULL-ADULT", sortOrder: 0 }),
        comp({ label: "Youth", amountCents: 3_000, xeroItemCode: "FULL-YOUTH", sortOrder: 1 }),
      ],
    });
    mocks.effectiveFee.mockResolvedValue(annual);
    mocks.mapping.mockResolvedValue({ code: "203", itemCode: "SUBS", codeExplicitlyConfigured: true });
    mocks.members.findMany.mockResolvedValue([member("m1")]);
    // The same component codes + flat fallback back the detection resolver.
    mocks.feeComponents.findMany.mockResolvedValue(
      componentCodes.map((xeroItemCode) => ({ xeroItemCode })),
    );
    mocks.accountMapping.findUnique.mockResolvedValue({ code: "203", itemCode: "SUBS" });

    const preview = await buildSubscriptionBillingPreview({
      seasonYear: 2026,
      decisionDate: new Date("2026-04-01T00:00:00.000Z"),
    });

    // Codes the billing pipeline actually stamped — the entry-level flat code
    // and every component-line code (both get persisted onto Xero lines).
    const stamped = new Set<string>();
    for (const entry of preview.entries) {
      if (entry.xeroItemCode) stamped.add(entry.xeroItemCode);
      for (const component of entry.components) {
        if (component.xeroItemCode) stamped.add(component.xeroItemCode);
      }
    }
    // The component overrides plus the flat fallback must all appear.
    expect(stamped).toEqual(new Set([...componentCodes, "SUBS"]));

    const detectionSet = new Set(await getSubscriptionItemCodes());
    for (const code of stamped) {
      expect(detectionSet.has(code)).toBe(true);
    }
  });

  it("handles January-start full-year and inclusive proration bounds", () => {
    __setFinancialYearEndMonthForTesting(12);
    expect(calculateMembershipCharge({
      annualAmountCents: 12_000,
      prorationRule: "NONE",
      seasonYear: 2026,
      decisionDate: new Date("2026-01-01T00:00:00.000Z"),
    })).toMatchObject({
      amountCents: 12_000,
      coveredMonths: 12,
      coverageStart: new Date("2026-01-01T00:00:00.000Z"),
      coverageEnd: new Date("2026-12-31T00:00:00.000Z"),
    });
    expect(calculateMembershipCharge({
      annualAmountCents: 12_000,
      prorationRule: "REMAINING_MONTHS_INCLUSIVE",
      seasonYear: 2026,
      decisionDate: new Date("2026-10-15T00:00:00.000Z"),
    })).toMatchObject({ amountCents: 3_000, coveredMonths: 3 });
  });

  it("charges a full year for NONE and applies inclusive-month half-up cent proration", () => {
    expect(calculateMembershipCharge({
      annualAmountCents: 12_001,
      prorationRule: "NONE",
      seasonYear: 2026,
      decisionDate: new Date("2026-11-15T00:00:00.000Z"),
    })).toMatchObject({ amountCents: 12_001, coveredMonths: 12 });

    expect(calculateMembershipCharge({
      annualAmountCents: 12_001,
      prorationRule: "REMAINING_MONTHS_INCLUSIVE",
      seasonYear: 2026,
      decisionDate: new Date("2026-07-31T00:00:00.000Z"),
    })).toMatchObject({ amountCents: 9_001, coveredMonths: 9 });

    expect(calculateMembershipCharge({
      annualAmountCents: 1,
      prorationRule: "REMAINING_MONTHS_INCLUSIVE",
      seasonYear: 2026,
      decisionDate: new Date("2026-04-01T00:00:00.000Z"),
    })).toMatchObject({ amountCents: 1, coveredMonths: 12 });
  });

  it("rejects decisions outside the selected membership year", () => {
    expect(() => calculateMembershipCharge({
      annualAmountCents: 100,
      prorationRule: "NONE",
      seasonYear: 2026,
      decisionDate: new Date("2026-03-31T00:00:00.000Z"),
    })).toThrow("within membership year");
  });

  it("plans per-member charges and freezes configured due days", async () => {
    mocks.settings.findUnique.mockResolvedValue({ invoiceDueDays: 45 });
    mocks.members.findMany.mockResolvedValue([member("m1")]);
    const preview = await buildSubscriptionBillingPreview({
      seasonYear: 2026,
      decisionDate: new Date("2026-07-13T00:00:00.000Z"),
    });
    expect(preview).toMatchObject({ dueDays: 45, totalCents: 9_001 });
    expect(preview.entries[0]).toMatchObject({
      billingBasis: "PER_MEMBER",
      annualAmountCents: 12_001,
      chargedAmountCents: 9_001,
      coveredMonths: 9,
      recipient: { id: "m1" },
      coveredMembers: [{ id: "m1" }],
      xeroAccountCode: "203",
      xeroItemCode: "SUB",
    });
  });

  it("never invoices a subscription already PAID — manual mark-paid rows with no charge coverage (#1944)", async () => {
    // A manually marked-paid member has status PAID but NO charge-coverage row
    // (they never went through Xero billing). The sweep keys "already handled"
    // off coverage rows, so without the PAID guard this member would be
    // re-invoiced. Pin: they are skipped and produce no charge entry.
    mocks.members.findMany.mockResolvedValue([member("manual-paid"), member("owes")]);
    mocks.coverage.findMany.mockResolvedValue([]); // no coverage rows for anyone
    mocks.subscriptions.findMany.mockResolvedValue([{ memberId: "manual-paid" }]); // PAID
    const preview = await buildSubscriptionBillingPreview({
      seasonYear: 2026,
      decisionDate: new Date("2026-07-13T00:00:00.000Z"),
    });
    expect(preview.entries).toHaveLength(1);
    expect(preview.entries[0].coveredMembers).toEqual([{ id: "owes", name: "First-owes Member" }]);
    expect(preview.entries.some((entry) =>
      entry.coveredMembers.some((covered) => covered.id === "manual-paid"),
    )).toBe(false);
  });

  it("skips a member holding a live Xero invoice (invoiced-but-unpaid) and surfaces them under alreadyInvoiced (#2147 D1/D3)", async () => {
    // The bug: an invoiced-but-unpaid member (real xeroInvoiceId, status
    // UNPAID/OVERDUE, NO charge-coverage row because they were billed by the
    // older Xero-sync path) passed both the coverage and PAID guards and was
    // re-billed. They must now be skipped AND listed with their invoice number.
    mocks.members.findMany.mockResolvedValue([member("invoiced-unpaid"), member("owes")]);
    mocks.coverage.findMany.mockResolvedValue([]); // no coverage rows at all
    mocks.subscriptions.findMany.mockResolvedValue([
      { memberId: "invoiced-unpaid", status: "OVERDUE", xeroInvoiceId: "xi-1", xeroInvoiceNumber: "INV-100", member: { firstName: "Iva", lastName: "Owe" } },
    ]);
    const preview = await buildSubscriptionBillingPreview({
      seasonYear: 2026,
      decisionDate: new Date("2026-07-13T00:00:00.000Z"),
    });
    expect(preview.entries).toHaveLength(1);
    expect(preview.entries[0].coveredMembers).toEqual([{ id: "owes", name: "First-owes Member" }]);
    expect(preview.entries.some((entry) => entry.coveredMembers.some((c) => c.id === "invoiced-unpaid"))).toBe(false);
    expect(preview.alreadyInvoiced).toEqual([
      { memberId: "invoiced-unpaid", memberName: "Iva Owe", xeroInvoiceNumber: "INV-100", status: "OVERDUE" },
    ]);
  });

  it("keeps a manually marked-paid member (PAID, null xeroInvoiceId) skipped and OUT of alreadyInvoiced (#2147 regression)", async () => {
    // The dedup predicate is ADDITIVE: a manual-PAID (cash, no invoice) member
    // is skipped by the PAID clause, but has no invoice number to show, so they
    // must NOT appear in the alreadyInvoiced list.
    mocks.members.findMany.mockResolvedValue([member("manual-paid"), member("owes")]);
    mocks.coverage.findMany.mockResolvedValue([]);
    mocks.subscriptions.findMany.mockResolvedValue([
      { memberId: "manual-paid", status: "PAID", xeroInvoiceId: null, xeroInvoiceNumber: null, member: { firstName: "First-manual-paid", lastName: "Member" } },
    ]);
    const preview = await buildSubscriptionBillingPreview({
      seasonYear: 2026,
      decisionDate: new Date("2026-07-13T00:00:00.000Z"),
    });
    expect(preview.entries).toHaveLength(1);
    expect(preview.entries[0].coveredMembers).toEqual([{ id: "owes", name: "First-owes Member" }]);
    expect(preview.alreadyInvoiced).toEqual([]);
  });

  it("re-bills a member whose only coverage claim was released after a void (#2147)", async () => {
    // A released coverage row (releasedAt set) is excluded from the skip-set
    // query, so the member is billable again. The billing query passes
    // releasedAt: null, so a released row simply never appears in alreadyCovered.
    mocks.members.findMany.mockResolvedValue([member("re-billable")]);
    mocks.coverage.findMany.mockResolvedValue([]); // released rows filtered out by releasedAt: null
    mocks.subscriptions.findMany.mockResolvedValue([]); // link nulled by the void release
    const preview = await buildSubscriptionBillingPreview({
      seasonYear: 2026,
      decisionDate: new Date("2026-07-13T00:00:00.000Z"),
    });
    expect(preview.alreadyCoveredMemberIds).toEqual([]);
    expect(preview.entries).toHaveLength(1);
    expect(preview.entries[0].coveredMembers).toEqual([{ id: "re-billable", name: "First-re-billable Member" }]);
    // The coverage skip-set query only counts ACTIVE (releasedAt IS NULL) claims.
    expect(mocks.coverage.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ releasedAt: null }),
    }));
  });

  it("produces one visible exception and no invoice charges when subscriptionIncome is not explicitly configured", async () => {
    mocks.mapping.mockResolvedValue({ code: "203", itemCode: null, codeExplicitlyConfigured: false });
    mocks.members.findMany.mockResolvedValue([member("m1"), member("m2")]);
    const preview = await buildSubscriptionBillingPreview({
      seasonYear: 2026,
      decisionDate: new Date("2026-07-13T00:00:00.000Z"),
    });
    expect(preview.entries).toHaveLength(0);
    expect(preview.exceptions).toHaveLength(1);
    expect(preview.exceptions[0]).toMatchObject({
      code: "MISSING_XERO_ACCOUNT_MAPPING",
      memberId: null,
      context: { affectedChargeCount: 2 },
    });
  });

  it("groups same-family per-family coverage under the explicit active recipient", async () => {
    const annual = fee({ billingBasis: "PER_FAMILY", prorationRule: "NONE" });
    mocks.effectiveFee.mockResolvedValue(annual);
    const assignment = {
      membershipType: {
        id: "type-1", key: "FAMILY", name: "Family", subscriptionBehavior: "REQUIRED", annualFees: [annual],
      },
    };
    mocks.members.findMany.mockResolvedValue([
      member("m1", { seasonalMembershipAssignments: [assignment], familyGroupMemberships: [familyMembership()] }),
      member("m2", { seasonalMembershipAssignments: [assignment], familyGroupMemberships: [familyMembership()] }),
    ]);
    const preview = await buildSubscriptionBillingPreview({
      seasonYear: 2026,
      decisionDate: new Date("2026-04-01T00:00:00.000Z"),
    });
    expect(preview.entries).toHaveLength(1);
    expect(preview.entries[0]).toMatchObject({
      billingBasis: "PER_FAMILY",
      familyGroupId: "family-1",
      recipient: { id: "billing-1" },
    });
    expect(preview.entries[0].coveredMembers.map((row) => row.id)).toEqual(["m1", "m2"]);
  });

  it("does not create a second family invoice after the effective fee row rolls over and a late member joins", async () => {
    const annual = fee({ id: "fee-new", billingBasis: "PER_FAMILY", prorationRule: "NONE" });
    mocks.effectiveFee.mockResolvedValue(annual);
    mocks.charges.findMany.mockResolvedValue([{
      id: "charge-existing",
      familyGroupId: "family-1",
      membershipTypeId: "type-1",
      coverage: [],
    }]);
    mocks.members.findMany.mockResolvedValue([
      member("late", {
        familyGroupMemberships: [familyMembership()],
      }),
    ]);
    const preview = await buildSubscriptionBillingPreview({
      seasonYear: 2026,
      decisionDate: new Date("2026-08-01T00:00:00.000Z"),
      memberIds: ["late"],
    });
    expect(preview.entries).toHaveLength(0);
    expect(preview.exceptions).toEqual([
      expect.objectContaining({
        code: "FAMILY_ALREADY_BILLED",
        memberId: "late",
        context: expect.objectContaining({
          existingFamilyChargeId: "charge-existing",
          membershipAnnualFeeId: "fee-new",
        }),
      }),
    ]);
  });

  // Filter-aware mock: applies the query's where.status (`not` or `notIn`) to
  // a fixture, as the real database would, so a test sees exactly the rows the
  // filter keeps.
  function chargesMatchingStatusFilter<T extends { status: string }>(fixture: T[]) {
    return (args?: { where?: { status?: { not?: string; notIn?: string[] } } }) => {
      const excluded = [
        ...(args?.where?.status?.notIn ?? []),
        ...(args?.where?.status?.not ? [args.where.status.not] : []),
      ];
      return Promise.resolve(fixture.filter((charge) => !excluded.includes(charge.status)));
    };
  }

  /**
   * A family charge as the preview's query selects it, with its covered
   * subscriptions: [name, status now, status the close recorded]. An omitted
   * close status is a close made before the column existed (read as PAID).
   */
  function familyCharge(
    status: string,
    coveredStatuses: Array<[string, string] | [string, string, string | null] | [string, string, string | null, string]> = [],
    overrides: Record<string, unknown> = {},
  ) {
    return {
      id: `charge-${status.toLowerCase()}`,
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
      familyGroupId: "family-1",
      membershipTypeId: "type-1",
      billingBasis: "PER_FAMILY",
      status,
      // The fourth element is the family the covered member is in NOW (default:
      // still this one). The member id is the subscription's (#4110 review F5).
      coverage: coveredStatuses.map(([memberName, subscriptionStatus, statusAtClose, nowInFamily]) => ({
        memberName,
        subscriptionStatusAtClose: statusAtClose ?? null,
        subscription: {
          memberId: memberName,
          status: subscriptionStatus,
          member: { billingFamilyGroupId: null as string | null, familyGroupMemberships: [{ familyGroupId: nowInFamily ?? "family-1" }] },
        },
      })),
      ...overrides,
    };
  }

  async function previewFamily(
    charges: Array<ReturnType<typeof familyCharge>>,
    memberIds?: string[],
    // Per-type (and per-tier) fee, for a holder on another type or tier (#4110 review round 6).
    feeForType?: (membershipTypeId: string, ageTier: string | null) => unknown,
    // The family members the preview reads (default: the one "re-billable").
    previewedMembers?: string[],
  ) {
    const annual = fee({ id: "fee-new", billingBasis: "PER_FAMILY", prorationRule: "NONE" });
    if (feeForType) {
      mocks.effectiveFee.mockImplementation(async ({ membershipTypeId, ageTier }: { membershipTypeId: string; ageTier: string | null }) =>
        feeForType(membershipTypeId, ageTier) ?? annual);
    } else {
      mocks.effectiveFee.mockResolvedValue(annual);
    }
    mocks.charges.findMany.mockImplementation(chargesMatchingStatusFilter(charges));
    mocks.coverage.findMany.mockResolvedValue([]); // released by the void or the close
    mocks.subscriptions.findMany.mockResolvedValue([]); // the member being billed is not settled
    mocks.members.findMany.mockResolvedValue((previewedMembers ?? ["re-billable"]).map((id) =>
      member(id, { familyGroupMemberships: [familyMembership()] })));
    return buildSubscriptionBillingPreview({
      seasonYear: 2026,
      decisionDate: new Date("2026-08-01T00:00:00.000Z"),
      ...(memberIds ? { memberIds } : {}),
    });
  }

  it("re-bills a new-system PER_FAMILY family once its charge is VOIDED (#2147): nobody paid it", async () => {
    const preview = await previewFamily([familyCharge("VOIDED", [["Bill Member", "NOT_INVOICED"]])]);
    expect(preview.entries).toHaveLength(1);
    expect(preview.entries[0]).toMatchObject({ billingBasis: "PER_FAMILY", familyGroupId: "family-1", recipient: { id: "billing-1" } });
    expect(preview.exceptions).toEqual([]);
    // The query leaves only VOIDED out; a closed charge is read and judged.
    expect(mocks.charges.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: { not: "VOIDED" } }),
    }));
  });

  it("a closed family whose covered members are all still settled stays billed: a NEW joiner raises FAMILY_ALREADY_BILLED (#4110 regression)", async () => {
    const preview = await previewFamily(
      [familyCharge("NOT_REQUIRED", [["Bill Member", "PAID"], ["Cub Member", "NOT_REQUIRED"]])],
      ["re-billable"],
    );
    expect(preview.entries).toHaveLength(0);
    expect(preview.exceptions).toEqual([
      expect.objectContaining({ code: "FAMILY_ALREADY_BILLED", context: expect.objectContaining({ existingFamilyChargeId: "charge-not_required" }) }),
    ]);
  });

  it("an exempt member moved from NOT_REQUIRED to NOT_INVOICED after the close reversed no payment: the family stays billed, with no warning (#4110 review F1)", async () => {
    // An officer re-saved the exempt member's REQUIRED-type assignment, and the
    // reconcile flipped their NOT_REQUIRED row; the parent's payment stands.
    const preview = await previewFamily(
      // "re-billable" is the member being previewed: covered while exempt, now
      // needing a subscription.
      [familyCharge("NOT_REQUIRED", [["Bill Member", "PAID", "PAID"], ["re-billable", "NOT_INVOICED", "NOT_REQUIRED"]])],
      ["re-billable"],
    );
    expect(preview.entries).toHaveLength(0);
    // Never silently unbilled: the officer is asked to decide (#4110 decision
    // 4), with exactly the two choices and no advice to unpay anyone.
    expect(preview.exceptions).toEqual([
      expect.objectContaining({
        code: "CLOSED_FAMILY_MEMBER_NEEDS_DECISION",
        memberId: "re-billable",
        message: "First-re-billable Member was not required to pay when the family's Full charge was closed as already paid, and now needs a subscription. The family is not billed again. Decide how to bill First-re-billable Member: if the family fee already covers everyone in the family, mark them Paid; otherwise invoice just the difference in Xero by hand.",
        context: expect.objectContaining({ existingFamilyChargeId: "charge-not_required", reason: "EXEMPT_AT_CLOSE" }),
      }),
    ]);
    expect(preview.exceptions[0]!.message).not.toMatch(/unpaid|reverse/i);
  });

  it("keys the exempt-at-close member on the subscription's member, not the coverage snapshot a merge leaves stale (#4110 review F5)", async () => {
    const charge = familyCharge("NOT_REQUIRED", [["Bill Member", "PAID", "PAID"], ["re-billable", "NOT_INVOICED", "NOT_REQUIRED"]]);
    // A member merge keeps the coverage row's own memberId as the merged-away id.
    Object.assign(charge.coverage[1]!, { memberId: "merged-away" });
    const preview = await previewFamily([charge], ["re-billable"]);
    expect(preview.exceptions).toEqual([
      expect.objectContaining({ code: "CLOSED_FAMILY_MEMBER_NEEDS_DECISION", memberId: "re-billable" }),
    ]);
  });

  it("counts a covered member in two families only through their BILLING family, the main loop's rule (#4110 review F3)", async () => {
    const twoFamilies = (billingFamilyGroupId: string) => {
      const charge = familyCharge("NOT_REQUIRED", [["Bill Member", "PAID", "PAID"], ["Kid Member", "NOT_INVOICED", "PAID"]]);
      charge.coverage[1]!.subscription.member = {
        billingFamilyGroupId,
        familyGroupMemberships: [{ familyGroupId: "family-1" }, { familyGroupId: "family-2" }],
      };
      return charge;
    };
    // Billed through family-2: the reversal is not family-1's, which stays billed.
    const elsewhere = await previewFamily([twoFamilies("family-2")], ["re-billable"]);
    expect(elsewhere.entries).toHaveLength(0);
    expect(elsewhere.exceptions).toEqual([expect.objectContaining({ code: "FAMILY_ALREADY_BILLED" })]);
    // Billed through family-1: the reversal is family-1's, which is billed again.
    const here = await previewFamily([twoFamilies("family-1")]);
    expect(here.entries).toHaveLength(1);
    expect(here.exceptions.map((item) => item.code)).toEqual(["CLOSED_FAMILY_PARTLY_REVERSED"]);
  });

  it("a covered member who moved to another family and was then reversed does not re-bill the family they left (#4110 review F2)", async () => {
    const preview = await previewFamily(
      [familyCharge("NOT_REQUIRED", [["Bill Member", "PAID", "PAID"], ["Moved Member", "NOT_INVOICED", "PAID", "family-2"]])],
      ["re-billable"],
    );
    expect(preview.entries).toHaveLength(0);
    expect(preview.exceptions).toEqual([
      expect.objectContaining({ code: "FAMILY_ALREADY_BILLED", memberId: "re-billable", context: expect.not.objectContaining({ reason: expect.anything() }) }),
    ]);
  });

  const OLDER = OLDER_CHARGE;
  const NEWER = NEWER_CHARGE;

  it("two closed charges, the newest wins (owner, 16 Oct 2026): a reversal under the OLDER charge re-bills nothing, and the officer is asked to decide for that member (#4110 decision 5)", async () => {
    const preview = await previewFamily([
      // "re-billable" is the member previewed: paid under the older charge, since reversed.
      familyCharge("NOT_REQUIRED", [["re-billable", "NOT_INVOICED", "PAID"]], OLDER),
      familyCharge("NOT_REQUIRED", [["Bill Member", "PAID", "PAID"]], NEWER),
    ], ["re-billable"]);
    expect(preview.entries).toHaveLength(0);
    expect(preview.exceptions).toEqual([
      expect.objectContaining({
        code: "CLOSED_FAMILY_MEMBER_NEEDS_DECISION",
        memberId: "re-billable",
        context: expect.objectContaining({ existingFamilyChargeId: "charge-newer", reason: "REVERSED_UNDER_OLDER_CHARGE" }),
      }),
    ]);
  });

  it("two closed charges, the newest wins: a reversal under the NEWEST re-bills the family, and a payment still standing under the older one is flagged (owner decisions 1 and 5; review round 4 F-B)", async () => {
    const preview = await previewFamily([
      familyCharge("NOT_REQUIRED", [["Bill Member", "PAID", "PAID"]], OLDER),
      familyCharge("NOT_REQUIRED", [["Kid Member", "NOT_INVOICED", "PAID"]], NEWER),
    ]);
    expect(preview.entries).toHaveLength(1);
    expect(preview.exceptions).toEqual([
      expect.objectContaining({
        code: "CLOSED_FAMILY_PARTLY_REVERSED",
        context: { closedChargeId: "charge-newer", reversedMemberNames: ["Kid Member"] },
      }),
    ]);
  });

  it("flags the partial reversal when the reversed member was re-billed and reversed again, and the other payment stands under the older charge (review round 4 F-B)", async () => {
    // C1 covered A and B; A was reversed and re-billed on C2, which was closed;
    // then A was reversed again. B's payment, under C1, still stands.
    const preview = await previewFamily([
      familyCharge("NOT_REQUIRED", [["A Member", "NOT_INVOICED", "PAID"], ["B Member", "PAID", "PAID"]], OLDER),
      familyCharge("NOT_REQUIRED", [["A Member", "NOT_INVOICED", "PAID"]], NEWER),
    ]);
    expect(preview.entries).toHaveLength(1);
    expect(preview.exceptions.map((item) => item.code)).toEqual(["CLOSED_FAMILY_PARTLY_REVERSED"]);
  });

  it("skips, with no exception, a covered member who is still settled — a tier-exempt child still NOT_REQUIRED (review round 4 F-A)", async () => {
    const preview = await previewFamily(
      [familyCharge("NOT_REQUIRED", [["Bill Member", "PAID", "PAID"], ["re-billable", "NOT_REQUIRED", "NOT_REQUIRED"]])],
      ["re-billable"],
    );
    expect(preview.entries).toHaveLength(0);
    expect(preview.exceptions).toEqual([]);
  });

  it("asks the officer to decide for a member exempt at an OLDER closed charge's close who now owes (review round 4 F-D)", async () => {
    const preview = await previewFamily([
      familyCharge("NOT_REQUIRED", [["Bill Member", "PAID", "PAID"], ["re-billable", "NOT_INVOICED", "NOT_REQUIRED"]], OLDER),
      familyCharge("NOT_REQUIRED", [["Bill Member", "PAID", "PAID"]], NEWER),
    ], ["re-billable"]);
    expect(preview.entries).toHaveLength(0);
    expect(preview.exceptions).toEqual([
      expect.objectContaining({
        code: "CLOSED_FAMILY_MEMBER_NEEDS_DECISION",
        memberId: "re-billable",
        context: expect.objectContaining({ existingFamilyChargeId: "charge-newer", reason: "EXEMPT_AT_CLOSE" }),
      }),
    ]);
  });

  it("decides the same whatever order the family charges arrive in: same plan, same token (#4110 review F4)", async () => {
    const charges = () => [
      familyCharge("NOT_REQUIRED", [["re-billable", "NOT_INVOICED", "PAID"]], OLDER),
      familyCharge("NOT_REQUIRED", [["Bill Member", "PAID", "PAID"], ["Cub Member", "NOT_INVOICED", "NOT_REQUIRED"]], NEWER),
    ];
    const inOrder = await previewFamily(charges(), ["re-billable"]);
    const reversedOrder = await previewFamily(charges().reverse(), ["re-billable"]);
    expect(reversedOrder.exceptions).toEqual(inOrder.exceptions);
    // A confirm re-reads the rows in whatever order the database returns them;
    // the token must not change, or it reads as "preview changed".
    expect(reversedOrder.confirmationToken).toBe(inOrder.confirmationToken);
    expect(mocks.charges.findMany).toHaveBeenCalledWith(expect.objectContaining({
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    }));
  });

  it("a moved member is left out of the partial-reversal count too: every payment still in the family reversed is a full reversal (#4110 review F2)", async () => {
    const preview = await previewFamily([
      familyCharge("NOT_REQUIRED", [["Bill Member", "NOT_INVOICED", "PAID"], ["Moved Member", "PAID", "PAID", "family-2"]]),
    ]);
    expect(preview.entries).toHaveLength(1);
    expect(preview.exceptions).toEqual([]);
  });

  it("every PAYMENT reversed beside an exempt member is a full reversal: billed again, with no partial warning (#4110 review F1)", async () => {
    const preview = await previewFamily([
      familyCharge("NOT_REQUIRED", [["Bill Member", "NOT_INVOICED", "PAID"], ["Cub Member", "NOT_INVOICED", "NOT_REQUIRED"]]),
    ]);
    expect(preview.entries).toHaveLength(1);
    expect(preview.exceptions).toEqual([]);
  });

  it("a closed family every one of whose payments was reversed is billed again, with no warning (#4110)", async () => {
    const preview = await previewFamily([familyCharge("NOT_REQUIRED", [["Bill Member", "NOT_INVOICED"], ["Kid Member", "NOT_INVOICED"]])]);
    expect(preview.entries).toHaveLength(1);
    expect(preview.exceptions).toEqual([]);
  });

  it("a closed family with only SOME payments reversed is billed again, and the officer is warned that confirming invoices the family fee (#4110 owner decision)", async () => {
    const preview = await previewFamily([familyCharge("NOT_REQUIRED", [["Bill Member", "PAID"], ["Kid Member", "NOT_INVOICED"]])]);
    // The entry stays: confirming invoices it.
    expect(preview.entries).toHaveLength(1);
    expect(preview.entries[0]).toMatchObject({ familyGroupId: "family-1" });
    expect(preview.exceptions).toEqual([
      expect.objectContaining({
        code: "CLOSED_FAMILY_PARTLY_REVERSED",
        familyGroupId: "family-1",
        memberId: null,
        message: expect.stringMatching(/since then only some of the members who were paid at the close are no longer paid or not required \(Kid Member\)\. Confirming invoices the full family fee to Bill Member\./),
        context: { closedChargeId: "charge-not_required", reversedMemberNames: ["Kid Member"] },
      }),
    ]);
  });

  it("a live family charge still bills its family beside a closed one", async () => {
    const preview = await previewFamily([
      familyCharge("NOT_REQUIRED", [["Bill Member", "NOT_INVOICED"]]),
      familyCharge("QUEUED", [], { id: "charge-live" }),
    ], ["re-billable"]);
    expect(preview.entries).toHaveLength(0);
    expect(preview.exceptions).toEqual([
      expect.objectContaining({ code: "FAMILY_ALREADY_BILLED", context: expect.objectContaining({ existingFamilyChargeId: "charge-live" }) }),
    ]);
  });

  it.each(["QUEUED", "CONFLICT", "EMAILED"])("control: a live (%s) PER_FAMILY charge still blocks with FAMILY_ALREADY_BILLED (#2147)", async (status) => {
    // Same fixture, but the charge can still be invoiced. The no-invoice filter
    // keeps it in existingFamilyCharges, so a late-joining family member is
    // correctly blocked — proving the filter narrows only terminal rows.
    const annual = fee({ id: "fee-new", billingBasis: "PER_FAMILY", prorationRule: "NONE" });
    mocks.effectiveFee.mockResolvedValue(annual);
    mocks.charges.findMany.mockImplementation(chargesMatchingStatusFilter([
      { id: "charge-live", familyGroupId: "family-1", membershipTypeId: "type-1", billingBasis: "PER_FAMILY", status, coverage: [] },
    ]));
    mocks.members.findMany.mockResolvedValue([
      member("late", { familyGroupMemberships: [familyMembership()] }),
    ]);
    const preview = await buildSubscriptionBillingPreview({
      seasonYear: 2026,
      decisionDate: new Date("2026-08-01T00:00:00.000Z"),
      memberIds: ["late"],
    });
    expect(preview.entries).toHaveLength(0);
    expect(preview.exceptions).toEqual([
      expect.objectContaining({
        code: "FAMILY_ALREADY_BILLED",
        memberId: "late",
        context: expect.objectContaining({ existingFamilyChargeId: "charge-live" }),
      }),
    ]);
  });

  it("never invoices a missing or invalid family recipient", async () => {
    const annual = fee({ billingBasis: "PER_FAMILY" });
    mocks.effectiveFee.mockResolvedValue(annual);
    const assignment = { membershipType: { id: "type-1", key: "FAMILY", name: "Family", subscriptionBehavior: "REQUIRED", annualFees: [annual] } };
    mocks.members.findMany.mockResolvedValue([
      member("missing", {
        seasonalMembershipAssignments: [assignment],
        familyGroupMemberships: [{ familyGroupId: "family-1", familyGroup: { billingMembership: null } }],
      }),
      member("inactive", {
        seasonalMembershipAssignments: [assignment],
        familyGroupMemberships: [familyMembership({ active: false })],
      }),
    ]);
    const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-07-13T00:00:00.000Z") });
    expect(preview.entries).toHaveLength(0);
    // Order is by fingerprint digest, not insertion order.
    expect(preview.exceptions.map((row) => row.code)).toEqual(["INVALID_FAMILY_RECIPIENT", "MISSING_FAMILY_RECIPIENT"]);
  });

  it("surfaces a per-family fee as a config exception under individual billing without touching the recipient path", async () => {
    mocks.familyMode.mockResolvedValue("BILL_MEMBERS_INDIVIDUALLY");
    const annual = fee({ billingBasis: "PER_FAMILY", prorationRule: "NONE" });
    mocks.effectiveFee.mockResolvedValue(annual);
    const assignment = { membershipType: { id: "type-1", key: "FAMILY", name: "Family", subscriptionBehavior: "REQUIRED", annualFees: [annual] } };
    mocks.members.findMany.mockResolvedValue([
      // Missing recipient in family mode would raise MISSING_FAMILY_RECIPIENT.
      member("no-recipient", {
        seasonalMembershipAssignments: [assignment],
        familyGroupMemberships: [{ familyGroupId: "family-1", familyGroup: { billingMembership: null } }],
      }),
      // A member not in any family would raise MISSING_FAMILY in family mode.
      member("no-family", { seasonalMembershipAssignments: [assignment], familyGroupMemberships: [] }),
    ]);
    const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-04-01T00:00:00.000Z") });
    expect(preview.entries).toHaveLength(0);
    // Only the mode exception; the never-infer-recipient family codes are unreachable.
    expect(preview.exceptions.map((row) => row.code)).toEqual([
      "PER_FAMILY_FEE_IN_INDIVIDUAL_MODE",
      "PER_FAMILY_FEE_IN_INDIVIDUAL_MODE",
    ]);
    expect(preview.exceptions.some((row) => row.code === "MISSING_FAMILY_RECIPIENT" || row.code === "INVALID_FAMILY_RECIPIENT" || row.code === "MISSING_FAMILY")).toBe(false);
  });

  it("still bills per-member charges under individual billing", async () => {
    mocks.familyMode.mockResolvedValue("BILL_MEMBERS_INDIVIDUALLY");
    mocks.members.findMany.mockResolvedValue([member("m1")]);
    const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-07-13T00:00:00.000Z") });
    expect(preview.exceptions).toHaveLength(0);
    expect(preview.entries[0]).toMatchObject({ billingBasis: "PER_MEMBER", recipient: { id: "m1" } });
  });

  it("records missing assignment and missing effective fee as visible exceptions", async () => {
    mocks.members.findMany.mockResolvedValue([
      member("unassigned", { seasonalMembershipAssignments: [] }),
      member("no-fee", {
        seasonalMembershipAssignments: [{ membershipType: { id: "type-2", key: "LIFE", name: "Life", subscriptionBehavior: "REQUIRED", annualFees: [] } }],
      }),
    ]);
    mocks.effectiveFee.mockImplementation(async ({ membershipTypeId }: { membershipTypeId: string }) => membershipTypeId === "type-2" ? null : fee());
    const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-07-13T00:00:00.000Z") });
    expect(preview.entries).toHaveLength(0);
    expect(new Set(preview.exceptions.map((row) => row.code))).toEqual(new Set(["MISSING_FEE_SCHEDULE", "MISSING_MEMBERSHIP_ASSIGNMENT"]));
  });

  it("uses the existing role-default membership type for a newly approved member", async () => {
    mocks.members.findMany.mockResolvedValue([member("new", { seasonalMembershipAssignments: [] })]);
    mocks.membershipTypes.findMany.mockResolvedValue([{ id: "type-full", key: "FULL", name: "Full", subscriptionBehavior: "REQUIRED", annualFees: [fee()] }]);
    const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-07-13T00:00:00.000Z"), memberIds: ["new"] });
    expect(preview.exceptions).toHaveLength(0);
    expect(preview.entries[0]).toMatchObject({ membershipTypeKey: "FULL", coveredMembers: [{ id: "new" }] });
  });

  it("bills an unassigned member from an archived stored role-default type and its real fee", async () => {
    mocks.members.findMany.mockResolvedValue([member("archived-full", { seasonalMembershipAssignments: [] })]);
    mocks.membershipTypes.findMany.mockImplementation(async ({ where }: { where: { key: { in: string[] }; isActive?: boolean } }) =>
      where.key.in.includes("FULL") && where.isActive !== true
        ? [{ id: "type-full", key: "FULL", name: "Full", isActive: false, subscriptionBehavior: "REQUIRED" }]
        : []);
    const preview = await buildSubscriptionBillingPreview({
      seasonYear: 2026,
      decisionDate: new Date("2026-04-01T00:00:00.000Z"),
    });
    expect(preview.exceptions).toEqual([]);
    expect(preview.entries).toHaveLength(1);
    expect(preview.entries[0]).toMatchObject({
      membershipTypeId: "type-full",
      membershipAnnualFeeId: "fee-1",
      billingBasis: "PER_MEMBER",
      coveredMembers: [{ id: "archived-full" }],
    });
    expect(mocks.effectiveFee).toHaveBeenCalledWith(
      { membershipTypeId: "type-full", ageTier: "ADULT" },
      expect.any(Date),
      expect.anything(),
    );
  });

  it("keeps an explicit assignment ahead of an archived role default", async () => {
    mocks.members.findMany.mockResolvedValue([member("assigned", {
      seasonalMembershipAssignments: [{ membershipType: {
        id: "type-associate", key: "ASSOCIATE", name: "Associate", subscriptionBehavior: "REQUIRED",
      } }],
    })]);
    mocks.membershipTypes.findMany.mockResolvedValue([
      { id: "type-full", key: "FULL", name: "Full", isActive: false, subscriptionBehavior: "REQUIRED" },
    ]);
    const preview = await buildSubscriptionBillingPreview({
      seasonYear: 2026,
      decisionDate: new Date("2026-04-01T00:00:00.000Z"),
    });
    expect(preview.entries[0]).toMatchObject({ membershipTypeId: "type-associate" });
    expect(mocks.membershipTypes.findMany).not.toHaveBeenCalled();
  });

  it("excludes a bare ADMIN account via its NOT_REQUIRED role-default type — never billed, no exception (#2149)", async () => {
    // Guard item 2: with the role-based exemption dropped, a bare operational
    // account with no season assignment resolves its fallback type FROM THE DB.
    // The migration seeds ADMIN as NOT_REQUIRED, so the preview skips it entirely
    // instead of raising MISSING_MEMBERSHIP_ASSIGNMENT (which it would if the
    // ADMIN type row were absent) or billing it at the FULL rate.
    mocks.members.findMany.mockResolvedValue([
      member("bare-admin", { role: "ADMIN", seasonalMembershipAssignments: [] }),
    ]);
    mocks.membershipTypes.findMany.mockResolvedValue([
      { id: "type-admin", key: "ADMIN", name: "Admin", subscriptionBehavior: "NOT_REQUIRED", annualFees: [] },
    ]);
    const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-07-13T00:00:00.000Z") });
    expect(preview.entries).toHaveLength(0);
    expect(preview.exceptions).toHaveLength(0);
  });

  it("snapshots explicit NO_INVOICE as zero cents rather than treating it as missing config", async () => {
    mocks.members.findMany.mockResolvedValue([
      member("life", {
        seasonalMembershipAssignments: [{
          membershipType: { id: "type-life", key: "LIFE", name: "Life", subscriptionBehavior: "REQUIRED", annualFees: [fee({ id: "fee-life", amountCents: 0, billingBasis: "NO_INVOICE", prorationRule: "NONE" })] },
        }],
      }),
    ]);
    mocks.effectiveFee.mockResolvedValue(fee({ id: "fee-life", amountCents: 0, billingBasis: "NO_INVOICE", prorationRule: "NONE" }));
    const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-04-01T00:00:00.000Z") });
    expect(preview.exceptions).toHaveLength(0);
    expect(preview.entries[0]).toMatchObject({ billingBasis: "NO_INVOICE", annualAmountCents: 0, chargedAmountCents: 0 });
  });

  it("looks up the effective annual fee once per distinct membership type, not once per member (#1886)", async () => {
    const lifeAssignment = {
      membershipType: {
        id: "type-2", key: "LIFE", name: "Life", subscriptionBehavior: "REQUIRED", annualFees: [],
      },
    };
    mocks.members.findMany.mockResolvedValue([
      member("m1"),
      member("m2"),
      member("m3", { seasonalMembershipAssignments: [lifeAssignment] }),
    ]);
    mocks.effectiveFee.mockImplementation(async ({ membershipTypeId }: { membershipTypeId: string }) =>
      membershipTypeId === "type-2" ? fee({ id: "fee-2", amountCents: 6_000 }) : fee());
    const preview = await buildSubscriptionBillingPreview({
      seasonYear: 2026,
      decisionDate: new Date("2026-07-13T00:00:00.000Z"),
    });
    expect(preview.entries).toHaveLength(3);
    // Deduplicating identical lookups must not change any fee value.
    expect(preview.entries.filter((entry) => entry.membershipTypeId === "type-1")
      .map((entry) => entry.annualAmountCents)).toEqual([12_001, 12_001]);
    expect(preview.entries.find((entry) => entry.membershipTypeId === "type-2"))
      .toMatchObject({ annualAmountCents: 6_000 });
    expect(mocks.effectiveFee).toHaveBeenCalledTimes(2);
    // #2067: the memo keys per (type, tier); every member here is ADULT, so each
    // distinct type is still resolved once. The first arg is now {membershipTypeId, ageTier}.
    expect(mocks.effectiveFee.mock.calls.map((call) => call[0].membershipTypeId).sort()).toEqual(["type-1", "type-2"]);
    expect(mocks.effectiveFee.mock.calls.every((call) => call[0].ageTier === "ADULT")).toBe(true);
  });

  describe("per-age-tier annual fees (#2067)", () => {
    it("charges each member by their own age tier's fee and memoizes per (type, tier)", async () => {
      mocks.members.findMany.mockResolvedValue([
        member("adult-1", { ageTier: "ADULT" }),
        member("adult-2", { ageTier: "ADULT" }),
        member("youth-1", { ageTier: "YOUTH" }),
      ]);
      mocks.effectiveFee.mockImplementation(async ({ ageTier }: { ageTier: string | null }) =>
        ageTier === "YOUTH"
          ? fee({ id: "fee-youth", amountCents: 6_000, prorationRule: "NONE" })
          : fee({ id: "fee-adult", amountCents: 12_000, prorationRule: "NONE" }));
      const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-04-01T00:00:00.000Z") });
      // One resolver call per (type, tier), even though two members share ADULT.
      expect(mocks.effectiveFee).toHaveBeenCalledTimes(2);
      const adultEntries = preview.entries.filter((e) => e.membershipAnnualFeeId === "fee-adult");
      const youthEntries = preview.entries.filter((e) => e.membershipAnnualFeeId === "fee-youth");
      expect(adultEntries.map((e) => e.coveredMembers[0].id).sort()).toEqual(["adult-1", "adult-2"]);
      expect(adultEntries.every((e) => e.annualAmountCents === 12_000 && e.chargedAmountCents === 12_000)).toBe(true);
      expect(youthEntries).toHaveLength(1);
      expect(youthEntries[0].annualAmountCents).toBe(6_000);
      expect(youthEntries[0].coveredMembers[0].id).toBe("youth-1");
    });

    it("falls back to the flat fee (resolver returns the same row for every tier)", async () => {
      mocks.members.findMany.mockResolvedValue([
        member("adult", { ageTier: "ADULT" }),
        member("child", { ageTier: "CHILD" }),
      ]);
      // An all-flat config: the resolver returns the flat row for every tier.
      mocks.effectiveFee.mockResolvedValue(fee({ id: "fee-flat", amountCents: 10_000, prorationRule: "NONE" }));
      const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-04-01T00:00:00.000Z") });
      expect(preview.entries).toHaveLength(2);
      expect(preview.entries.every((e) => e.membershipAnnualFeeId === "fee-flat" && e.annualAmountCents === 10_000)).toBe(true);
    });

    it("names the member's age tier in the MISSING_FEE_SCHEDULE message", async () => {
      mocks.members.findMany.mockResolvedValue([member("youth-nofee", { ageTier: "YOUTH" })]);
      mocks.effectiveFee.mockResolvedValue(null);
      const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-07-13T00:00:00.000Z") });
      expect(preview.exceptions.map((row) => row.code)).toEqual(["MISSING_FEE_SCHEDULE"]);
      expect(preview.exceptions[0].message).toContain("YOUTH");
    });

    it("resolves NOT_APPLICABLE members to the flat fee (tier passed through unchanged)", async () => {
      mocks.members.findMany.mockResolvedValue([member("org", { ageTier: "NOT_APPLICABLE" })]);
      mocks.effectiveFee.mockResolvedValue(fee({ id: "fee-flat", amountCents: 8_000, prorationRule: "NONE" }));
      const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-04-01T00:00:00.000Z") });
      expect(mocks.effectiveFee).toHaveBeenCalledWith(
        expect.objectContaining({ ageTier: "NOT_APPLICABLE" }),
        expect.anything(),
        expect.anything(),
      );
      expect(preview.entries[0]).toMatchObject({ membershipAnnualFeeId: "fee-flat", annualAmountCents: 8_000 });
    });

    it("groups a flat PER_FAMILY fee across family members of differing tiers (unchanged)", async () => {
      mocks.members.findMany.mockResolvedValue([
        member("fam-adult", { ageTier: "ADULT", familyGroupMemberships: [familyMembership()] }),
        member("fam-child", { ageTier: "CHILD", familyGroupMemberships: [familyMembership()] }),
      ]);
      // PER_FAMILY is flat-only, so the resolver returns the same flat family fee
      // for every tier; the family grouping key ignores fee.id/tier.
      mocks.effectiveFee.mockResolvedValue(fee({ id: "fee-family", billingBasis: "PER_FAMILY", prorationRule: "NONE" }));
      const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-04-01T00:00:00.000Z") });
      expect(preview.entries).toHaveLength(1);
      expect(preview.entries[0].billingBasis).toBe("PER_FAMILY");
      expect(preview.entries[0].coveredMembers.map((m) => m.id).sort()).toEqual(["fam-adult", "fam-child"]);
    });
  });

  it("does not regenerate already-covered subscriptions and future fee changes alter only future previews", async () => {
    mocks.coverage.findMany.mockResolvedValue([{ memberId: "covered" }]);
    const originalMember = member("future", { seasonalMembershipAssignments: [{ membershipType: { id: "type-1", key: "FULL", name: "Full", subscriptionBehavior: "REQUIRED", annualFees: [fee()] } }] });
    mocks.effectiveFee.mockResolvedValue(fee());
    mocks.members.findMany.mockResolvedValue([member("covered"), originalMember]);
    const first = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-07-13T00:00:00.000Z") });
    expect(first.alreadyCoveredMemberIds).toEqual(["covered"]);
    expect(first.entries).toHaveLength(1);
    const frozen = structuredClone(first.entries[0]);

    mocks.members.findMany.mockResolvedValue([member("future", { seasonalMembershipAssignments: [{ membershipType: { id: "type-1", key: "FULL", name: "Full", subscriptionBehavior: "REQUIRED", annualFees: [fee({ id: "fee-2", amountCents: 24_000 })] } }] })]);
    mocks.effectiveFee.mockResolvedValue(fee({ id: "fee-2", amountCents: 24_000 }));
    const future = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-08-01T00:00:00.000Z") });
    expect(frozen.annualAmountCents).toBe(12_001);
    expect(future.entries[0].annualAmountCents).toBe(24_000);
    expect(future.confirmationToken).not.toBe(first.confirmationToken);
  });

  describe("annual fee components (#1932, E6)", () => {
    it("charges Σ of per-component proration and exposes the multi-component ±cent divergence", async () => {
      const annual = fee({ amountCents: 6, components: [comp({ label: "Base", amountCents: 3, sortOrder: 0 }), comp({ label: "Levy", amountCents: 3, sortOrder: 1 })] });
      mocks.effectiveFee.mockResolvedValue(annual);
      mocks.members.findMany.mockResolvedValue([member("m1")]);
      const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-07-13T00:00:00.000Z") });
      expect(preview.entries[0].coveredMonths).toBe(9);
      // Per-component floor: floor((3*9+6)/12) = 2 each -> Σ 4. Fee-level floor
      // rounds to 5, so the multi-component total is 1 cent lower (n-1 = 1).
      expect(preview.entries[0].chargedAmountCents).toBe(4);
      expect(calculateMembershipCharge({ annualAmountCents: 6, prorationRule: "REMAINING_MONTHS_INCLUSIVE", seasonYear: 2026, decisionDate: new Date("2026-07-13T00:00:00.000Z") }).amountCents).toBe(5);
      expect(preview.entries[0].components).toEqual([
        expect.objectContaining({ label: "Base", annualAmountCents: 3, chargedAmountCents: 2, prorated: true, xeroAccountCode: "203", xeroItemCode: "SUB", sortOrder: 0 }),
        expect.objectContaining({ label: "Levy", annualAmountCents: 3, chargedAmountCents: 2, sortOrder: 1 }),
      ]);
      expect(preview.totalCents).toBe(4);
    });

    it("resolves a component's own account/item override, else the frozen mapping; a non-prorated component charges in full", async () => {
      const annual = fee({ amountCents: 100, prorationRule: "REMAINING_MONTHS_INCLUSIVE", components: [
        comp({ label: "Base", amountCents: 60, sortOrder: 0, prorate: true }),
        comp({ label: "Work party", amountCents: 40, sortOrder: 1, prorate: false, xeroAccountCode: "260", xeroItemCode: "WP" }),
      ] });
      mocks.effectiveFee.mockResolvedValue(annual);
      mocks.members.findMany.mockResolvedValue([member("m1")]);
      const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-07-13T00:00:00.000Z") });
      expect(preview.entries[0].coveredMonths).toBe(9);
      // Base prorated: floor((60*9+6)/12)=45. Work party not prorated: 40.
      expect(preview.entries[0].components).toEqual([
        expect.objectContaining({ label: "Base", chargedAmountCents: 45, prorated: true, xeroAccountCode: "203", xeroItemCode: "SUB" }),
        expect.objectContaining({ label: "Work party", chargedAmountCents: 40, prorated: false, xeroAccountCode: "260", xeroItemCode: "WP" }),
      ]);
      expect(preview.entries[0].chargedAmountCents).toBe(85);
    });

    it("NO_INVOICE carries no components", async () => {
      const annual = fee({ id: "fee-life", amountCents: 0, billingBasis: "NO_INVOICE", prorationRule: "NONE", components: [] });
      mocks.effectiveFee.mockResolvedValue(annual);
      mocks.members.findMany.mockResolvedValue([member("life")]);
      const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-04-01T00:00:00.000Z") });
      expect(preview.entries[0]).toMatchObject({ billingBasis: "NO_INVOICE", chargedAmountCents: 0, components: [] });
    });

    it("editing components changes the confirmation-token digest (edit-between-preview-and-confirm => 409)", async () => {
      mocks.members.findMany.mockResolvedValue([member("m1")]);
      mocks.effectiveFee.mockResolvedValue(fee({ amountCents: 100, prorationRule: "NONE", components: [comp({ label: "Base", amountCents: 100, sortOrder: 0 })] }));
      const before = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-04-01T00:00:00.000Z") });
      mocks.effectiveFee.mockResolvedValue(fee({ amountCents: 100, prorationRule: "NONE", components: [comp({ label: "Base", amountCents: 60, sortOrder: 0 }), comp({ label: "Levy", amountCents: 40, sortOrder: 1 })] }));
      const after = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-04-01T00:00:00.000Z") });
      expect(after.confirmationToken).not.toBe(before.confirmationToken);
    });
  });

  describe("component line description (#1932, E6; season naming #3116)", () => {
    it("names the season from the club's year-end, with pluralization, for a sole component", () => {
      expect(buildComponentLineDescription({ membershipTypeName: "Full", seasonYear: 2026, coveredMonths: 1, label: "Annual membership fee", isSoleComponent: true, yearEndMonth: 3 }))
        .toBe("Full membership 2026 - 2027 (1 month)");
      expect(buildComponentLineDescription({ membershipTypeName: "Full", seasonYear: 2026, coveredMonths: 12, label: "Annual membership fee", isSoleComponent: true, yearEndMonth: 3 }))
        .toBe("Full membership 2026 - 2027 (12 months)");
    });
    it("appends the label for a multi-component line", () => {
      expect(buildComponentLineDescription({ membershipTypeName: "Full", seasonYear: 2026, coveredMonths: 9, label: "Work party fee", isSoleComponent: false, yearEndMonth: 3 }))
        .toBe("Full membership 2026 - 2027 (9 months) — Work party fee");
    });

    // #3116: the defect this function had. A December year-end makes the season
    // start in January and end in the SAME calendar year, so naming it as two
    // calendar years contradicted the season year printed beside it on the
    // invoice. Before this change the text below read "2026/2027".
    it("names a single-calendar-year season with one year, for a December year-end", () => {
      expect(buildComponentLineDescription({ membershipTypeName: "Full", seasonYear: 2026, coveredMonths: 12, label: "Annual membership fee", isSoleComponent: true, yearEndMonth: 12 }))
        .toBe("Full membership 2026 (12 months)");
    });

    // The year-end is threaded, not read from the process cache. If this function
    // ever went back to defaulting it, this case would answer from whatever
    // `financial-year.ts` happened to hold and would stop discriminating.
    it("follows the year-end it is given rather than any ambient default", () => {
      const june = buildComponentLineDescription({ membershipTypeName: "Full", seasonYear: 2026, coveredMonths: 12, label: "Annual membership fee", isSoleComponent: true, yearEndMonth: 6 });
      const december = buildComponentLineDescription({ membershipTypeName: "Full", seasonYear: 2026, coveredMonths: 12, label: "Annual membership fee", isSoleComponent: true, yearEndMonth: 12 });
      expect(june).toBe("Full membership 2026 - 2027 (12 months)");
      expect(december).toBe("Full membership 2026 (12 months)");
      expect(june).not.toBe(december);
    });
  });

  describe("per-member billing family (#1932, E6)", () => {
    const familyFee = () => fee({ billingBasis: "PER_FAMILY", prorationRule: "NONE" });
    beforeEach(() => { mocks.effectiveFee.mockResolvedValue(familyFee()); });

    it("bills the admin-selected family when a member belongs to more than one", async () => {
      mocks.members.findMany.mockResolvedValue([
        member("multi", { billingFamilyGroupId: "family-B", familyGroupMemberships: [familyMembershipFor("family-A"), familyMembershipFor("family-B")] }),
      ]);
      const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-04-01T00:00:00.000Z") });
      expect(preview.exceptions).toHaveLength(0);
      expect(preview.entries[0]).toMatchObject({ familyGroupId: "family-B", recipient: { id: "billing-family-B" } });
    });

    it("raises INVALID_BILLING_FAMILY_SELECTION for a stale selection", async () => {
      mocks.members.findMany.mockResolvedValue([
        member("multi", { billingFamilyGroupId: "family-Z", familyGroupMemberships: [familyMembershipFor("family-A"), familyMembershipFor("family-B")] }),
      ]);
      const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-04-01T00:00:00.000Z") });
      expect(preview.entries).toHaveLength(0);
      expect(preview.exceptions.map((row) => row.code)).toEqual(["INVALID_BILLING_FAMILY_SELECTION"]);
    });

    it("raises AMBIGUOUS_FAMILY when the selection is unset", async () => {
      mocks.members.findMany.mockResolvedValue([
        member("multi", { billingFamilyGroupId: null, familyGroupMemberships: [familyMembershipFor("family-A"), familyMembershipFor("family-B")] }),
      ]);
      const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-04-01T00:00:00.000Z") });
      expect(preview.exceptions.map((row) => row.code)).toEqual(["AMBIGUOUS_FAMILY"]);
    });

    it("ignores the field for a single-group member even if set to another group", async () => {
      mocks.members.findMany.mockResolvedValue([
        member("solo", { billingFamilyGroupId: "family-Z", familyGroupMemberships: [familyMembershipFor("family-A")] }),
      ]);
      const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-04-01T00:00:00.000Z") });
      expect(preview.exceptions).toHaveLength(0);
      expect(preview.entries[0]).toMatchObject({ familyGroupId: "family-A" });
    });

    it("still subjects the selected family to the recipient checks", async () => {
      mocks.members.findMany.mockResolvedValue([
        member("multi", { billingFamilyGroupId: "family-B", familyGroupMemberships: [
          familyMembershipFor("family-A"),
          { familyGroupId: "family-B", familyGroup: { billingMembership: null } },
        ] }),
      ]);
      const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-04-01T00:00:00.000Z") });
      expect(preview.entries).toHaveLength(0);
      expect(preview.exceptions.map((row) => row.code)).toEqual(["MISSING_FAMILY_RECIPIENT"]);
    });

    it("ignores the selection under individual billing (mode guard fires first)", async () => {
      mocks.familyMode.mockResolvedValue("BILL_MEMBERS_INDIVIDUALLY");
      mocks.members.findMany.mockResolvedValue([
        member("multi", { billingFamilyGroupId: "family-Z", familyGroupMemberships: [familyMembershipFor("family-A"), familyMembershipFor("family-B")] }),
      ]);
      const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-04-01T00:00:00.000Z") });
      expect(preview.exceptions.map((row) => row.code)).toEqual(["PER_FAMILY_FEE_IN_INDIVIDUAL_MODE"]);
    });

    it("groups an already-billed selected family under FAMILY_ALREADY_BILLED (never double-covered)", async () => {
      mocks.charges.findMany.mockResolvedValue([{ id: "charge-B", familyGroupId: "family-B", membershipTypeId: "type-1", coverage: [] }]);
      mocks.members.findMany.mockResolvedValue([
        member("multi", { billingFamilyGroupId: "family-B", familyGroupMemberships: [familyMembershipFor("family-A"), familyMembershipFor("family-B")] }),
      ]);
      const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-04-01T00:00:00.000Z") });
      expect(preview.entries).toHaveLength(0);
      expect(preview.exceptions[0]).toMatchObject({ code: "FAMILY_ALREADY_BILLED", familyGroupId: "family-B" });
    });
  });

  describe("family-level dedup on a partial legacy invoice (#2147 FINDING 1)", () => {
    const familyFee = () => fee({ id: "fee-family", billingBasis: "PER_FAMILY", prorationRule: "NONE" });
    // A FamilyGroupMember blocker row: the member already holds a live season
    // invoice, so the whole family group is suppressed from a second charge. #2161
    // (D1): the row now carries the holder's resolution inputs (role/DOB/tier/
    // assignment) and its subscription's active chargeCoverage, so the builder can
    // resolve the holder's OWN basis (here PER_FAMILY, since mocks.effectiveFee
    // returns the family fee) and confirm it should suppress.
    function blocker(
      memberId: string,
      sub: {
        xeroInvoiceId?: string | null;
        xeroInvoiceNumber?: string | null;
        status?: string;
        chargeCoverage?: Array<{ charge: { billingBasis: string; familyGroupId: string | null } }>;
      } = {},
      memberOverrides: Record<string, unknown> = {},
    ) {
      return {
        familyGroupId: "family-1",
        memberId,
        member: {
          firstName: "Bill",
          lastName: "Member",
          role: "USER",
          dateOfBirth: null,
          ageTier: "ADULT",
          seasonalMembershipAssignments: [{
            membershipType: { id: "type-1", key: "FAMILY", name: "Family", subscriptionBehavior: "REQUIRED" },
          }],
          subscriptions: [{
            xeroInvoiceId: sub.xeroInvoiceId ?? "xi-100",
            xeroInvoiceNumber: sub.xeroInvoiceNumber ?? "INV-100",
            status: sub.status ?? "UNPAID",
            chargeCoverage: sub.chargeCoverage ?? [],
          }],
          ...memberOverrides,
        },
      };
    }

    beforeEach(() => { mocks.effectiveFee.mockResolvedValue(familyFee()); });

    it("(a) suppresses the whole family when the billing member holds a live legacy invoice and children do not (empty charge/coverage tables)", async () => {
      // Billing member B holds live INV-100; children c1/c2 have no invoice link
      // and no charge/coverage rows. Without family-level dedup c1 would proceed,
      // resolve recipient B, and mint a SECOND family charge to B.
      mocks.charges.findMany.mockResolvedValue([]); // no family charge exists yet
      mocks.coverage.findMany.mockResolvedValue([]); // no coverage rows
      mocks.subscriptions.findMany.mockResolvedValue([
        // B is separately surfaced per-member in alreadyInvoiced (unchanged).
        { memberId: "billing-1", status: "UNPAID", xeroInvoiceId: "xi-100", xeroInvoiceNumber: "INV-100", member: { firstName: "Bill", lastName: "Member" } },
      ]);
      mocks.familyGroupMembers.findMany.mockResolvedValue([blocker("billing-1")]);
      mocks.familyGroupMembers.groupBy.mockResolvedValue([{ familyGroupId: "family-1", _count: { memberId: 3 } }]);
      mocks.members.findMany.mockResolvedValue([
        member("c1", { familyGroupMemberships: [familyMembership()] }),
        member("c2", { familyGroupMemberships: [familyMembership()] }),
      ]);
      const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-04-01T00:00:00.000Z") });
      // No family entry is minted at all.
      expect(preview.entries).toHaveLength(0);
      // The whole family is surfaced for audit, with the invoice-holder + number.
      expect(preview.alreadyInvoicedFamilies).toEqual([
        { familyGroupId: "family-1", holderMemberId: "billing-1", holderName: "Bill Member", xeroInvoiceNumber: "INV-100", status: "UNPAID", holderBasisUnresolvable: false, membersCovered: 3, operatorMarked: false, markerNote: null, markedByName: null, markedAt: null },
      ]);
      // The family-level dedup query is intentionally NOT scoped to memberIds.
      expect(mocks.familyGroupMembers.findMany).toHaveBeenCalled();
    });

    it("Finance's difference invoice does not hide a reversal: the family is billed again, and the officer is warned about the invoice (review rounds 4 F-C and 5 item 2)", async () => {
      // The parent's payment at the close was reversed; the child, exempt at
      // the close, holds the invoice Finance raised by hand for the difference.
      mocks.familyGroupMembers.findMany.mockResolvedValue([blocker("cub-1", { xeroInvoiceId: "xi-difference", xeroInvoiceNumber: "INV-DIFF" }, { firstName: "Cub", lastName: "One" })]);
      const charge = familyCharge("NOT_REQUIRED", [["Bill Member", "NOT_INVOICED", "PAID"], ["cub-1", "UNPAID", "NOT_REQUIRED"]]);
      const preview = await previewFamily([charge]);
      expect(preview.alreadyInvoicedFamilies).toEqual([]);
      expect(preview.entries).toHaveLength(1);
      expect(preview.entries[0]).toMatchObject({ familyGroupId: "family-1" });
      expect(preview.exceptions).toEqual([
        expect.objectContaining({
          code: "CLOSED_FAMILY_REBILL_BESIDE_INVOICE",
          familyGroupId: "family-1",
          message: expect.stringContaining("already holds a Xero invoice for this season: Cub One (INV-DIFF)"),
          context: { invoiceHolders: [{ memberName: "Cub One", invoice: "INV-DIFF" }] },
        }),
      ]);
    });

    it("a parent paid at the close who holds their own family invoice still suppresses the family: no second family invoice (review round 5 item 1)", async () => {
      // H raised the family fee by hand and paid it; C1 was closed with H PAID
      // and K exempt; the bank then reversed H's payment, leaving H UNPAID with
      // the family invoice still live. A second full family invoice must not
      // be minted off K.
      mocks.familyGroupMembers.findMany.mockResolvedValue([blocker("H", { xeroInvoiceId: "xi-family", xeroInvoiceNumber: "INV-FAM", status: "UNPAID" })]);
      mocks.familyGroupMembers.groupBy.mockResolvedValue([{ familyGroupId: "family-1", _count: { memberId: 2 } }]);
      const charge = familyCharge("NOT_REQUIRED", [["H", "UNPAID", "PAID"], ["re-billable", "NOT_REQUIRED", "NOT_REQUIRED"]]);
      const preview = await previewFamily([charge]);
      expect(preview.entries).toEqual([]);
      expect(preview.alreadyInvoicedFamilies).toEqual([expect.objectContaining({ familyGroupId: "family-1", holderMemberId: "H", xeroInvoiceNumber: "INV-FAM" })]);
    });

    it("the difference-invoice exemption is keyed by family AND membership type (review round 5 item 1)", async () => {
      // The child was exempt at the close of a DIFFERENT type's closed charge;
      // their invoice is not that charge's difference for this type, so it
      // keeps suppressing this type's family fee as #2161 requires.
      mocks.familyGroupMembers.findMany.mockResolvedValue([blocker("cub-1", { xeroInvoiceId: "xi-other", xeroInvoiceNumber: "INV-OTHER" })]);
      const otherType = familyCharge("NOT_REQUIRED", [["Bill Member", "PAID", "PAID"], ["cub-1", "UNPAID", "NOT_REQUIRED"]], { membershipTypeId: "type-2" });
      const preview = await previewFamily([otherType]);
      expect(preview.entries).toEqual([]);
      expect(preview.alreadyInvoicedFamilies.map((family) => family.holderMemberId)).toEqual(["cub-1"]);
    });

    it("a reversal the family's own invoice holds back asks the officer to decide, naming that invoice, and never re-bills (review round 6 F1)", async () => {
      // H raised and paid the family invoice INV-FAM; K was paid too; C1 closed;
      // then K's payment was reversed. H's invoice keeps the family held.
      mocks.familyGroupMembers.findMany.mockResolvedValue([blocker("H", { xeroInvoiceId: "xi-fam", xeroInvoiceNumber: "INV-FAM", status: "PAID" }, { firstName: "Hana", lastName: "Parent" })]);
      mocks.familyGroupMembers.groupBy.mockResolvedValue([{ familyGroupId: "family-1", _count: { memberId: 2 } }]);
      const preview = await previewFamily(
        [familyCharge("NOT_REQUIRED", [["H", "PAID", "PAID"], ["re-billable", "NOT_INVOICED", "PAID"]])],
        ["re-billable"],
      );
      expect(preview.entries).toEqual([]);
      expect(preview.alreadyInvoicedFamilies.map((family) => family.holderMemberId)).toEqual(["H"]);
      expect(preview.exceptions).toEqual([
        expect.objectContaining({
          code: "CLOSED_FAMILY_MEMBER_NEEDS_DECISION",
          memberId: "re-billable",
          message: expect.stringContaining("the family is held back by Hana Parent's Xero invoice INV-FAM. The family is not billed again. Decide how to bill"),
          context: expect.objectContaining({ reason: "REVERSED_UNDER_NEWEST_CHARGE", heldBy: "Hana Parent's Xero invoice INV-FAM" }),
        }),
      ]);
    });

    it("a held, reversed family asks about every covered member no longer settled, each naming the hold (review round 7 item 1)", async () => {
      // H paid at the close and holds INV-FAM; K paid and since reversed; E was
      // not required at the close and is now not invoiced.
      mocks.familyGroupMembers.findMany.mockResolvedValue([blocker("H", { xeroInvoiceId: "xi-fam", xeroInvoiceNumber: "INV-FAM", status: "PAID" }, { firstName: "Hana", lastName: "Parent" })]);
      const preview = await previewFamily(
        [familyCharge("NOT_REQUIRED", [["H", "PAID", "PAID"], ["K", "NOT_INVOICED", "PAID"], ["E", "NOT_INVOICED", "NOT_REQUIRED"]])],
        ["K", "E"], undefined, ["K", "E"],
      );
      expect(preview.entries).toEqual([]);
      expect(preview.exceptions.map((item) => [item.memberId, item.code, item.context.reason, item.context.heldBy])
        .sort((left, right) => (String(left[0]) < String(right[0]) ? -1 : 1))).toEqual([
        ["E", "CLOSED_FAMILY_MEMBER_NEEDS_DECISION", "EXEMPT_AT_CLOSE", "Hana Parent's Xero invoice INV-FAM"],
        ["K", "CLOSED_FAMILY_MEMBER_NEEDS_DECISION", "REVERSED_UNDER_NEWEST_CHARGE", "Hana Parent's Xero invoice INV-FAM"],
      ]);
      expect(preview.exceptions.find((item) => item.memberId === "E")!.message).toContain(
        "was not required to pay when the family's Full charge was closed as already paid, and now needs a subscription, and the family is held back by Hana Parent's Xero invoice INV-FAM.",
      );
    });

    it("a held, reversed family asks about a member reversed under an OLDER charge too (review round 7 item 1)", async () => {
      mocks.familyGroupMembers.findMany.mockResolvedValue([blocker("H", { xeroInvoiceId: "xi-fam", xeroInvoiceNumber: "INV-FAM", status: "PAID" }, { firstName: "Hana", lastName: "Parent" })]);
      const preview = await previewFamily([
        familyCharge("NOT_REQUIRED", [["O", "NOT_INVOICED", "PAID"]], OLDER_CHARGE),
        familyCharge("NOT_REQUIRED", [["H", "PAID", "PAID"], ["K", "NOT_INVOICED", "PAID"]], NEWER_CHARGE),
      ], ["O"], undefined, ["O"]);
      expect(preview.entries).toEqual([]);
      expect(preview.exceptions).toEqual([
        expect.objectContaining({
          code: "CLOSED_FAMILY_MEMBER_NEEDS_DECISION", memberId: "O",
          message: expect.stringContaining("'s payment under an earlier closed Full family charge was reversed, and the family is held back by Hana Parent's Xero invoice INV-FAM."),
          context: expect.objectContaining({ reason: "REVERSED_UNDER_OLDER_CHARGE" }),
        }),
      ]);
    });

    it("a family NOT held is billed again once for every covered member who owes, with no decision exception (final round, item 1)", async () => {
      // No hold: H's payment stands, K's was reversed under the newest charge,
      // E was exempt at that close and now owes, O was reversed under an older
      // charge. The re-bill covers K, E and O; nobody needs a decision.
      const preview = await previewFamily([
        familyCharge("NOT_REQUIRED", [["O", "NOT_INVOICED", "PAID"]], OLDER_CHARGE),
        familyCharge("NOT_REQUIRED", [["H", "PAID", "PAID"], ["K", "NOT_INVOICED", "PAID"], ["E", "NOT_INVOICED", "NOT_REQUIRED"]], NEWER_CHARGE),
      ], ["K", "E", "O"], undefined, ["K", "E", "O"]);
      expect(preview.alreadyInvoicedFamilies).toEqual([]);
      expect(preview.entries).toHaveLength(1);
      expect(preview.entries[0]!.coveredMembers.map((covered) => covered.id).sort()).toEqual(["E", "K", "O"]);
      expect(preview.exceptions.map((item) => item.code)).not.toContain("CLOSED_FAMILY_MEMBER_NEEDS_DECISION");
      // H's payment still stands, so the officer is warned before confirming.
      expect(preview.exceptions.map((item) => item.code)).toEqual(["CLOSED_FAMILY_PARTLY_REVERSED"]);
    });

    it("a new joiner with no invoice in a held, reversed family is not asked about (review round 7 item 2)", async () => {
      mocks.familyGroupMembers.findMany.mockResolvedValue([blocker("H", { xeroInvoiceId: "xi-fam", xeroInvoiceNumber: "INV-FAM", status: "PAID" })]);
      const preview = await previewFamily(
        [familyCharge("NOT_REQUIRED", [["H", "PAID", "PAID"], ["K", "NOT_INVOICED", "PAID"]])],
        ["joiner"], undefined, ["joiner"],
      );
      expect(preview.entries).toEqual([]);
      expect(preview.alreadyInvoicedFamilies.map((family) => family.familyGroupId)).toEqual(["family-1"]);
      expect(preview.exceptions).toEqual([]);
    });

    it("names an operator's marker as the hold when only a marker holds the family (review round 7 item 3)", async () => {
      mocks.familyMarkers.findMany.mockResolvedValue([
        { familyGroupId: "family-1", note: "Billed elsewhere", markedAt: new Date("2026-05-01T00:00:00.000Z"), markedBy: { firstName: "Ada", lastName: "Admin" } },
      ]);
      const preview = await previewFamily(
        [familyCharge("NOT_REQUIRED", [["Bill Member", "PAID", "PAID"], ["K", "NOT_INVOICED", "PAID"]])],
        ["K"], undefined, ["K"],
      );
      expect(preview.entries).toEqual([]);
      expect(preview.exceptions).toEqual([
        expect.objectContaining({ memberId: "K", context: expect.objectContaining({ heldBy: "an operator's already-invoiced marker" }) }),
      ]);
    });

    it("names a family charge, not an invoice, when an active family claim holds the family (review round 7 item 3)", async () => {
      // An active claim on a PER_FAMILY charge for this family, and no invoice link.
      mocks.familyGroupMembers.findMany.mockResolvedValue([blocker("H", {}, {
        firstName: "Hana", lastName: "Parent",
        subscriptions: [{
          xeroInvoiceId: null, xeroInvoiceNumber: null, status: "NOT_INVOICED",
          chargeCoverage: [{ charge: { billingBasis: "PER_FAMILY", familyGroupId: "family-1" } }],
        }],
      })]);
      const preview = await previewFamily(
        [familyCharge("NOT_REQUIRED", [["Bill Member", "PAID", "PAID"], ["K", "NOT_INVOICED", "PAID"]])],
        ["K"], undefined, ["K"],
      );
      expect(preview.exceptions).toEqual([
        expect.objectContaining({ memberId: "K", context: expect.objectContaining({ heldBy: "Hana Parent's family charge" }) }),
      ]);
    });

    it("the same when a new joiner's own bare invoice holds the family back (review round 6 F1)", async () => {
      mocks.familyGroupMembers.findMany.mockResolvedValue([blocker("joiner", { xeroInvoiceId: "xi-joiner", xeroInvoiceNumber: "INV-JOIN" }, { firstName: "Jo", lastName: "Iner" })]);
      const preview = await previewFamily(
        [familyCharge("NOT_REQUIRED", [["Bill Member", "PAID", "PAID"], ["re-billable", "NOT_INVOICED", "PAID"]])],
        ["re-billable"],
      );
      expect(preview.entries).toEqual([]);
      expect(preview.exceptions).toEqual([
        expect.objectContaining({ code: "CLOSED_FAMILY_MEMBER_NEEDS_DECISION", memberId: "re-billable", context: expect.objectContaining({ heldBy: "Jo Iner's Xero invoice INV-JOIN" }) }),
      ]);
    });

    it("does not name, beside a re-bill, a member whose invoice would not have held the family: moved to a per-member type (review round 6 F3)", async () => {
      mocks.familyGroupMembers.findMany.mockResolvedValue([blocker("cub-1", { xeroInvoiceId: "xi-own", xeroInvoiceNumber: "INV-OWN" }, {
        firstName: "Cub", lastName: "One",
        seasonalMembershipAssignments: [{ membershipType: { id: "type-2", key: "SOLO", name: "Solo", subscriptionBehavior: "REQUIRED" } }],
      })]);
      const charge = familyCharge("NOT_REQUIRED", [["Bill Member", "NOT_INVOICED", "PAID"], ["cub-1", "UNPAID", "NOT_REQUIRED"]]);
      const preview = await previewFamily([charge], undefined, (typeId) =>
        typeId === "type-2" ? fee({ id: "fee-solo", billingBasis: "PER_MEMBER", prorationRule: "NONE" }) : undefined);
      expect(preview.entries).toHaveLength(1);
      expect(preview.exceptions).toEqual([]);
    });

    it("does not name, beside a re-bill, a same-type holder whose own basis is per-member (review round 6 F3)", async () => {
      // Same type, but the holder's age tier resolves a PER_MEMBER fee: their
      // invoice is their own and would never have held the family.
      mocks.familyGroupMembers.findMany.mockResolvedValue([blocker("cub-1", { xeroInvoiceId: "xi-own", xeroInvoiceNumber: "INV-OWN" }, {
        firstName: "Cub", lastName: "One", ageTier: "YOUTH",
      })]);
      const charge = familyCharge("NOT_REQUIRED", [["Bill Member", "NOT_INVOICED", "PAID"], ["cub-1", "UNPAID", "NOT_REQUIRED"]]);
      const preview = await previewFamily([charge], undefined, (_typeId, ageTier) =>
        ageTier === "YOUTH" ? fee({ id: "fee-youth", billingBasis: "PER_MEMBER", prorationRule: "NONE" }) : undefined);
      expect(preview.entries).toHaveLength(1);
      expect(preview.exceptions).toEqual([]);
    });

    it("lets past the hold, and names beside the re-bill, a holder reversed under an OLDER charge (review round 6 F4)", async () => {
      mocks.familyGroupMembers.findMany.mockResolvedValue([blocker("B", { xeroInvoiceId: "xi-b", xeroInvoiceNumber: "INV-B" }, { firstName: "Bea", lastName: "Older" })]);
      const preview = await previewFamily([
        familyCharge("NOT_REQUIRED", [["B", "UNPAID", "PAID"]], OLDER_CHARGE),
        familyCharge("NOT_REQUIRED", [["Bill Member", "NOT_INVOICED", "PAID"]], NEWER_CHARGE),
      ]);
      expect(preview.alreadyInvoicedFamilies).toEqual([]);
      expect(preview.entries).toHaveLength(1);
      expect(preview.exceptions).toEqual([
        expect.objectContaining({ code: "CLOSED_FAMILY_REBILL_BESIDE_INVOICE", context: { invoiceHolders: [{ memberName: "Bea Older", invoice: "INV-B" }] } }),
      ]);
    });

    it("resolves a holder with no season assignment through their role's default type (review round 6 F4)", async () => {
      mocks.membershipTypes.findMany.mockResolvedValue([
        { id: "type-1", key: defaultMembershipTypeKeyForRole("USER"), name: "Full", subscriptionBehavior: "REQUIRED" },
      ]);
      mocks.familyGroupMembers.findMany.mockResolvedValue([blocker("cub-1", { xeroInvoiceId: "xi-difference", xeroInvoiceNumber: "INV-DIFF" }, {
        firstName: "Cub", lastName: "One", seasonalMembershipAssignments: [],
      })]);
      const charge = familyCharge("NOT_REQUIRED", [["Bill Member", "NOT_INVOICED", "PAID"], ["cub-1", "UNPAID", "NOT_REQUIRED"]]);
      const preview = await previewFamily([charge]);
      expect(preview.alreadyInvoicedFamilies).toEqual([]);
      expect(preview.entries).toHaveLength(1);
      expect(preview.exceptions.map((item) => item.code)).toEqual(["CLOSED_FAMILY_REBILL_BESIDE_INVOICE"]);
    });

    it("(a') suppresses the family even for a scoped NEW_MEMBER_APPROVAL run over only a child", async () => {
      // Confirming just the child must still see the billing member's invoice on
      // the same group — the blocker query is unscoped by memberIds.
      mocks.subscriptions.findMany.mockResolvedValue([]);
      mocks.familyGroupMembers.findMany.mockResolvedValue([blocker("billing-1")]);
      mocks.familyGroupMembers.groupBy.mockResolvedValue([{ familyGroupId: "family-1", _count: { memberId: 3 } }]);
      mocks.members.findMany.mockResolvedValue([
        member("c1", { familyGroupMemberships: [familyMembership()] }),
      ]);
      const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-04-01T00:00:00.000Z"), memberIds: ["c1"] });
      expect(preview.entries).toHaveLength(0);
      expect(preview.alreadyInvoicedFamilies.map((f) => f.familyGroupId)).toEqual(["family-1"]);
    });

    it("(b) re-bills the whole family as ONE charge once the invoice is voided and coverage released", async () => {
      // Post-void: link nulled, coverage released -> no blocker rows -> the group
      // is billable again and folds every member into a single family entry.
      mocks.subscriptions.findMany.mockResolvedValue([]); // B is NOT_INVOICED again
      mocks.coverage.findMany.mockResolvedValue([]); // released row excluded by releasedAt: null
      mocks.familyGroupMembers.findMany.mockResolvedValue([]); // no live invoice, no active coverage
      mocks.members.findMany.mockResolvedValue([
        member("billing-1", { familyGroupMemberships: [familyMembership()] }),
        member("c1", { familyGroupMemberships: [familyMembership()] }),
        member("c2", { familyGroupMemberships: [familyMembership()] }),
      ]);
      const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-04-01T00:00:00.000Z") });
      expect(preview.alreadyInvoicedFamilies).toEqual([]);
      expect(preview.entries).toHaveLength(1);
      expect(preview.entries[0]).toMatchObject({ billingBasis: "PER_FAMILY", familyGroupId: "family-1", recipient: { id: "billing-1" } });
      // ONE charge covering the whole group — not a partial charge covering B only.
      expect(preview.entries[0].coveredMembers.map((m) => m.id)).toEqual(["billing-1", "c1", "c2"]);
    });

    it("(d) a family with no live invoice and no charges still bills normally (regression)", async () => {
      mocks.familyGroupMembers.findMany.mockResolvedValue([]);
      mocks.members.findMany.mockResolvedValue([
        member("m1", { familyGroupMemberships: [familyMembership()] }),
        member("m2", { familyGroupMemberships: [familyMembership()] }),
      ]);
      const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-04-01T00:00:00.000Z") });
      expect(preview.alreadyInvoicedFamilies).toEqual([]);
      expect(preview.entries).toHaveLength(1);
      expect(preview.entries[0].coveredMembers.map((m) => m.id)).toEqual(["m1", "m2"]);
      // groupBy is only queried when a suppression actually applies.
      expect(mocks.familyGroupMembers.groupBy).not.toHaveBeenCalled();
    });

    it("prefers a live-invoice holder as the representative and stays deterministic by memberId", async () => {
      // One group member has an active-coverage-only block from a PER_FAMILY
      // charge (no invoice number), another holds the live invoice — the
      // invoice-holder must be surfaced. #2161 (D1): the coverage trigger derives
      // its basis from the charge row (PER_FAMILY here), so it suppresses.
      mocks.familyGroupMembers.findMany.mockResolvedValue([
        {
          familyGroupId: "family-1",
          memberId: "z-covered",
          member: {
            firstName: "Zoe",
            lastName: "Cover",
            role: "USER",
            dateOfBirth: null,
            ageTier: "ADULT",
            seasonalMembershipAssignments: [],
            subscriptions: [{
              xeroInvoiceId: null,
              xeroInvoiceNumber: null,
              status: "NOT_INVOICED",
              chargeCoverage: [{ charge: { billingBasis: "PER_FAMILY", familyGroupId: "family-1" } }],
            }],
          },
        },
        blocker("billing-1"),
      ]);
      mocks.familyGroupMembers.groupBy.mockResolvedValue([{ familyGroupId: "family-1", _count: { memberId: 4 } }]);
      mocks.members.findMany.mockResolvedValue([
        member("c1", { familyGroupMemberships: [familyMembership()] }),
      ]);
      const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-04-01T00:00:00.000Z") });
      expect(preview.alreadyInvoicedFamilies).toEqual([
        { familyGroupId: "family-1", holderMemberId: "billing-1", holderName: "Bill Member", xeroInvoiceNumber: "INV-100", status: "UNPAID", holderBasisUnresolvable: false, membersCovered: 4, operatorMarked: false, markerNote: null, markedByName: null, markedAt: null },
      ]);
    });
  });

  describe("family suppression refinement + operator marker (#2161)", () => {
    const perFamilyFee = (): ReturnType<typeof fee> => fee({ id: "fee-fam", billingBasis: "PER_FAMILY", prorationRule: "NONE" });
    const perMemberFee = (): ReturnType<typeof fee> => fee({ id: "fee-pm", billingBasis: "PER_MEMBER", prorationRule: "NONE" });
    // effectiveFee keyed by membershipTypeId so a mixed-basis family resolves each
    // member's OWN basis (type-fam -> PER_FAMILY, type-pm -> PER_MEMBER).
    function mixedBasisFees() {
      mocks.effectiveFee.mockImplementation(async ({ membershipTypeId }: { membershipTypeId: string }) =>
        membershipTypeId === "type-pm" ? perMemberFee() : perFamilyFee());
    }
    function famMember(id: string) {
      return member(id, {
        familyGroupMemberships: [familyMembership()],
        seasonalMembershipAssignments: [{ membershipType: { id: "type-fam", key: "FAMILY", name: "Family", subscriptionBehavior: "REQUIRED" } }],
      });
    }
    // A blocker whose OWN resolved basis is PER_MEMBER (assignment type-pm).
    function perMemberBlocker(
      memberId: string,
      sub: { xeroInvoiceId?: string | null; chargeCoverage?: Array<{ charge: { billingBasis: string; familyGroupId: string | null } }> } = {},
    ) {
      const xeroInvoiceId = sub.xeroInvoiceId === undefined ? "xi-pm" : sub.xeroInvoiceId;
      return {
        familyGroupId: "family-1",
        memberId,
        member: {
          firstName: "Pat", lastName: "Member", role: "USER", dateOfBirth: null, ageTier: "ADULT",
          seasonalMembershipAssignments: [{ membershipType: { id: "type-pm", key: "FULL", name: "Full", subscriptionBehavior: "REQUIRED" } }],
          subscriptions: [{
            xeroInvoiceId,
            xeroInvoiceNumber: xeroInvoiceId ? "INV-PM" : null,
            status: "UNPAID",
            chargeCoverage: sub.chargeCoverage ?? [],
          }],
        },
      };
    }

    it("lifts family suppression only for an archived invoice holder with a proven PER_MEMBER role-default fee", async () => {
      mixedBasisFees();
      mocks.membershipTypes.findMany.mockImplementation(async ({ where }: { where: { key: { in: string[] }; isActive?: boolean } }) =>
        where.key.in.includes("FULL") && where.isActive !== true
          ? [{ id: "type-pm", key: "FULL", name: "Full", isActive: false, subscriptionBehavior: "REQUIRED" }]
          : []);
      const holder = perMemberBlocker("archived-holder");
      holder.member.seasonalMembershipAssignments = [];
      mocks.familyGroupMembers.findMany.mockResolvedValue([holder]);
      mocks.subscriptions.findMany.mockResolvedValue([
        { memberId: "archived-holder", status: "UNPAID", xeroInvoiceId: "xi-pm", xeroInvoiceNumber: "INV-PM", member: { firstName: "Pat", lastName: "Member" } },
      ]);
      mocks.members.findMany.mockResolvedValue([famMember("fam-a")]);
      const preview = await buildSubscriptionBillingPreview({
        seasonYear: 2026, decisionDate: new Date("2026-04-01T00:00:00.000Z"),
      });
      expect(preview.entries).toHaveLength(1);
      expect(preview.entries[0]).toMatchObject({ billingBasis: "PER_FAMILY", familyGroupId: "family-1" });
      expect(preview.alreadyInvoicedFamilies).toEqual([]);
    });

    it.each([
      ["missing type", null, perMemberFee, true],
      ["missing fee", "REQUIRED", (): null => null, true],
      ["NOT_REQUIRED", "NOT_REQUIRED", perMemberFee, true],
      ["PER_FAMILY", "REQUIRED", perFamilyFee, false],
      ["NO_INVOICE", "REQUIRED", () => fee({ billingBasis: "NO_INVOICE", amountCents: 0 }), false],
    ] as const)("keeps family suppression for an archived role-default holder with %s", async (_case, behavior, holderFee, unresolvable) => {
      mocks.membershipTypes.findMany.mockImplementation(async ({ where }: { where: { key: { in: string[] }; isActive?: boolean } }) =>
        behavior && where.key.in.includes("FULL") && where.isActive !== true
          ? [{ id: "type-pm", key: "FULL", name: "Full", isActive: false, subscriptionBehavior: behavior }]
          : []);
      mocks.effectiveFee.mockImplementation(async ({ membershipTypeId }: { membershipTypeId: string }) =>
        membershipTypeId === "type-pm" ? holderFee() : perFamilyFee());
      const holder = perMemberBlocker("archived-holder");
      holder.member.seasonalMembershipAssignments = [];
      mocks.familyGroupMembers.findMany.mockResolvedValue([holder]);
      mocks.members.findMany.mockResolvedValue([famMember("fam-a")]);
      const preview = await buildSubscriptionBillingPreview({
        seasonYear: 2026, decisionDate: new Date("2026-04-01T00:00:00.000Z"),
      });
      expect(preview.entries).toHaveLength(0);
      expect(preview.alreadyInvoicedFamilies[0]).toMatchObject({
        holderMemberId: "archived-holder", holderBasisUnresolvable: unresolvable,
      });
    });

    it("D1: a PER_MEMBER member's live personal invoice no longer blocks the family fee (mixed-basis family bills)", async () => {
      // pm-member holds a live personal PER_MEMBER invoice; fam-a/fam-b are
      // PER_FAMILY. The OLD conservative predicate suppressed the whole family off
      // pm-member's invoice (under-billing); D1 resolves pm-member's own basis as
      // PER_MEMBER, so it no longer blocks the family fee.
      mixedBasisFees();
      mocks.subscriptions.findMany.mockResolvedValue([
        { memberId: "pm-member", status: "UNPAID", xeroInvoiceId: "xi-pm", xeroInvoiceNumber: "INV-PM", member: { firstName: "Pat", lastName: "Member" } },
      ]);
      mocks.familyGroupMembers.findMany.mockResolvedValue([perMemberBlocker("pm-member")]);
      mocks.members.findMany.mockResolvedValue([famMember("fam-a"), famMember("fam-b")]);
      const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-04-01T00:00:00.000Z") });
      // The family charge IS generated for the PER_FAMILY-liable members...
      expect(preview.entries).toHaveLength(1);
      expect(preview.entries[0]).toMatchObject({ billingBasis: "PER_FAMILY", familyGroupId: "family-1" });
      expect(preview.entries[0].coveredMembers.map((m) => m.id)).toEqual(["fam-a", "fam-b"]);
      // ...the family is NOT suppressed...
      expect(preview.alreadyInvoicedFamilies).toEqual([]);
      // ...and the PER_MEMBER holder stays skipped per-member (its own invoice).
      expect(preview.alreadyInvoiced.map((r) => r.memberId)).toEqual(["pm-member"]);
    });

    it("D1: coverage from a PER_MEMBER charge does not suppress the family fee", async () => {
      mixedBasisFees();
      mocks.familyGroupMembers.findMany.mockResolvedValue([
        perMemberBlocker("pm-cov", { xeroInvoiceId: null, chargeCoverage: [{ charge: { billingBasis: "PER_MEMBER", familyGroupId: null } }] }),
      ]);
      mocks.members.findMany.mockResolvedValue([famMember("fam-a"), famMember("fam-b")]);
      const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-04-01T00:00:00.000Z") });
      expect(preview.entries).toHaveLength(1);
      expect(preview.entries[0]).toMatchObject({ billingBasis: "PER_FAMILY", familyGroupId: "family-1" });
      expect(preview.alreadyInvoicedFamilies).toEqual([]);
    });

    it("D1: coverage from a PER_FAMILY charge for this group suppresses the family fee", async () => {
      mixedBasisFees();
      mocks.familyGroupMembers.findMany.mockResolvedValue([
        perMemberBlocker("fam-cov", { xeroInvoiceId: null, chargeCoverage: [{ charge: { billingBasis: "PER_FAMILY", familyGroupId: "family-1" } }] }),
      ]);
      mocks.familyGroupMembers.groupBy.mockResolvedValue([{ familyGroupId: "family-1", _count: { memberId: 3 } }]);
      mocks.members.findMany.mockResolvedValue([famMember("fam-a")]);
      const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-04-01T00:00:00.000Z") });
      expect(preview.entries).toHaveLength(0);
      expect(preview.alreadyInvoicedFamilies).toHaveLength(1);
      expect(preview.alreadyInvoicedFamilies[0]).toMatchObject({ familyGroupId: "family-1", holderMemberId: "fam-cov", operatorMarked: false });
    });

    it("FINDING 1 (a): fail-closed — a live-invoice holder whose OWN basis is unresolvable (NOT_REQUIRED type) keeps the family SUPPRESSED + surfaced", async () => {
      // Regression guard for the fail-open bug: a Life-Member-style parent holds
      // the legacy family invoice but their membership type is NOT_REQUIRED, so
      // resolveMemberBillingBasis returns null. The pre-fix predicate treated null
      // like a proven PER_MEMBER and LIFTED suppression, minting a duplicate family
      // invoice off fam-a. Fail-closed keeps the family suppressed and surfaces it
      // with holderBasisUnresolvable=true (holder + invoice number still shown).
      mocks.effectiveFee.mockResolvedValue(perFamilyFee()); // fam-a resolves PER_FAMILY
      mocks.familyGroupMembers.findMany.mockResolvedValue([
        {
          familyGroupId: "family-1",
          memberId: "life-parent",
          member: {
            firstName: "Lena", lastName: "Life", role: "USER", dateOfBirth: null, ageTier: "ADULT",
            seasonalMembershipAssignments: [{ membershipType: { id: "type-life", key: "LIFE", name: "Life", subscriptionBehavior: "NOT_REQUIRED" } }],
            subscriptions: [{ xeroInvoiceId: "xi-legacy", xeroInvoiceNumber: "INV-LEGACY", status: "UNPAID", chargeCoverage: [] }],
          },
        },
      ]);
      mocks.familyGroupMembers.groupBy.mockResolvedValue([{ familyGroupId: "family-1", _count: { memberId: 2 } }]);
      mocks.members.findMany.mockResolvedValue([famMember("fam-a")]);
      const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-04-01T00:00:00.000Z") });
      expect(preview.entries).toHaveLength(0);
      expect(preview.alreadyInvoicedFamilies).toHaveLength(1);
      expect(preview.alreadyInvoicedFamilies[0]).toMatchObject({
        familyGroupId: "family-1", holderMemberId: "life-parent", xeroInvoiceNumber: "INV-LEGACY",
        holderBasisUnresolvable: true, operatorMarked: false,
      });
    });

    it("FINDING 1 (c): fail-closed — a live-invoice holder whose type resolves but has NO fee row keeps the family SUPPRESSED", async () => {
      // Type resolves (REQUIRED) but getEffectiveMembershipAnnualFee returns null
      // for it, so the holder's basis is null/unresolvable -> fail closed.
      mocks.effectiveFee.mockImplementation(async ({ membershipTypeId }: { membershipTypeId: string }) =>
        membershipTypeId === "type-nofee" ? null : perFamilyFee());
      mocks.familyGroupMembers.findMany.mockResolvedValue([
        {
          familyGroupId: "family-1",
          memberId: "nofee-holder",
          member: {
            firstName: "Nora", lastName: "NoFee", role: "USER", dateOfBirth: null, ageTier: "ADULT",
            seasonalMembershipAssignments: [{ membershipType: { id: "type-nofee", key: "X", name: "X", subscriptionBehavior: "REQUIRED" } }],
            subscriptions: [{ xeroInvoiceId: "xi-x", xeroInvoiceNumber: "INV-X", status: "UNPAID", chargeCoverage: [] }],
          },
        },
      ]);
      mocks.familyGroupMembers.groupBy.mockResolvedValue([{ familyGroupId: "family-1", _count: { memberId: 2 } }]);
      mocks.members.findMany.mockResolvedValue([famMember("fam-a")]);
      const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-04-01T00:00:00.000Z") });
      expect(preview.entries).toHaveLength(0);
      expect(preview.alreadyInvoicedFamilies[0]).toMatchObject({
        familyGroupId: "family-1", holderMemberId: "nofee-holder", holderBasisUnresolvable: true,
      });
    });

    it("FINDING 1 (d): fail-closed — a live-invoice holder whose OWN fee basis is NO_INVOICE keeps the family SUPPRESSED", async () => {
      // A NO_INVOICE-basis member (e.g. a Life/honorary member configured via a
      // NO_INVOICE fee row rather than a NOT_REQUIRED type) never generates a
      // personal invoice, so a live invoice on them can only be a legacy/family
      // invoice. Suppression lifts only on proven PER_MEMBER; basis IS resolved
      // here, so holderBasisUnresolvable stays false.
      mocks.effectiveFee.mockImplementation(async ({ membershipTypeId }: { membershipTypeId: string }) =>
        membershipTypeId === "type-noinv"
          ? { billingBasis: "NO_INVOICE", annualAmountCents: 0 }
          : perFamilyFee());
      mocks.familyGroupMembers.findMany.mockResolvedValue([
        {
          familyGroupId: "family-1",
          memberId: "noinv-holder",
          member: {
            firstName: "Liv", lastName: "Life", role: "USER", dateOfBirth: null, ageTier: "ADULT",
            seasonalMembershipAssignments: [{ membershipType: { id: "type-noinv", key: "LIFE_NOINV", name: "Life", subscriptionBehavior: "REQUIRED" } }],
            subscriptions: [{ xeroInvoiceId: "xi-l", xeroInvoiceNumber: "INV-L", status: "UNPAID", chargeCoverage: [] }],
          },
        },
      ]);
      mocks.familyGroupMembers.groupBy.mockResolvedValue([{ familyGroupId: "family-1", _count: { memberId: 2 } }]);
      mocks.members.findMany.mockResolvedValue([famMember("fam-a")]);
      const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-04-01T00:00:00.000Z") });
      expect(preview.entries).toHaveLength(0);
      expect(preview.alreadyInvoicedFamilies[0]).toMatchObject({
        familyGroupId: "family-1", holderMemberId: "noinv-holder", holderBasisUnresolvable: false,
      });
    });

    it("D2: an active operator marker suppresses the family and surfaces it with the marker indicator + note", async () => {
      mocks.effectiveFee.mockResolvedValue(perFamilyFee());
      mocks.familyMarkers.findMany.mockResolvedValue([
        { familyGroupId: "family-1", note: "Covered by INV-legacy-9", markedAt: new Date("2026-05-01T00:00:00.000Z"), markedBy: { firstName: "Ada", lastName: "Admin" } },
      ]);
      mocks.familyGroupMembers.groupBy.mockResolvedValue([{ familyGroupId: "family-1", _count: { memberId: 2 } }]);
      mocks.members.findMany.mockResolvedValue([famMember("fam-a"), famMember("fam-b")]);
      const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-04-01T00:00:00.000Z") });
      expect(preview.entries).toHaveLength(0);
      expect(preview.alreadyInvoicedFamilies).toEqual([
        {
          familyGroupId: "family-1", holderMemberId: null, holderName: null, xeroInvoiceNumber: null, status: null,
          holderBasisUnresolvable: false,
          membersCovered: 2, operatorMarked: true, markerNote: "Covered by INV-legacy-9", markedByName: "Ada Admin",
          markedAt: new Date("2026-05-01T00:00:00.000Z"),
        },
      ]);
    });

    it("D2: a marker closes the D1 window — it suppresses a mixed-basis family D1 would otherwise bill", async () => {
      mixedBasisFees();
      mocks.subscriptions.findMany.mockResolvedValue([
        { memberId: "pm-member", status: "UNPAID", xeroInvoiceId: "xi-pm", xeroInvoiceNumber: "INV-PM", member: { firstName: "Pat", lastName: "Member" } },
      ]);
      mocks.familyGroupMembers.findMany.mockResolvedValue([perMemberBlocker("pm-member")]);
      mocks.familyMarkers.findMany.mockResolvedValue([
        { familyGroupId: "family-1", note: null, markedAt: new Date("2026-05-01T00:00:00.000Z"), markedBy: null },
      ]);
      mocks.familyGroupMembers.groupBy.mockResolvedValue([{ familyGroupId: "family-1", _count: { memberId: 3 } }]);
      mocks.members.findMany.mockResolvedValue([famMember("fam-a"), famMember("fam-b")]);
      const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-04-01T00:00:00.000Z") });
      // Without the marker the D1 test above proves the family bills; the marker
      // suppresses it regardless of basis.
      expect(preview.entries).toHaveLength(0);
      expect(preview.alreadyInvoicedFamilies).toHaveLength(1);
      expect(preview.alreadyInvoicedFamilies[0]).toMatchObject({ familyGroupId: "family-1", operatorMarked: true, markedByName: null, membersCovered: 3 });
    });
  });

  describe("BASED_ON_AGE_TIER per-tier liability (#2041)", () => {
    // Local-Date DOBs so computeAge compares calendar components against the
    // season-start reference (also a local Date) TZ-independently. Season 2026
    // FY starts 1 Apr 2026 with the default (Mar) year end; age-tier settings
    // fall back to the built-in defaults (INFANT/CHILD exempt, YOUTH/ADULT
    // require) because the prisma mock has no ageTierSetting delegate.
    function ageTierMember(
      id: string,
      overrides: { dateOfBirth?: Date | null; ageTier?: string } = {},
      typeOverrides: Record<string, unknown> = {},
    ) {
      return member(id, {
        dateOfBirth: overrides.dateOfBirth ?? null,
        ageTier: overrides.ageTier ?? "ADULT",
        seasonalMembershipAssignments: [{
          membershipType: {
            id: "type-full",
            key: "FULL",
            name: "Full",
            subscriptionBehavior: "BASED_ON_AGE_TIER",
            annualFees: [fee()],
            ...typeOverrides,
          },
        }],
      });
    }

    it("charges a Youth-at-season-start and skips a Child-at-season-start (owner boundary: 01 Apr vs 31 Mar 10th birthday)", async () => {
      mocks.members.findMany.mockResolvedValue([
        // Turns 10 on 01 Apr -> Youth for the whole 2026 season -> required.
        ageTierMember("youth-01apr", { dateOfBirth: storedDateOfBirth("2016-04-01") }),
        // Turns 10 on 31 Mar (2027, mid-season) -> still a Child at 1 Apr 2026
        // season start -> exempt all season.
        ageTierMember("child-31mar", { dateOfBirth: storedDateOfBirth("2017-03-31") }),
      ]);
      const preview = await buildSubscriptionBillingPreview({
        seasonYear: 2026,
        decisionDate: new Date("2026-07-13T00:00:00.000Z"),
      });
      expect(preview.entries).toHaveLength(1);
      expect(preview.entries[0].coveredMembers).toEqual([
        { id: "youth-01apr", name: "First-youth-01apr Member" },
      ]);
      expect(preview.exemptMemberIds).toEqual(["child-31mar"]);
    });

    it("derives the tier from DOB at season start, never current-date age (a Child who turns 10 mid-season stays exempt)", async () => {
      // Freeze 'now' well after their 10th birthday; billing must ignore it and
      // use the 1 Apr 2026 season-start age (9 -> Child -> exempt).
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-12-01T00:00:00.000Z"));
      try {
        mocks.members.findMany.mockResolvedValue([
          ageTierMember("late-birthday", { dateOfBirth: storedDateOfBirth("2016-05-01") }), // 01 May 2016 -> 9 at 1 Apr 2026
        ]);
        const preview = await buildSubscriptionBillingPreview({
          seasonYear: 2026,
          decisionDate: new Date("2026-07-13T00:00:00.000Z"),
        });
        expect(preview.entries).toHaveLength(0);
        expect(preview.exemptMemberIds).toEqual(["late-birthday"]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("falls back to the stored tier when DOB is unknown — ADULT default is fail-closed/required", async () => {
      mocks.members.findMany.mockResolvedValue([
        ageTierMember("no-dob-adult", { dateOfBirth: null, ageTier: "ADULT" }),
        ageTierMember("no-dob-child", { dateOfBirth: null, ageTier: "CHILD" }),
      ]);
      const preview = await buildSubscriptionBillingPreview({
        seasonYear: 2026,
        decisionDate: new Date("2026-07-13T00:00:00.000Z"),
      });
      expect(preview.entries.flatMap((entry) => entry.coveredMembers.map((m) => m.id)))
        .toEqual(["no-dob-adult"]);
      expect(preview.exemptMemberIds).toEqual(["no-dob-child"]);
    });

    it("a liable Youth mints the SAME charge a REQUIRED type would — key and amount byte-unchanged", async () => {
      mocks.members.findMany.mockResolvedValue([
        ageTierMember("youth", { dateOfBirth: storedDateOfBirth("2016-04-01") }),
      ]);
      const ageTierPreview = await buildSubscriptionBillingPreview({
        seasonYear: 2026,
        decisionDate: new Date("2026-07-13T00:00:00.000Z"),
      });
      mocks.members.findMany.mockResolvedValue([
        member("youth", {
          dateOfBirth: storedDateOfBirth("2016-04-01"),
          ageTier: "YOUTH",
          seasonalMembershipAssignments: [{
            membershipType: { id: "type-full", key: "FULL", name: "Full", subscriptionBehavior: "REQUIRED", annualFees: [fee()] },
          }],
        }),
      ]);
      const requiredPreview = await buildSubscriptionBillingPreview({
        seasonYear: 2026,
        decisionDate: new Date("2026-07-13T00:00:00.000Z"),
      });
      expect(ageTierPreview.entries[0].key).toBe(requiredPreview.entries[0].key);
      expect(ageTierPreview.entries[0].chargedAmountCents).toBe(requiredPreview.entries[0].chargedAmountCents);
      expect(ageTierPreview.entries[0].membershipTypeId).toBe("type-full");
    });

    it("does not resolve a Xero mapping when the only members are tier-exempt (no invoice entries)", async () => {
      mocks.members.findMany.mockResolvedValue([
        ageTierMember("child", { dateOfBirth: storedDateOfBirth("2017-03-31") }),
      ]);
      const preview = await buildSubscriptionBillingPreview({
        seasonYear: 2026,
        decisionDate: new Date("2026-07-13T00:00:00.000Z"),
      });
      expect(preview.entries).toHaveLength(0);
      expect(preview.exemptMemberIds).toEqual(["child"]);
      expect(mocks.mapping).not.toHaveBeenCalled();
    });

    it("PER_FAMILY is unchanged — an exempt Child under BASED_ON_AGE_TIER is still covered by the single family charge (Q5)", async () => {
      mocks.effectiveFee.mockResolvedValue(fee({ billingBasis: "PER_FAMILY", prorationRule: "NONE" }));
      mocks.members.findMany.mockResolvedValue([
        member("child-in-family", {
          dateOfBirth: storedDateOfBirth("2017-03-31"),
          ageTier: "CHILD",
          familyGroupMemberships: [familyMembership()],
          seasonalMembershipAssignments: [{
            membershipType: { id: "type-1", key: "FAMILY", name: "Family", subscriptionBehavior: "BASED_ON_AGE_TIER", annualFees: [fee({ billingBasis: "PER_FAMILY", prorationRule: "NONE" })] },
          }],
        }),
      ]);
      const preview = await buildSubscriptionBillingPreview({
        seasonYear: 2026,
        decisionDate: new Date("2026-04-01T00:00:00.000Z"),
      });
      expect(preview.exemptMemberIds).toEqual([]);
      expect(preview.entries).toHaveLength(1);
      expect(preview.entries[0]).toMatchObject({ billingBasis: "PER_FAMILY", familyGroupId: "family-1" });
    });

    it("REQUIRED-only clubs are byte-unchanged: exemptMemberIds is always empty", async () => {
      mocks.members.findMany.mockResolvedValue([member("m1"), member("m2")]);
      const preview = await buildSubscriptionBillingPreview({
        seasonYear: 2026,
        decisionDate: new Date("2026-07-13T00:00:00.000Z"),
      });
      expect(preview.exemptMemberIds).toEqual([]);
      expect(preview.entries).toHaveLength(2);
    });

    // #2148 (D1): the exemption gate runs BEFORE MISSING_FEE_SCHEDULE and does
    // not require a resolved fee. A deliberately exempt tier legitimately has no
    // fee row, so it must land in the Exempt bucket, not the exceptions list.
    it("#2148: an exempt-tier member with NO fee row is exempted, never raises MISSING_FEE_SCHEDULE", async () => {
      mocks.effectiveFee.mockResolvedValue(null);
      mocks.members.findMany.mockResolvedValue([
        // Child at 1 Apr 2026 season start -> exempt; no fee resolves for CHILD.
        ageTierMember("child-no-fee", { dateOfBirth: storedDateOfBirth("2017-03-31") }),
      ]);
      const preview = await buildSubscriptionBillingPreview({
        seasonYear: 2026,
        decisionDate: new Date("2026-07-13T00:00:00.000Z"),
      });
      expect(preview.exceptions).toEqual([]);
      expect(preview.entries).toEqual([]);
      expect(preview.exemptMemberIds).toEqual(["child-no-fee"]);
      expect(preview.exemptMembers).toEqual([
        { memberId: "child-no-fee", memberName: "First-child-no-fee Member", ageTier: "CHILD" },
      ]);
      // No fee resolved and no invoice entries -> the Xero mapping is not touched.
      expect(mocks.mapping).not.toHaveBeenCalled();
    });

    // #2148 constraint: a LIABLE tier with no fee is a genuine config gap and
    // must still surface, so it is not swept into the Exempt bucket.
    it("#2148: a liable-tier member with NO fee row still raises MISSING_FEE_SCHEDULE (not exempted)", async () => {
      mocks.effectiveFee.mockResolvedValue(null);
      mocks.members.findMany.mockResolvedValue([
        // Youth at season start -> liable; no fee resolves for YOUTH.
        ageTierMember("youth-no-fee", { dateOfBirth: storedDateOfBirth("2016-04-01") }),
      ]);
      const preview = await buildSubscriptionBillingPreview({
        seasonYear: 2026,
        decisionDate: new Date("2026-07-13T00:00:00.000Z"),
      });
      expect(preview.exceptions.map((row) => row.code)).toEqual(["MISSING_FEE_SCHEDULE"]);
      expect(preview.exemptMemberIds).toEqual([]);
      expect(preview.exemptMembers).toEqual([]);
    });
  });

  describe("stored tier vs season-start tier price alignment (#2067 finding 1)", () => {
    // A BASED_ON_AGE_TIER member must be PRICED by the same season-start tier
    // that gates liability — not by the stored tier, which can drift (the age-up
    // cron only maintains the ADULT boundary, and prior-season billing
    // recomputes). Age-tier settings fall back to the built-in defaults (no
    // ageTierSetting delegate on the prisma mock): INFANT/CHILD exempt,
    // YOUTH/ADULT required; YOUTH is age 10-17 at season start.
    function basedMember(
      id: string,
      opts: { dateOfBirth?: Date | null; ageTier?: string } = {},
    ) {
      return member(id, {
        dateOfBirth: opts.dateOfBirth ?? null,
        ageTier: opts.ageTier ?? "ADULT",
        seasonalMembershipAssignments: [{
          membershipType: {
            id: "type-full",
            key: "FULL",
            name: "Full",
            subscriptionBehavior: "BASED_ON_AGE_TIER",
            annualFees: [fee()],
          },
        }],
      });
    }

    // Distinct price per tier so the resolved fee reveals which tier was used.
    function tierPricedFees() {
      const priceByTier: Record<string, number> = { CHILD: 3_000, YOUTH: 6_000, ADULT: 12_000 };
      mocks.effectiveFee.mockImplementation(async ({ ageTier }: { ageTier: string | null }) =>
        fee({ id: `fee-${ageTier}`, amountCents: priceByTier[ageTier ?? ""] ?? 9_999, prorationRule: "NONE" }));
    }

    it("stored CHILD but season-start YOUTH: charged the YOUTH price (liability tier drives the price)", async () => {
      tierPricedFees();
      mocks.members.findMany.mockResolvedValue([
        // Turns 10 on 01 Apr 2026 -> YOUTH at season start; stored tier still CHILD.
        basedMember("drifted-up", { dateOfBirth: storedDateOfBirth("2016-04-01"), ageTier: "CHILD" }),
      ]);
      const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-04-01T00:00:00.000Z") });
      // Resolved by the season-start tier, never the stored CHILD tier.
      expect(mocks.effectiveFee.mock.calls.every((c) => c[0].ageTier === "YOUTH")).toBe(true);
      expect(preview.entries).toHaveLength(1);
      expect(preview.entries[0]).toMatchObject({ membershipAnnualFeeId: "fee-YOUTH", annualAmountCents: 6_000, chargedAmountCents: 6_000 });
      expect(preview.exemptMemberIds).toEqual([]);
    });

    it("stored ADULT but season-start YOUTH (prior-season billing): charged the YOUTH price, not ADULT", async () => {
      tierPricedFees();
      mocks.members.findMany.mockResolvedValue([
        // At 1 Apr 2026 season start they were 10 -> YOUTH; the stored tier has
        // since aged up to ADULT. Billing 2026 must charge the YOUTH price.
        basedMember("drifted-adult", { dateOfBirth: storedDateOfBirth("2016-04-01"), ageTier: "ADULT" }),
      ]);
      const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-04-01T00:00:00.000Z") });
      expect(mocks.effectiveFee.mock.calls.every((c) => c[0].ageTier === "YOUTH")).toBe(true);
      expect(preview.entries[0]).toMatchObject({ membershipAnnualFeeId: "fee-YOUTH", annualAmountCents: 6_000 });
    });

    it("stored == season-start tier: resolves that tier unchanged (no regression)", async () => {
      tierPricedFees();
      mocks.members.findMany.mockResolvedValue([
        basedMember("aligned-youth", { dateOfBirth: storedDateOfBirth("2016-04-01"), ageTier: "YOUTH" }),
      ]);
      const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-04-01T00:00:00.000Z") });
      expect(mocks.effectiveFee.mock.calls.every((c) => c[0].ageTier === "YOUTH")).toBe(true);
      expect(preview.entries[0]).toMatchObject({ membershipAnnualFeeId: "fee-YOUTH", annualAmountCents: 6_000 });
    });

    it("non-age-based type (REQUIRED) prices by the STORED tier, ignoring DOB", async () => {
      tierPricedFees();
      mocks.members.findMany.mockResolvedValue([
        // DOB would compute ADULT at season start, but a REQUIRED type has no
        // computed tier — it must price by the stored YOUTH tier (joining-fee
        // convention). The default member() type is REQUIRED.
        member("required-youth", { ageTier: "YOUTH", dateOfBirth: new Date(1990, 0, 1) }),
      ]);
      const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-04-01T00:00:00.000Z") });
      expect(mocks.effectiveFee.mock.calls.every((c) => c[0].ageTier === "YOUTH")).toBe(true);
      expect(preview.entries[0]).toMatchObject({ membershipAnnualFeeId: "fee-YOUTH", annualAmountCents: 6_000 });
    });

    it("MISSING_FEE_SCHEDULE names the season-start tier actually used, not the stored tier", async () => {
      mocks.effectiveFee.mockResolvedValue(null);
      mocks.members.findMany.mockResolvedValue([
        basedMember("no-youth-fee", { dateOfBirth: storedDateOfBirth("2016-04-01"), ageTier: "CHILD" }),
      ]);
      const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-04-01T00:00:00.000Z") });
      expect(preview.exceptions.map((r) => r.code)).toEqual(["MISSING_FEE_SCHEDULE"]);
      expect(preview.exceptions[0].message).toContain("YOUTH");
      expect(preview.exceptions[0].message).not.toContain("CHILD");
    });
  });

  // Subscription-category decoupling: an independent billing axis, resolved
  // when a member's SeasonalMembershipAssignment carries a subscriptionCategory.
  // Every scenario below keeps membershipType set to the default "Full" type
  // (REQUIRED, PER_MEMBER) specifically to prove the category branch overrides
  // it rather than merely applying when the type would do nothing anyway.
  describe("subscription category billing", () => {
    function categoryFee(overrides: Record<string, unknown> = {}) {
      return {
        id: "cat-fee-1",
        amountCents: 20_000,
        prorationRule: "NONE",
        effectiveFrom: new Date("2026-04-01T00:00:00.000Z"),
        effectiveTo: null,
        ...overrides,
      };
    }

    function categoryMember(id: string, categoryOverrides: Record<string, unknown> = {}, memberOverrides: Record<string, unknown> = {}) {
      return member(id, {
        seasonalMembershipAssignments: [{
          membershipType: { id: "type-1", key: "FULL", name: "Full", subscriptionBehavior: "REQUIRED", annualFees: [fee()] },
          subscriptionCategory: { id: "cat-1", key: "couple", name: "Couple", isActive: true, ...categoryOverrides },
        }],
        ...memberOverrides,
      });
    }

    beforeEach(() => {
      mocks.effectiveCategoryFee.mockResolvedValue(categoryFee());
    });

    it("bills a solo category member alone, at the category rate, with no family group", async () => {
      mocks.members.findMany.mockResolvedValue([categoryMember("solo")]);
      const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-07-13T00:00:00.000Z") });
      expect(preview.exceptions).toEqual([]);
      expect(preview.entries).toHaveLength(1);
      expect(preview.entries[0]).toMatchObject({
        key: "2026:category:cat-1:member:solo",
        membershipTypeId: null,
        membershipTypeKey: null,
        membershipTypeName: null,
        membershipAnnualFeeId: null,
        subscriptionCategoryId: "cat-1",
        subscriptionCategoryKey: "couple",
        subscriptionCategoryName: "Couple",
        subscriptionCategoryFeeId: "cat-fee-1",
        billingBasis: "PER_FAMILY",
        familyGroupId: null,
        chargedAmountCents: 20_000,
      });
      // No per-member type tracking on coveredMembers — those audit columns
      // were dropped from the redesign (write-only, nothing ever read them
      // back; the same fact is already available live via each member's own
      // seasonalMembershipAssignments).
      expect(preview.entries[0].coveredMembers).toEqual([
        { id: "solo", name: "First-solo Member" },
      ]);
      // A single solo category member is not "ungrouped" — there is nobody
      // else sharing the category to have grouped them WITH.
      expect(preview.ungroupedCategoryMembers).toEqual([]);
    });

    // Review finding: two members assigned the SAME category but not in the
    // same FamilyGroup each bill the full flat rate separately — for a
    // couple/family-style category this can cost MORE than individual rates,
    // the opposite of the feature's purpose. Billing itself is unchanged (two
    // solo members remain two legitimate solo charges — a club can have a
    // genuinely standalone category), but this is surfaced so an admin
    // reviewing the run notices and can decide whether to group them.
    it("surfaces two solo members sharing a category as ungroupedCategoryMembers, without blocking or merging their billing", async () => {
      mocks.members.findMany.mockResolvedValue([
        categoryMember("alice"),
        categoryMember("bob"),
      ]);
      const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-07-13T00:00:00.000Z") });
      expect(preview.exceptions).toEqual([]);
      // Still two separate solo charges — this field is informational only.
      expect(preview.entries).toHaveLength(2);
      expect(preview.entries.map((e) => e.key).sort()).toEqual([
        "2026:category:cat-1:member:alice",
        "2026:category:cat-1:member:bob",
      ]);
      expect(preview.ungroupedCategoryMembers).toEqual([
        {
          subscriptionCategoryId: "cat-1",
          subscriptionCategoryName: "Couple",
          members: [
            { memberId: "alice", memberName: "First-alice Member" },
            { memberId: "bob", memberName: "First-bob Member" },
          ],
        },
      ]);
    });

    it("merges two members of the SAME membership type sharing a category and family into one flat charge", async () => {
      mocks.members.findMany.mockResolvedValue([
        categoryMember("a", {}, { familyGroupMemberships: [familyMembership()] }),
        categoryMember("b", {}, { familyGroupMemberships: [familyMembership()] }),
      ]);
      const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-07-13T00:00:00.000Z") });
      expect(preview.exceptions).toEqual([]);
      expect(preview.entries).toHaveLength(1);
      expect(preview.entries[0].key).toBe("2026:category:cat-1:family:family-1");
      expect(preview.entries[0].familyGroupId).toBe("family-1");
      expect(preview.entries[0].chargedAmountCents).toBe(20_000);
      expect(preview.entries[0].recipient.id).toBe("billing-1");
      expect(preview.entries[0].coveredMembers.map((c) => c.id).sort()).toEqual(["a", "b"]);
    });

    it("merges two members of DIFFERENT membership types sharing a category into one flat charge", async () => {
      mocks.members.findMany.mockResolvedValue([
        categoryMember("senior", {}, { familyGroupMemberships: [familyMembership()] }),
        categoryMember("life", {}, {
          familyGroupMemberships: [familyMembership()],
          seasonalMembershipAssignments: [{
            membershipType: { id: "type-2", key: "LIFE_A", name: "Life Member A", subscriptionBehavior: "REQUIRED", annualFees: [] },
            subscriptionCategory: { id: "cat-1", key: "couple", name: "Couple", isActive: true },
          }],
        }),
      ]);
      const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-07-13T00:00:00.000Z") });
      expect(preview.exceptions).toEqual([]);
      expect(preview.entries).toHaveLength(1);
      // No per-member type tracking on coveredMembers (dropped from the
      // redesign) — both members are simply covered by the one flat charge,
      // regardless of each holding a different membership type.
      expect(preview.entries[0].coveredMembers.map((c) => c.id).sort()).toEqual(["life", "senior"]);
      // Both bill once, together, at the flat category rate — not per-type.
      expect(preview.entries[0].chargedAmountCents).toBe(20_000);
    });

    // Review point 3 ("one rule for who is exempt"): category billing no
    // longer overrides a member's own type-based exemption — it routes
    // through the SAME settlement resolver (resolveMemberSubscriptionSettlement)
    // the booking-access gates trust, so a member that resolver treats as
    // exempt is never billed via category either.
    it("does not override the member's own exemption (NOT_REQUIRED type) — category billing respects it", async () => {
      mocks.members.findMany.mockResolvedValue([
        categoryMember("exempt-member", {}, {
          seasonalMembershipAssignments: [{
            membershipType: { id: "type-2", key: "LIFE", name: "Life Member", subscriptionBehavior: "NOT_REQUIRED", annualFees: [] },
            subscriptionCategory: { id: "cat-1", key: "couple", name: "Couple", isActive: true },
          }],
        }),
      ]);
      const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-07-13T00:00:00.000Z") });
      expect(preview.entries).toHaveLength(0);
      expect(preview.exceptions).toEqual([]);
      expect(preview.exemptMemberIds).toContain("exempt-member");
      expect(mocks.effectiveCategoryFee).not.toHaveBeenCalled();
    });

    // Review finding, corrected: an archived category on a live assignment
    // used to fall through to type billing SILENTLY — no exception, no
    // trace — which could re-price the member (losing a flat couple/family
    // rate) with nothing telling the admin why. It now withholds billing with
    // ARCHIVED_SUBSCRIPTION_CATEGORY_ASSIGNED until the admin resolves it.
    it("raises ARCHIVED_SUBSCRIPTION_CATEGORY_ASSIGNED and withholds billing when the assigned category is archived", async () => {
      mocks.members.findMany.mockResolvedValue([
        categoryMember("inactive-cat", { isActive: false }),
      ]);
      const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-07-13T00:00:00.000Z") });
      expect(preview.entries).toHaveLength(0);
      expect(preview.exceptions.map((r) => r.code)).toEqual(["ARCHIVED_SUBSCRIPTION_CATEGORY_ASSIGNED"]);
      expect(preview.exceptions[0]).toMatchObject({ memberId: "inactive-cat", subscriptionCategoryId: "cat-1" });
      expect(mocks.effectiveCategoryFee).not.toHaveBeenCalled();
    });

    it("raises MISSING_CATEGORY_FEE_SCHEDULE when no SubscriptionCategoryFee is effective", async () => {
      mocks.effectiveCategoryFee.mockResolvedValue(null);
      mocks.members.findMany.mockResolvedValue([categoryMember("no-fee")]);
      const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-07-13T00:00:00.000Z") });
      expect(preview.entries).toHaveLength(0);
      expect(preview.exceptions.map((r) => r.code)).toEqual(["MISSING_CATEGORY_FEE_SCHEDULE"]);
      expect(preview.exceptions[0].subscriptionCategoryId).toBe("cat-1");
      expect(preview.exceptions[0].membershipTypeId).toBeNull();
    });

    // Review finding, corrected: the fingerprint must NOT widen for every
    // exception (that moved every pre-existing type-only exception's
    // fingerprint and falsely "resolved" all of them on the next reconcile).
    // The one real gap is two DIFFERENT categories' MISSING_CATEGORY_FEE_SCHEDULE
    // for the same member colliding, since both have membershipTypeId null —
    // that is the one case the fingerprint must actually distinguish.
    it("gives two different categories' exceptions for the same member DIFFERENT fingerprints, so neither shadows the other", async () => {
      mocks.effectiveCategoryFee.mockResolvedValue(null);
      mocks.members.findMany.mockResolvedValueOnce([categoryMember("m", { id: "cat-1" })]);
      const previewA = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-07-13T00:00:00.000Z") });
      mocks.members.findMany.mockResolvedValueOnce([categoryMember("m", { id: "cat-2" })]);
      const previewB = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-07-13T00:00:00.000Z") });
      expect(previewA.exceptions[0].code).toBe("MISSING_CATEGORY_FEE_SCHEDULE");
      expect(previewB.exceptions[0].code).toBe("MISSING_CATEGORY_FEE_SCHEDULE");
      expect(previewA.exceptions[0].fingerprint).not.toBe(previewB.exceptions[0].fingerprint);
    });

    it("leaves a type-only exception's fingerprint exactly as it was before the category axis existed (no spurious resolve on deploy)", async () => {
      mocks.members.findMany.mockResolvedValue([member("no-assignment", { seasonalMembershipAssignments: [] })]);
      const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-07-13T00:00:00.000Z") });
      expect(preview.exceptions.map((r) => r.code)).toEqual(["MISSING_MEMBERSHIP_ASSIGNMENT"]);
      // The ORIGINAL, pre-category-axis digest shape: [seasonYear, code,
      // memberId, familyGroupId, membershipTypeId], nothing appended — computed
      // with the SAME canonical digest function the module itself imports, not
      // a hand-typed hash literal.
      expect(preview.exceptions[0].fingerprint).toBe(
        stableDigest([2026, "MISSING_MEMBERSHIP_ASSIGNMENT", "no-assignment", null, null]),
      );
    });

    it("reuses AMBIGUOUS_FAMILY for a category member in more than one family", async () => {
      mocks.members.findMany.mockResolvedValue([
        categoryMember("multi-family", {}, {
          familyGroupMemberships: [familyMembership(), familyMembershipFor("family-2")],
        }),
      ]);
      const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-07-13T00:00:00.000Z") });
      expect(preview.entries).toHaveLength(0);
      expect(preview.exceptions.map((r) => r.code)).toEqual(["AMBIGUOUS_FAMILY"]);
    });

    it("solo category billing (kind NONE) is NOT an error, unlike the type axis's MISSING_FAMILY for a PER_FAMILY type", async () => {
      // No familyGroupMemberships at all — resolveBillingFamilyMembership
      // returns NONE. The type axis would raise MISSING_FAMILY for a
      // PER_FAMILY-billed member in this shape; the category axis bills them
      // alone instead, by design (see the branch's own comment).
      mocks.members.findMany.mockResolvedValue([categoryMember("alone", {}, { familyGroupMemberships: [] })]);
      const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-07-13T00:00:00.000Z") });
      expect(preview.exceptions).toEqual([]);
      expect(preview.entries).toHaveLength(1);
      expect(preview.entries[0].familyGroupId).toBeNull();
    });

    it("mirrors PER_FAMILY_FEE_IN_INDIVIDUAL_MODE under the club's individual billing mode", async () => {
      mocks.familyMode.mockResolvedValue("BILL_MEMBERS_INDIVIDUALLY");
      mocks.members.findMany.mockResolvedValue([categoryMember("solo-indiv")]);
      const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-07-13T00:00:00.000Z") });
      expect(preview.entries).toHaveLength(0);
      expect(preview.exceptions.map((r) => r.code)).toEqual(["PER_FAMILY_FEE_IN_INDIVIDUAL_MODE"]);
      expect(mocks.effectiveCategoryFee).not.toHaveBeenCalled();
    });

    // These four dedup tests use the SAME `familyCharge` fixture helper the
    // type-axis closed-family tests use (above), with `membershipTypeId:
    // null, subscriptionCategoryId: "cat-1"` overrides — category charges
    // now flow through the SAME generalized #4110 machinery
    // (`billedFamilyTypes`/`resolveClosedFamilyDecision`), fed by the SAME
    // single query, so a category fixture needs the same shape a type
    // fixture does (coverage rows carrying `subscription.member` for
    // `isBilledThroughFamily`, `subscriptionStatusAtClose` for
    // `wasPaidAtClose`) — not the old simplified
    // `{ coverage: [{ subscription: { memberId, status } }] }` shape.
    it("raises FAMILY_ALREADY_BILLED for a late joiner into an already-LIVE category/family charge", async () => {
      mocks.charges.findMany.mockResolvedValue([
        familyCharge("QUEUED", [], { id: "existing-category-charge", membershipTypeId: null, subscriptionCategoryId: "cat-1" }),
      ]);
      mocks.members.findMany.mockResolvedValue([
        categoryMember("late-joiner", {}, { familyGroupMemberships: [familyMembership()] }),
      ]);
      const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-07-13T00:00:00.000Z") });
      expect(preview.entries).toHaveLength(0);
      expect(preview.exceptions.map((r) => r.code)).toEqual(["FAMILY_ALREADY_BILLED"]);
      expect(preview.exceptions[0].context).toMatchObject({ existingFamilyChargeId: "existing-category-charge" });
    });

    // Review finding: a category charge closed as already paid (#4098) used
    // to permanently block a re-bill via FAMILY_ALREADY_BILLED even after a
    // payment reversal left a covered member unsettled again — with a
    // message claiming they "joined after" the charge, which is false. It now
    // withholds with CLOSED_FAMILY_MEMBER_NEEDS_DECISION, the same actionable
    // code the type axis raises for the equivalent reversal case. The
    // covered member's CURRENT subscription status (not merely "reached this
    // code") is what decides it — see the second review round's fix to the
    // first version of this test, which could not tell a genuine reversal
    // apart from a settled-but-exempt member (the next test below).
    it("raises CLOSED_FAMILY_MEMBER_NEEDS_DECISION, not FAMILY_ALREADY_BILLED, when a closed-as-paid category charge's member is unsettled again", async () => {
      // [memberName, subscriptionStatus now, status the close recorded]:
      // exempt (NOT_REQUIRED) at close, owing now. A SINGLE charge's own
      // reversal ("paid at close, reversed now") is deliberately NOT used
      // here — per the #4110 design this generalization now reuses
      // verbatim, a reversal under the NEWEST (here, only) charge re-bills
      // the family normally rather than withholding it; EXEMPT_AT_CLOSE is
      // the reason representable with one charge.
      mocks.charges.findMany.mockResolvedValue([
        familyCharge("NOT_REQUIRED", [["reversed-member", "UNPAID", "NOT_REQUIRED"]], {
          id: "closed-category-charge", membershipTypeId: null, subscriptionCategoryId: "cat-1",
        }),
      ]);
      mocks.members.findMany.mockResolvedValue([
        categoryMember("reversed-member", {}, { familyGroupMemberships: [familyMembership()] }),
      ]);
      const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-07-13T00:00:00.000Z") });
      expect(preview.entries).toHaveLength(0);
      expect(preview.exceptions.map((r) => r.code)).toEqual(["CLOSED_FAMILY_MEMBER_NEEDS_DECISION"]);
      expect(preview.exceptions[0]).toMatchObject({
        memberId: "reversed-member",
        familyGroupId: "family-1",
        context: expect.objectContaining({ existingFamilyChargeId: "closed-category-charge" }),
      });
    });

    // Second review-round finding: reaching this code (not in coveredSet or
    // paidSet at the loop top) does NOT by itself mean "unsettled" — a member
    // can be settled via NOT_REQUIRED exemption, which neither set captures.
    // "A covered member still settled has nothing to decide" (the type
    // axis's own rule for the identical case): this member must fall through
    // completely silently, no entry and no exception, exactly as if the
    // closed charge did not exist.
    it("raises nothing for a member the closed charge covered who is STILL settled (exempt, not reversed)", async () => {
      mocks.charges.findMany.mockResolvedValue([
        // Exempt at close (statusAtClose null -> read as PAID by wasPaidAtClose's
        // own default — so use NOT_REQUIRED now too: still settled either way).
        familyCharge("NOT_REQUIRED", [["still-settled", "NOT_REQUIRED", "NOT_REQUIRED"]], {
          id: "closed-category-charge", membershipTypeId: null, subscriptionCategoryId: "cat-1",
        }),
      ]);
      mocks.members.findMany.mockResolvedValue([
        categoryMember("still-settled", {}, { familyGroupMemberships: [familyMembership()] }),
      ]);
      const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-07-13T00:00:00.000Z") });
      expect(preview.entries).toHaveLength(0);
      expect(preview.exceptions).toEqual([]);
    });

    // And a member the closed charge never covered at all (a genuine late
    // joiner) must still raise the ordinary FAMILY_ALREADY_BILLED, exactly as
    // against a LIVE charge — not the decision code, which is only for a
    // member the closed charge DID cover.
    it("raises plain FAMILY_ALREADY_BILLED for a member the closed charge never covered (a late joiner, not a reversal)", async () => {
      mocks.charges.findMany.mockResolvedValue([
        familyCharge("NOT_REQUIRED", [["someone-else", "PAID", "PAID"]], {
          id: "closed-category-charge", membershipTypeId: null, subscriptionCategoryId: "cat-1",
        }),
      ]);
      mocks.members.findMany.mockResolvedValue([
        categoryMember("late-joiner-2", {}, { familyGroupMemberships: [familyMembership()] }),
      ]);
      const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-07-13T00:00:00.000Z") });
      expect(preview.entries).toHaveLength(0);
      expect(preview.exceptions.map((r) => r.code)).toEqual(["FAMILY_ALREADY_BILLED"]);
    });

    it("existing type-axis tests are unaffected: a member with no subscriptionCategory on their assignment takes the unmodified type path", async () => {
      mocks.members.findMany.mockResolvedValue([member("unchanged")]);
      const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-07-13T00:00:00.000Z") });
      expect(preview.entries).toHaveLength(1);
      expect(preview.entries[0].membershipTypeId).toBe("type-1");
      expect(mocks.effectiveCategoryFee).not.toHaveBeenCalled();
    });

    // Review finding: the category branch and the type-axis PER_FAMILY branch
    // dedup on DIFFERENT strings for the same family (`category:<id>:family:<fg>`
    // vs `<typeId>:family:<fg>`), so neither used to notice the other had
    // already billed it this run — a family with one categorized member and
    // one PER_FAMILY-type member got billed on BOTH axes. These two tests cover
    // both processing orders, since whichever axis's member the loop reaches
    // first is the one that wins and the other is withheld.
    it("withholds a family's type-axis PER_FAMILY charge when a sibling already has a category charge this run (category processed first)", async () => {
      const familyTypeFee = fee({ id: "fee-family", billingBasis: "PER_FAMILY", prorationRule: "NONE" });
      mocks.effectiveFee.mockResolvedValue(familyTypeFee);
      mocks.members.findMany.mockResolvedValue([
        categoryMember("alice", {}, { familyGroupMemberships: [familyMembership()] }),
        member("bob", {
          seasonalMembershipAssignments: [{
            membershipType: { id: "type-2", key: "JUNIOR", name: "Junior", subscriptionBehavior: "REQUIRED", annualFees: [familyTypeFee] },
          }],
          familyGroupMemberships: [familyMembership()],
        }),
      ]);
      const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-07-13T00:00:00.000Z") });
      // Exactly ONE charge for the family — the category charge Alice minted
      // first — never a second PER_FAMILY charge for Bob's type on top of it.
      expect(preview.entries).toHaveLength(1);
      expect(preview.entries[0].key).toBe("2026:category:cat-1:family:family-1");
      expect(preview.exceptions.map((r) => r.code)).toEqual(["MIXED_AXIS_FAMILY_BILLING"]);
      expect(preview.exceptions[0]).toMatchObject({ memberId: "bob", familyGroupId: "family-1" });
    });

    it("withholds a family's category charge when a sibling already has a type-axis PER_FAMILY charge this run (type processed first)", async () => {
      const familyTypeFee = fee({ id: "fee-family", billingBasis: "PER_FAMILY", prorationRule: "NONE" });
      mocks.effectiveFee.mockResolvedValue(familyTypeFee);
      mocks.members.findMany.mockResolvedValue([
        member("bob", {
          seasonalMembershipAssignments: [{
            membershipType: { id: "type-2", key: "JUNIOR", name: "Junior", subscriptionBehavior: "REQUIRED", annualFees: [familyTypeFee] },
          }],
          familyGroupMemberships: [familyMembership()],
        }),
        categoryMember("alice", {}, { familyGroupMemberships: [familyMembership()] }),
      ]);
      const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-07-13T00:00:00.000Z") });
      // Exactly ONE charge for the family — Bob's type-axis PER_FAMILY charge,
      // minted first — never a second category charge for Alice on top of it.
      expect(preview.entries).toHaveLength(1);
      expect(preview.entries[0].key).toBe("2026:type:type-2:family:family-1");
      expect(preview.exceptions.map((r) => r.code)).toEqual(["MIXED_AXIS_FAMILY_BILLING"]);
      expect(preview.exceptions[0]).toMatchObject({ memberId: "alice", familyGroupId: "family-1" });
    });
  });
});
