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
  familyMode: vi.fn(),
  mapping: vi.fn(),
}));

vi.mock("@/lib/authoritative-fees", () => ({
  getEffectiveMembershipAnnualFee: mocks.effectiveFee,
  getFamilyBillingMode: mocks.familyMode,
}));
// Keep getResolvedAccountMapping mocked (billing relies on the mock), but expose
// the REAL getSubscriptionItemCodes so the #2109 FIX-4d closed-loop test can
// assert the codes billing stamps are a subset of the detection resolver output.
vi.mock("@/lib/xero-mappings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/xero-mappings")>();
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
import { getSubscriptionItemCodes } from "@/lib/xero-mappings";
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

  it("re-bills a new-system PER_FAMILY family once its charge is VOIDED (coverage released) (#2147)", async () => {
    // After a NEW-system PER_FAMILY charge's Xero invoice is voided, the void
    // handler (releaseVoidedSubscriptionInvoice) keeps the charge row with
    // status VOIDED and familyGroupId intact for audit, releases coverage
    // (releasedAt set) and nulls the subscription link. The existingFamilyCharges
    // query must exclude VOIDED rows so the retained charge no longer populates
    // billedFamilyTypes — otherwise it fires FAMILY_ALREADY_BILLED and blocks the
    // family's re-bill forever, contradicting the void→re-bill design.
    const annual = fee({ id: "fee-new", billingBasis: "PER_FAMILY", prorationRule: "NONE" });
    mocks.effectiveFee.mockResolvedValue(annual);
    // Filter-aware mock mirrors the real DB: apply the where.status filter to a
    // fixture holding one VOIDED family charge.
    const voidedCharge = { id: "charge-voided", familyGroupId: "family-1", membershipTypeId: "type-1", status: "VOIDED" };
    mocks.charges.findMany.mockImplementation((args?: { where?: { status?: { not?: string } } }) => {
      const notStatus = args?.where?.status?.not;
      return Promise.resolve([voidedCharge].filter((charge) => (notStatus ? charge.status !== notStatus : true)));
    });
    mocks.coverage.findMany.mockResolvedValue([]); // released by the void
    mocks.subscriptions.findMany.mockResolvedValue([]); // link nulled by the void
    mocks.members.findMany.mockResolvedValue([
      member("re-billable", { familyGroupMemberships: [familyMembership()] }),
    ]);
    const preview = await buildSubscriptionBillingPreview({
      seasonYear: 2026,
      decisionDate: new Date("2026-08-01T00:00:00.000Z"),
    });
    // The retained VOIDED charge is excluded, so the family re-bills as one entry.
    expect(preview.entries).toHaveLength(1);
    expect(preview.entries[0]).toMatchObject({
      billingBasis: "PER_FAMILY",
      familyGroupId: "family-1",
      recipient: { id: "billing-1" },
    });
    expect(preview.exceptions.some((row) => row.code === "FAMILY_ALREADY_BILLED")).toBe(false);
    // The query must carry the VOIDED filter that makes this correct.
    expect(mocks.charges.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: { not: "VOIDED" } }),
    }));
  });

  it("control: a live (non-VOIDED) PER_FAMILY charge still blocks with FAMILY_ALREADY_BILLED (#2147)", async () => {
    // Same fixture, but the charge is live (e.g. UNPAID). The VOIDED filter keeps
    // it in existingFamilyCharges, so a late-joining family member is correctly
    // blocked — proving the filter narrows only VOIDED rows, not live ones.
    const annual = fee({ id: "fee-new", billingBasis: "PER_FAMILY", prorationRule: "NONE" });
    mocks.effectiveFee.mockResolvedValue(annual);
    const liveCharge = { id: "charge-live", familyGroupId: "family-1", membershipTypeId: "type-1", status: "UNPAID" };
    mocks.charges.findMany.mockImplementation((args?: { where?: { status?: { not?: string } } }) => {
      const notStatus = args?.where?.status?.not;
      return Promise.resolve([liveCharge].filter((charge) => (notStatus ? charge.status !== notStatus : true)));
    });
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
      mocks.charges.findMany.mockResolvedValue([{ id: "charge-B", familyGroupId: "family-B", membershipTypeId: "type-1" }]);
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
    const perFamilyFee = () => fee({ id: "fee-fam", billingBasis: "PER_FAMILY", prorationRule: "NONE" });
    const perMemberFee = () => fee({ id: "fee-pm", billingBasis: "PER_MEMBER", prorationRule: "NONE" });
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
});
