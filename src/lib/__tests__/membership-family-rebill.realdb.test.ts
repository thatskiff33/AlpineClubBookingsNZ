/**
 * Real-PostgreSQL proof that a family whose per-family charge was VOIDED in Xero
 * (#2147) or CLOSED as already paid (#4098) can be billed again (#4110; owner
 * decision on #4098, 15 Oct 2026: a closed family charge is re-billable).
 *
 * Both paths release the old charge's coverage claims and keep its row. The
 * old row still carries the family, membership type and season, so before
 * #4110 the family/type/season unique index refused the second charge and
 * failed the whole confirm. The index now constrains only charges that can
 * still be invoiced (every status outside MEMBERSHIP_CHARGE_NO_INVOICE_STATUSES),
 * which is what these proofs drive end to end: close (or void) -> reverse ->
 * preview -> confirm -> a new QUEUED family charge. A third proof pins that two
 * LIVE charges for one family/type/season are still refused.
 *
 * The #4110 review adds two: an exempt member's assignment re-saved after the
 * close moves their NOT_REQUIRED row to NOT_INVOICED through the real save
 * path, and the family stays billed (only a reversed PAYMENT re-bills, F1);
 * and a membership approval, which has no officer to see the partly-reversed
 * warning, withholds the family for Finance instead of invoicing it (F2).
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so CI reaches it; it owns and cleans its own
 * `race-4110-` fixtures.
 *
 * To run directly against a throwaway scratch database:
 *   RUN_CONCURRENCY_RACE_TESTS=1 \
 *   CONCURRENCY_RACE_DATABASE_URL=postgresql://user:pass@127.0.0.1:55442/concurrency_race_1881 \
 *   pnpm exec vitest run src/lib/__tests__/membership-family-rebill.realdb.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
const RACE_TEST_TIMEOUT_MS = 30_000;

const PARENT_ID = "race-4110-parent";
const CHILD_ID = "race-4110-child";
const OFFICER_ID = "race-4110-officer";
const JOINER_ID = "race-4110-joiner";
const MEMBER_IDS = [PARENT_ID, CHILD_ID] as const;
const FAMILY_ID = "race-4110-family";
const BILLING_MEMBERSHIP_ID = "race-4110-family-parent";
const TYPE_ID = "race-4110-type";
const FEE_ID = "race-4110-fee";
const OLD_CHARGE_ID = "race-4110-old-charge";
const SEASON_YEAR = 2026;
const DECISION_DATE = new Date("2026-07-01T00:00:00.000Z");
const YEAR_END_MONTH = 3;
const MAPPING_KEY = "subscriptionIncome";
const FAMILY_FEE_CENTS = 30_000;
const RESAVE_APPLY_FROM = "2026-08-01";

/** Standalone fail-closed copy: importing this file must not register another suite. */
function assertSafeRaceDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Family re-bill proofs need a valid CONCURRENCY_RACE_DATABASE_URL.");
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(
      `Refusing to run family re-bill proofs against port ${parsed.port || "(none)"}: use a throwaway PostgreSQL on 55442+ (never 5432).`,
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error("Family re-bill proof DB must be loopback-only.");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName.includes("concurrency_race_1881")) {
    throw new Error("Family re-bill proof DB name must contain 'concurrency_race_1881'.");
  }
}

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let billing: typeof import("@/lib/membership-subscription-billing");
let closeAlreadyPaidSubscriptionCharge: (typeof import("@/lib/membership-subscription-charge-close"))["closeAlreadyPaidSubscriptionCharge"];
let createdMapping = false;
let priorXeroModule: { xeroIntegration: boolean } | null = null;

(RUN ? describe : describe.skip)(
  "a family is billed again after its family charge is closed or voided — real PostgreSQL (#4110)",
  { timeout: RACE_TEST_TIMEOUT_MS },
  () => {
    async function familyChargeIds(): Promise<string[]> {
      const rows = await prisma.membershipSubscriptionCharge.findMany({
        where: { familyGroupId: FAMILY_ID },
        select: { id: true },
      });
      return rows.map((row) => row.id);
    }

    async function deleteFixtures() {
      const chargeIds = await familyChargeIds();
      await prisma.auditLog.deleteMany({ where: { entityId: { in: chargeIds } } });
      // The assignment re-save's own audit rows (#4110 review F1).
      await prisma.auditLog.deleteMany({
        where: { OR: [{ memberId: OFFICER_ID }, { subjectMemberId: { in: [...MEMBER_IDS, JOINER_ID] } }] },
      });
      await prisma.xeroSyncOperation.deleteMany({
        where: { localModel: "MembershipSubscriptionCharge", localId: { in: chargeIds } },
      });
      await prisma.membershipSubscriptionChargeComponent.deleteMany({ where: { chargeId: { in: chargeIds } } });
      await prisma.membershipSubscriptionChargeCoverage.deleteMany({ where: { chargeId: { in: chargeIds } } });
      await prisma.membershipSubscriptionCharge.deleteMany({ where: { id: { in: chargeIds } } });
      await prisma.membershipBillingException.deleteMany({
        where: { OR: [{ memberId: { in: [...MEMBER_IDS, JOINER_ID] } }, { familyGroupId: FAMILY_ID }] },
      });
      await prisma.memberSubscription.deleteMany({ where: { memberId: { in: [...MEMBER_IDS, JOINER_ID] } } });
      await prisma.seasonalMembershipAssignment.deleteMany({ where: { memberId: { in: [...MEMBER_IDS, JOINER_ID] } } });
      await prisma.familyGroup.updateMany({ where: { id: FAMILY_ID }, data: { billingMembershipId: null } });
      await prisma.familyGroupMember.deleteMany({ where: { familyGroupId: FAMILY_ID } });
      await prisma.familyGroup.deleteMany({ where: { id: FAMILY_ID } });
      await prisma.membershipAnnualFeeComponent.deleteMany({ where: { membershipAnnualFeeId: FEE_ID } });
      await prisma.membershipAnnualFee.deleteMany({ where: { id: FEE_ID } });
      await prisma.membershipType.deleteMany({ where: { id: TYPE_ID } });
      await prisma.member.deleteMany({ where: { id: { in: [...MEMBER_IDS, OFFICER_ID, JOINER_ID] } } });
    }

    /** A family of two, both PAID by hand, whose family charge conflicted. */
    async function seedPaidFamilyWithConflictedCharge() {
      for (const id of [...MEMBER_IDS, OFFICER_ID]) {
        await prisma.member.create({
          data: {
            id,
            email: `${id}@example.invalid`,
            passwordHash: "not-a-real-password",
            firstName: "Rebill",
            lastName: id.replace("race-4110-", ""),
            ageTier: "ADULT",
          },
        });
      }
      await prisma.membershipType.create({
        data: { id: TYPE_ID, key: "race-4110-family-type", name: "Race 4110 Family", subscriptionBehavior: "REQUIRED" },
      });
      await prisma.membershipAnnualFee.create({
        data: {
          id: FEE_ID,
          membershipTypeId: TYPE_ID,
          ageTier: null,
          amountCents: FAMILY_FEE_CENTS,
          billingBasis: "PER_FAMILY",
          prorationRule: "NONE",
          effectiveFrom: new Date("2026-04-01T00:00:00.000Z"),
          components: { create: [{ label: "Family fee", amountCents: FAMILY_FEE_CENTS, prorate: false }] },
        },
      });
      await prisma.familyGroup.create({ data: { id: FAMILY_ID, name: "Race 4110 family" } });
      await prisma.familyGroupMember.create({ data: { id: BILLING_MEMBERSHIP_ID, familyGroupId: FAMILY_ID, memberId: PARENT_ID } });
      await prisma.familyGroupMember.create({ data: { familyGroupId: FAMILY_ID, memberId: CHILD_ID } });
      await prisma.familyGroup.update({ where: { id: FAMILY_ID }, data: { billingMembershipId: BILLING_MEMBERSHIP_ID } });
      const subscriptionIds: string[] = [];
      for (const memberId of MEMBER_IDS) {
        await prisma.seasonalMembershipAssignment.create({
          data: { memberId, seasonYear: SEASON_YEAR, membershipTypeId: TYPE_ID },
        });
        const subscription = await prisma.memberSubscription.create({
          data: {
            memberId,
            seasonYear: SEASON_YEAR,
            status: "PAID",
            manuallyMarkedPaidAt: new Date("2026-06-15T00:00:00.000Z"),
            manuallyMarkedPaidByMemberId: OFFICER_ID,
          },
        });
        subscriptionIds.push(subscription.id);
      }
      await prisma.membershipSubscriptionCharge.create({
        data: {
          id: OLD_CHARGE_ID,
          idempotencyKey: "race-4110-old-charge-key",
          seasonYear: SEASON_YEAR,
          source: "ANNUAL_BATCH",
          status: "CONFLICT",
          membershipAnnualFeeId: FEE_ID,
          membershipTypeId: TYPE_ID,
          membershipTypeKey: "race-4110-family-type",
          membershipTypeName: "Race 4110 Family",
          billingBasis: "PER_FAMILY",
          prorationRule: "NONE",
          annualAmountCents: FAMILY_FEE_CENTS,
          chargedAmountCents: FAMILY_FEE_CENTS,
          coveredMonths: 12,
          decisionDate: new Date("2026-06-01T00:00:00.000Z"),
          coverageStart: new Date("2026-04-01T00:00:00.000Z"),
          coverageEnd: new Date("2027-03-31T00:00:00.000Z"),
          familyGroupId: FAMILY_ID,
          recipientMemberId: PARENT_ID,
          recipientName: "Rebill parent",
          recipientEmail: `${PARENT_ID}@example.invalid`,
          dueDays: 30,
          xeroAccountCode: "203",
          invoiceReference: "MEMSUB-RACE-4110-OLD",
          lastErrorCode: "SUBSCRIPTION_ALREADY_PAID",
          lastErrorMessage: "Covered subscriptions are already PAID.",
          coverage: {
            create: MEMBER_IDS.map((memberId, index) => ({
              subscriptionId: subscriptionIds[index]!,
              memberId,
              memberName: `Rebill ${memberId.replace("race-4110-", "")}`,
            })),
          },
        },
      });
    }

    /** The manual reversal's own write: the child's payment was recorded by mistake. */
    async function reverseChildPayment() {
      await prisma.memberSubscription.updateMany({
        where: { memberId: CHILD_ID, seasonYear: SEASON_YEAR, status: "PAID" },
        data: { status: "NOT_INVOICED", manuallyMarkedPaidAt: null, manuallyMarkedPaidByMemberId: null },
      });
    }

    /** What `releaseVoidedSubscriptionInvoice` leaves behind (#2147), for a charge Xero voided. */
    async function voidOldCharge() {
      await prisma.membershipSubscriptionCharge.update({
        where: { id: OLD_CHARGE_ID },
        data: { status: "VOIDED", lastErrorCode: null, lastErrorMessage: null },
      });
      await prisma.membershipSubscriptionChargeCoverage.updateMany({
        where: { chargeId: OLD_CHARGE_ID, releasedAt: null },
        data: { releasedAt: new Date() },
      });
      await prisma.memberSubscription.updateMany({
        where: { memberId: { in: [...MEMBER_IDS] }, seasonYear: SEASON_YEAR },
        data: { voidGeneration: { increment: 1 }, status: "NOT_INVOICED", manuallyMarkedPaidAt: null, manuallyMarkedPaidByMemberId: null },
      });
    }

    async function previewAndConfirm() {
      const preview = await billing.buildSubscriptionBillingPreview({
        seasonYear: SEASON_YEAR,
        decisionDate: DECISION_DATE,
        memberIds: [...MEMBER_IDS],
        yearEndMonth: YEAR_END_MONTH,
      });
      const confirmed = await billing.confirmSubscriptionBillingPreview({
        preview,
        expectedConfirmationToken: preview.confirmationToken,
        // An officer's confirm of the billing run: it acknowledges a warning
        // and invoices through it (a membership approval withholds instead).
        source: "ANNUAL_BATCH",
        confirmedByMemberId: OFFICER_ID,
      });
      return { preview, confirmed };
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      billing = await import("@/lib/membership-subscription-billing");
      ({ closeAlreadyPaidSubscriptionCharge } = await import("@/lib/membership-subscription-charge-close"));
      // #4986 (INV-INT-038): subscription invoicing refuses while Xero is off,
      // and the module defaults to off. Switch it on for this suite; restored after.
      priorXeroModule = await prisma.clubModuleSettings.findUnique({ where: { id: "default" }, select: { xeroIntegration: true } });
      await prisma.clubModuleSettings.upsert({
        where: { id: "default" },
        create: { id: "default", xeroIntegration: true },
        update: { xeroIntegration: true },
        select: { id: true },
      });
      // The subscriptionIncome mapping is a club-wide singleton: configure it only
      // when this database has none, and remove only what this suite created.
      const existing = await prisma.xeroAccountMapping.findUnique({ where: { key: MAPPING_KEY } });
      if (!existing) {
        await prisma.xeroAccountMapping.create({ data: { key: MAPPING_KEY, code: "203" } });
        createdMapping = true;
      }
    });

    beforeEach(async () => {
      await deleteFixtures();
      await seedPaidFamilyWithConflictedCharge();
    });

    afterAll(async () => {
      if (!prisma) return;
      await deleteFixtures();
      if (createdMapping) await prisma.xeroAccountMapping.deleteMany({ where: { key: MAPPING_KEY } });
      if (priorXeroModule) await prisma.clubModuleSettings.update({ where: { id: "default" }, data: priorXeroModule, select: { id: true } });
      else await prisma.clubModuleSettings.deleteMany({ where: { id: "default" } });
    });

    async function expectOneNewFamilyCharge(confirmedChargeIds: string[]) {
      const newIds = confirmedChargeIds.filter((id) => id !== OLD_CHARGE_ID);
      expect(newIds).toHaveLength(1);
      const charge = await prisma.membershipSubscriptionCharge.findUniqueOrThrow({
        where: { id: newIds[0] },
        include: { coverage: true },
      });
      expect(charge).toMatchObject({
        status: "QUEUED",
        familyGroupId: FAMILY_ID,
        membershipTypeId: TYPE_ID,
        seasonYear: SEASON_YEAR,
        recipientMemberId: PARENT_ID,
        chargedAmountCents: FAMILY_FEE_CENTS,
      });
      expect(charge.idempotencyKey).not.toBe("race-4110-old-charge-key");
      return charge;
    }

    it("re-bills the family after its charge was closed as already paid and one payment was reversed", async () => {
      await expect(
        closeAlreadyPaidSubscriptionCharge({ chargeId: OLD_CHARGE_ID, reason: "Paid in cash", actorMemberId: OFFICER_ID }),
      ).resolves.toMatchObject({ closed: true });
      await reverseChildPayment();

      const { preview, confirmed } = await previewAndConfirm();

      expect(preview.exceptions.map((item) => item.code)).not.toContain("FAMILY_ALREADY_BILLED");
      // Only the child's payment was reversed; the parent's still stands, so the
      // officer is warned that confirming invoices the whole family fee (#4110).
      expect(preview.exceptions.map((item) => item.code)).toEqual(["CLOSED_FAMILY_PARTLY_REVERSED"]);
      expect(confirmed.exceptionCount).toBe(0);
      expect(await prisma.membershipBillingException.count({ where: { familyGroupId: FAMILY_ID } })).toBe(0);
      const charge = await expectOneNewFamilyCharge(confirmed.chargeIds);
      // Only the reversed child is billed: the parent is still PAID by hand.
      expect(charge.coverage.map((row) => ({ memberId: row.memberId, releasedAt: row.releasedAt }))).toEqual([
        { memberId: CHILD_ID, releasedAt: null },
      ]);
      const old = await prisma.membershipSubscriptionCharge.findUniqueOrThrow({ where: { id: OLD_CHARGE_ID } });
      expect(old.status).toBe("NOT_REQUIRED");
      expect(
        await prisma.xeroSyncOperation.count({ where: { localModel: "MembershipSubscriptionCharge", localId: charge.id } }),
      ).toBe(1);
    });

    it("a membership approval withholds a partly reversed closed family for Finance; Finance's confirm then bills it (#4110 review F2)", async () => {
      await expect(
        closeAlreadyPaidSubscriptionCharge({ chargeId: OLD_CHARGE_ID, reason: "Paid in cash", actorMemberId: OFFICER_ID }),
      ).resolves.toMatchObject({ closed: true });
      await reverseChildPayment();

      // Approval confirms its own preview with nobody looking at the warning.
      const approval = await billing.queueApprovedMembershipSubscriptionCharges({
        memberIds: [CHILD_ID],
        approvedByMemberId: OFFICER_ID,
        decisionDate: DECISION_DATE,
      });
      expect(approval).toEqual({ chargeIds: [], exceptionCount: 1, xeroInvoicingOff: false });
      expect(await familyChargeIds()).toEqual([OLD_CHARGE_ID]);
      const open = await prisma.membershipBillingException.findMany({ where: { familyGroupId: FAMILY_ID } });
      expect(open).toHaveLength(1);
      expect(open[0]).toMatchObject({ code: "CLOSED_FAMILY_PARTLY_REVERSED", status: "OPEN", source: "NEW_MEMBER_APPROVAL" });
      expect(open[0]!.message).toContain("It was not invoiced on membership approval");

      // Finance reviews the warning in the billing run and confirms through it.
      const { confirmed } = await previewAndConfirm();
      await expectOneNewFamilyCharge(confirmed.chargeIds);
      const after = await prisma.membershipBillingException.findUniqueOrThrow({ where: { id: open[0]!.id } });
      expect(after).toMatchObject({ status: "RESOLVED", resolvedVia: "CONFIRM" });
    });

    it("re-bills the family after Xero voided its charge", async () => {
      await voidOldCharge();

      const { confirmed } = await previewAndConfirm();

      const charge = await expectOneNewFamilyCharge(confirmed.chargeIds);
      expect(charge.coverage.map((row) => row.memberId).sort()).toEqual([...MEMBER_IDS].sort());
    });

    it("keeps a closed family billed for a NEW joiner when no covered payment was reversed (#4110 regression)", async () => {
      await expect(
        closeAlreadyPaidSubscriptionCharge({ chargeId: OLD_CHARGE_ID, reason: "Paid in cash", actorMemberId: OFFICER_ID }),
      ).resolves.toMatchObject({ closed: true });
      // A third member joins the family after the close; nobody's payment changed.
      await prisma.member.create({
        data: {
          id: JOINER_ID, email: `${JOINER_ID}@example.invalid`, passwordHash: "not-a-real-password",
          firstName: "Rebill", lastName: "joiner", ageTier: "ADULT",
        },
      });
      await prisma.familyGroupMember.create({ data: { familyGroupId: FAMILY_ID, memberId: JOINER_ID } });
      await prisma.seasonalMembershipAssignment.create({ data: { memberId: JOINER_ID, seasonYear: SEASON_YEAR, membershipTypeId: TYPE_ID } });

      const preview = await billing.buildSubscriptionBillingPreview({
        seasonYear: SEASON_YEAR,
        decisionDate: DECISION_DATE,
        memberIds: [...MEMBER_IDS, JOINER_ID],
        yearEndMonth: YEAR_END_MONTH,
      });

      expect(preview.entries).toEqual([]);
      expect(preview.exceptions).toEqual([
        expect.objectContaining({ code: "FAMILY_ALREADY_BILLED", memberId: JOINER_ID, context: expect.objectContaining({ existingFamilyChargeId: OLD_CHARGE_ID }) }),
      ]);
    });

    it("keeps a closed family billed when an exempt member's assignment is re-saved after the close (#4110 review F1)", async () => {
      // The child is exempt: NOT_REQUIRED, which the close counts as settled.
      await prisma.memberSubscription.updateMany({
        where: { memberId: CHILD_ID, seasonYear: SEASON_YEAR },
        data: { status: "NOT_REQUIRED", manuallyMarkedPaidAt: null, manuallyMarkedPaidByMemberId: null },
      });
      await expect(
        closeAlreadyPaidSubscriptionCharge({ chargeId: OLD_CHARGE_ID, reason: "Paid in cash", actorMemberId: OFFICER_ID }),
      ).resolves.toMatchObject({ closed: true });
      const released = await prisma.membershipSubscriptionChargeCoverage.findMany({
        where: { chargeId: OLD_CHARGE_ID },
        select: { memberId: true, releasedAt: true, subscriptionStatusAtClose: true },
        orderBy: { memberId: "asc" },
      });
      expect(released.map(({ memberId, subscriptionStatusAtClose }) => ({ memberId, subscriptionStatusAtClose }))).toEqual([
        { memberId: CHILD_ID, subscriptionStatusAtClose: "NOT_REQUIRED" },
        { memberId: PARENT_ID, subscriptionStatusAtClose: "PAID" },
      ]);
      expect(released.every((row) => row.releasedAt !== null)).toBe(true);

      // An officer re-saves the child's REQUIRED-type assignment through the
      // real save path (same type, a new apply-from date: an unchanged save is
      // a no-op). Its reconcile no longer sees an active claim, so it moves the
      // child's NOT_REQUIRED row to NOT_INVOICED — no payment involved.
      const assignments = await import("@/lib/seasonal-membership-assignments");
      const { readClubTimeZoneOutsideRequest } = await import("@/lib/club-time-zone-runtime");
      const { clubToday, dateOnlyInstantOf } = await import("@/lib/club-time");
      const { clubSeasonYear } = await import("@/lib/financial-year");
      const zone = await readClubTimeZoneOutsideRequest();
      const changePreview = await assignments.getSeasonalMembershipChangePreview({
        memberId: CHILD_ID,
        seasonYear: SEASON_YEAR,
        membershipTypeId: TYPE_ID,
        applyFrom: RESAVE_APPLY_FROM,
        now: dateOnlyInstantOf(clubToday(zone)),
        clubCurrentSeasonYear: clubSeasonYear(zone),
      });
      expect(changePreview.init?.status ?? 200).toBe(200);
      const { previewToken } = (changePreview.body as { preview: { previewToken: string } }).preview;
      const saved = await assignments.saveSeasonalMembershipAssignment({
        memberId: CHILD_ID,
        seasonYear: SEASON_YEAR,
        membershipTypeId: TYPE_ID,
        applyFrom: RESAVE_APPLY_FROM,
        adminMemberId: OFFICER_ID,
        reason: "Re-saved after the close",
        previewToken,
        skipXeroContactGroupSync: true,
      });
      expect(saved.init?.status ?? 200).toBe(200);
      expect(saved.body).toMatchObject({ changed: true });
      // The defect's trigger did happen: the exempt row is now NOT_INVOICED.
      const child = await prisma.memberSubscription.findUniqueOrThrow({
        where: { memberId_seasonYear: { memberId: CHILD_ID, seasonYear: SEASON_YEAR } },
        select: { status: true },
      });
      expect(child.status).toBe("NOT_INVOICED");

      const preview = await billing.buildSubscriptionBillingPreview({
        seasonYear: SEASON_YEAR,
        decisionDate: DECISION_DATE,
        memberIds: [...MEMBER_IDS],
        yearEndMonth: YEAR_END_MONTH,
      });

      // Nobody's payment was reversed, so the closed family is still billed:
      // no re-bill, and no false "reversed (child)" warning.
      expect(preview.entries).toEqual([]);
      // The child now needs a subscription and is never silently unbilled: the
      // officer is asked to decide (#4110 decision 4).
      expect(preview.exceptions).toEqual([
        expect.objectContaining({
          code: "CLOSED_FAMILY_MEMBER_NEEDS_DECISION",
          memberId: CHILD_ID,
          message: expect.stringContaining("if the family fee already covers everyone in the family, mark them Paid; otherwise invoice just the difference in Xero by hand."),
          context: expect.objectContaining({ existingFamilyChargeId: OLD_CHARGE_ID, reason: "EXEMPT_AT_CLOSE" }),
        }),
      ]);

      // Finance's billing runs record it OPEN and keep it OPEN — run after run,
      // and through a preview refresh — and never re-bill the family.
      const decisionRow = () => prisma.membershipBillingException.findFirstOrThrow({
        where: { memberId: CHILD_ID, code: "CLOSED_FAMILY_MEMBER_NEEDS_DECISION" },
      });
      const first = await previewAndConfirm();
      expect(first.confirmed).toEqual({ chargeIds: [], exceptionCount: 1 });
      const opened = await decisionRow();
      expect(opened.status).toBe("OPEN");
      await previewAndConfirm();
      await billing.reconcileSubscriptionBillingExceptions({ seasonYear: SEASON_YEAR, decisionDate: DECISION_DATE, yearEndMonth: YEAR_END_MONTH });
      expect(await decisionRow()).toMatchObject({ id: opened.id, status: "OPEN", resolvedAt: null });
      expect(await familyChargeIds()).toEqual([OLD_CHARGE_ID]);

      // The officer decides the family fee covers the child and marks them Paid
      // (the existing manual mark-paid); the next refresh resolves it.
      const { applyManualSubscriptionPayment } = await import("@/lib/manual-subscription-payment");
      const childSubscription = await prisma.memberSubscription.findUniqueOrThrow({
        where: { memberId_seasonYear: { memberId: CHILD_ID, seasonYear: SEASON_YEAR } },
        select: { id: true },
      });
      await applyManualSubscriptionPayment({
        subscriptionId: childSubscription.id, direction: "paid", actingMemberId: OFFICER_ID, notifyMember: false,
        note: "Covered by the family fee",
      });
      await billing.reconcileSubscriptionBillingExceptions({ seasonYear: SEASON_YEAR, decisionDate: DECISION_DATE, yearEndMonth: YEAR_END_MONTH });
      expect(await decisionRow()).toMatchObject({ id: opened.id, status: "RESOLVED", resolvedVia: "PREVIEW_RECONCILE" });
      expect(await familyChargeIds()).toEqual([OLD_CHARGE_ID]);
    });

    it("a tier-exempt child who stays exempt gets no exception and the family stays billed (review round 4 F-A)", async () => {
      // A BASED_ON_AGE_TIER type with a PER_FAMILY fee: the CHILD tier is not
      // subscription-liable (the club's default tiers), but the per-family fee
      // keeps the child in the family path, so they reach the closed-charge rule.
      const { getAgeTierSettings, invalidateAgeTierCache } = await import("@/lib/age-tier");
      const { requiresPaidSubscriptionForAgeTier } = await import("@/lib/member-subscription-eligibility");
      invalidateAgeTierCache();
      expect(requiresPaidSubscriptionForAgeTier("CHILD", await getAgeTierSettings())).toBe(false);
      await prisma.membershipType.update({ where: { id: TYPE_ID }, data: { subscriptionBehavior: "BASED_ON_AGE_TIER" } });
      await prisma.member.update({ where: { id: CHILD_ID }, data: { ageTier: "CHILD", dateOfBirth: null } });
      await prisma.memberSubscription.updateMany({
        where: { memberId: CHILD_ID, seasonYear: SEASON_YEAR },
        data: { status: "NOT_REQUIRED", manuallyMarkedPaidAt: null, manuallyMarkedPaidByMemberId: null },
      });
      await expect(
        closeAlreadyPaidSubscriptionCharge({ chargeId: OLD_CHARGE_ID, reason: "Paid in cash", actorMemberId: OFFICER_ID }),
      ).resolves.toMatchObject({ closed: true });

      const preview = await billing.buildSubscriptionBillingPreview({
        seasonYear: SEASON_YEAR,
        decisionDate: DECISION_DATE,
        memberIds: [...MEMBER_IDS],
        yearEndMonth: YEAR_END_MONTH,
      });
      // Still settled (NOT_REQUIRED): nothing to decide, and Mark as paid would
      // refuse the row, so no exception that could never close.
      expect(preview.entries).toEqual([]);
      expect(preview.exceptions).toEqual([]);

      // A billing run records nothing for the child and re-bills nobody.
      const { confirmed } = await previewAndConfirm();
      expect(confirmed).toEqual({ chargeIds: [], exceptionCount: 0 });
      expect(await prisma.membershipBillingException.count({ where: { memberId: CHILD_ID } })).toBe(0);
      expect(await familyChargeIds()).toEqual([OLD_CHARGE_ID]);
    });

    it("never mints a second family invoice while the parent's own family invoice is live after a reversal (review round 5 item 1)", async () => {
      // K (the child) is exempt; H (the parent) is paid. C1 closes.
      await prisma.memberSubscription.updateMany({
        where: { memberId: CHILD_ID, seasonYear: SEASON_YEAR },
        data: { status: "NOT_REQUIRED", manuallyMarkedPaidAt: null, manuallyMarkedPaidByMemberId: null },
      });
      await expect(
        closeAlreadyPaidSubscriptionCharge({ chargeId: OLD_CHARGE_ID, reason: "Paid by the hand-raised family invoice", actorMemberId: OFFICER_ID }),
      ).resolves.toMatchObject({ closed: true });
      // The bank reverses H's payment of the family invoice the treasurer raised
      // by hand: H is UNPAID, and that family invoice is still live in Xero.
      await prisma.memberSubscription.updateMany({
        where: { memberId: PARENT_ID, seasonYear: SEASON_YEAR },
        data: {
          status: "UNPAID", xeroInvoiceId: "race-4110-hand-family-invoice", xeroInvoiceNumber: "INV-RACE-4110",
          manuallyMarkedPaidAt: null, manuallyMarkedPaidByMemberId: null,
        },
      });

      const { preview, confirmed } = await previewAndConfirm();

      // H's own live family invoice keeps the family held back (#2161): no
      // second full family invoice is minted off K.
      expect(preview.entries).toEqual([]);
      expect(preview.alreadyInvoicedFamilies).toEqual([
        expect.objectContaining({ familyGroupId: FAMILY_ID, holderMemberId: PARENT_ID, xeroInvoiceNumber: "INV-RACE-4110" }),
      ]);
      expect(confirmed.chargeIds).toEqual([]);
      expect(await familyChargeIds()).toEqual([OLD_CHARGE_ID]);
    });

    it("a reversal the parent's own family invoice holds back asks Finance to decide, and no run bills it (review round 6 F1)", async () => {
      // H raised the family fee by hand (INV-FAM) and paid it; K paid too.
      await prisma.memberSubscription.updateMany({
        where: { memberId: PARENT_ID, seasonYear: SEASON_YEAR },
        data: { xeroInvoiceId: "race-4110-hand-family-invoice", xeroInvoiceNumber: "INV-FAM-4110", manuallyMarkedPaidAt: null, manuallyMarkedPaidByMemberId: null },
      });
      await expect(
        closeAlreadyPaidSubscriptionCharge({ chargeId: OLD_CHARGE_ID, reason: "Paid", actorMemberId: OFFICER_ID }),
      ).resolves.toMatchObject({ closed: true });
      await reverseChildPayment();

      const { preview, confirmed } = await previewAndConfirm();
      expect(preview.entries).toEqual([]);
      expect(preview.alreadyInvoicedFamilies).toEqual([
        expect.objectContaining({ familyGroupId: FAMILY_ID, holderMemberId: PARENT_ID, xeroInvoiceNumber: "INV-FAM-4110" }),
      ]);
      expect(preview.exceptions).toEqual([
        expect.objectContaining({
          code: "CLOSED_FAMILY_MEMBER_NEEDS_DECISION",
          memberId: CHILD_ID,
          context: expect.objectContaining({ reason: "REVERSED_UNDER_NEWEST_CHARGE", heldBy: "Rebill parent's Xero invoice INV-FAM-4110" }),
        }),
      ]);
      // Finance's run records it OPEN and bills nobody; an approval bills nobody either.
      expect(confirmed).toEqual({ chargeIds: [], exceptionCount: 1 });
      expect(await prisma.membershipBillingException.findFirstOrThrow({
        where: { memberId: CHILD_ID, code: "CLOSED_FAMILY_MEMBER_NEEDS_DECISION" },
      })).toMatchObject({ status: "OPEN" });
      await expect(billing.queueApprovedMembershipSubscriptionCharges({
        memberIds: [CHILD_ID], approvedByMemberId: OFFICER_ID, decisionDate: DECISION_DATE,
      })).resolves.toEqual({ chargeIds: [], exceptionCount: 1, xeroInvoicingOff: false });
      expect(await familyChargeIds()).toEqual([OLD_CHARGE_ID]);
    });

    it("still refuses a second LIVE charge for one family, type and season", async () => {
      const second = prisma.membershipSubscriptionCharge.create({
        data: {
          idempotencyKey: "race-4110-second-live-key",
          seasonYear: SEASON_YEAR,
          source: "ANNUAL_BATCH",
          status: "QUEUED",
          membershipTypeId: TYPE_ID,
          membershipTypeKey: "race-4110-family-type",
          membershipTypeName: "Race 4110 Family",
          billingBasis: "PER_FAMILY",
          prorationRule: "NONE",
          annualAmountCents: FAMILY_FEE_CENTS,
          chargedAmountCents: FAMILY_FEE_CENTS,
          coveredMonths: 12,
          decisionDate: new Date("2026-06-01T00:00:00.000Z"),
          coverageStart: new Date("2026-04-01T00:00:00.000Z"),
          coverageEnd: new Date("2027-03-31T00:00:00.000Z"),
          familyGroupId: FAMILY_ID,
          recipientMemberId: PARENT_ID,
          recipientName: "Rebill parent",
          recipientEmail: `${PARENT_ID}@example.invalid`,
          dueDays: 30,
          invoiceReference: "MEMSUB-RACE-4110-SECOND",
        },
      });
      const error = await second.then(() => null, (caught: unknown) => caught);
      expect(error).toMatchObject({ code: "P2002" });
      // The refusal is the partial live-only index's, read the way the app reads
      // a P2002 target under the driver adapter (meta.target is empty there).
      const { describeUniqueConstraintTarget } = await import("@/lib/prisma-errors");
      expect(describeUniqueConstraintTarget(error)?.toLowerCase()).toBe("membershipcharge_family_type_year_live_key");
    });
  },
);
