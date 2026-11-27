/**
 * Real-PostgreSQL proof for mid-season age-ups under "Age today" (#5190 PR 3,
 * `INV-MONEY-051`..`053`, `INV-LOCKOUT-020`), where the rows and their keys
 * decide the outcome.
 *
 * 1. ONE BILLING RUN, through the real preview and confirm, raises a
 *    part-season charge for a member who aged into owing, a top-up for one who
 *    moved to a dearer tier and a credit for one who moved to a cheaper tier.
 *    The top-up is a charge with NO coverage claim, so the member's season row
 *    stays covered by their season charge alone. A second run, and a replay of
 *    the first confirmation, raise nothing.
 * 2. THE UNIQUE KEY (`memberSubscriptionId`, `ageUpDate`) refuses a second
 *    adjustment for one birthday, and the table's checks refuse a top-up with
 *    no charge, a credit with an invoice status and an adjustment of nothing.
 * 3. BOOKING ACCESS reads the real rows: a top-up holds its member back only
 *    once its invoice is issued and unpaid, and a credit never does.
 * 4. A VOIDED TOP-UP invoice voids the adjustment and its charge, and the next
 *    run names it instead of raising it again.
 * 5. TWO CREDIT WORKERS on one adjustment grant one credit lot, with one Xero
 *    note queued.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so CI reaches it; it owns and cleans its own
 * `race-5190pr3-` fixtures and restores the club singletons it changes.
 *
 * To run directly against a throwaway scratch database:
 *   RUN_CONCURRENCY_RACE_TESTS=1 \
 *   CONCURRENCY_RACE_DATABASE_URL=postgresql://user:pass@127.0.0.1:55442/concurrency_race_1881 \
 *   pnpm exec vitest run src/lib/__tests__/subscription-age-up.realdb.test.ts
 */
import type { AgeTier, MembershipLockoutSettings } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Invoice } from "xero-node";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
const RACE_TEST_TIMEOUT_MS = 60_000;

const PREFIX = "race-5190pr3-";
const OFFICER_ID = `${PREFIX}officer`;
/** Youth 6000, Adult 12000: growing up costs more. */
const DEARER_TYPE_ID = `${PREFIX}type-dearer`;
/** Youth 9000, Adult 6000: growing up costs less. */
const CHEAPER_TYPE_ID = `${PREFIX}type-cheaper`;
/** The officer's own type owes nothing, so the whole-club run has nothing to say about them. */
const OFFICER_TYPE_ID = `${PREFIX}type-officer`;
const TYPE_IDS = [DEARER_TYPE_ID, CHEAPER_TYPE_ID, OFFICER_TYPE_ID];
const SEASON_YEAR = 2026;
const YEAR_END_MONTH = 3;
/** The run's day, and the birthday two weeks before it: ten months left, June included. */
const RUN_DATE = new Date("2026-07-01T00:00:00.000Z");
const BIRTHDAY = "2026-06-15";
const BIRTHDAY_DATE = new Date(`${BIRTHDAY}T00:00:00.000Z`);
const MAPPING_KEY = "subscriptionIncome";

const ELLA = `${PREFIX}ella`;
const TOM = `${PREFIX}tom`;
const CARA = `${PREFIX}cara`;

/** Standalone fail-closed copy: importing this file must not register another suite. */
function assertSafeRaceDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Age-up proofs need a valid CONCURRENCY_RACE_DATABASE_URL.");
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(
      `Refusing to run age-up proofs against port ${parsed.port || "(none)"}: use a throwaway PostgreSQL on 55442+ (never 5432).`,
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error("Age-up proof DB must be loopback-only.");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName.includes("concurrency_race_1881")) {
    throw new Error("Age-up proof DB name must contain 'concurrency_race_1881'.");
  }
}

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let billing: typeof import("@/lib/membership-subscription-billing");
let ageUpBilling: typeof import("@/lib/subscription-age-up-billing");
let ageUpCredit: typeof import("@/lib/subscription-age-up-credit");
let ageUpSync: typeof import("@/lib/subscription-age-up-sync");
let lockoutFacts: typeof import("@/lib/subscription-lockout-facts");
let financialYear: typeof import("@/lib/financial-year");
let clubTime: typeof import("@/lib/club-time");

let createdMapping = false;
let priorXeroModule: { xeroIntegration: boolean } | null = null;
let priorLockoutSettings: MembershipLockoutSettings | null = null;
/** The minimum ages of the two tiers the fixtures cross, read from the club's own settings. */
let youthFrom = 0;
let adultFrom = 0;
let ageTierSettings: Awaited<ReturnType<(typeof import("@/lib/age-tier"))["getAgeTierSettingsStrict"]>>;

(RUN ? describe : describe.skip)(
  "a mid-season age-up is billed, topped up or credited once — real PostgreSQL (#5190 PR 3)",
  { timeout: RACE_TEST_TIMEOUT_MS },
  () => {
    const owned = { startsWith: PREFIX };

    async function ownedChargeIds(): Promise<string[]> {
      const rows = await prisma.membershipSubscriptionCharge.findMany({
        where: { recipientMemberId: owned },
        select: { id: true },
      });
      return rows.map((row) => row.id);
    }

    async function deleteFixtures() {
      const chargeIds = await ownedChargeIds();
      const adjustments = await prisma.memberSubscriptionAgeUpAdjustment.findMany({ where: { memberId: owned }, select: { id: true } });
      const creditLots = await prisma.memberCredit.findMany({ where: { memberId: owned }, select: { id: true } });
      await prisma.xeroSyncOperation.deleteMany({
        where: {
          OR: [
            { localModel: "MemberCredit", localId: { in: creditLots.map(({ id }) => id) } },
            { localModel: "MemberSubscriptionAgeUpAdjustment", localId: { in: adjustments.map(({ id }) => id) } },
            { localModel: "MembershipSubscriptionCharge", localId: { in: chargeIds } },
          ],
        },
      });
      await prisma.memberSubscriptionAgeUpAdjustment.deleteMany({ where: { memberId: owned } });
      await prisma.memberCredit.deleteMany({ where: { memberId: owned } });
      await prisma.auditLog.deleteMany({
        where: {
          OR: [
            { entityId: { in: [...chargeIds, ...adjustments.map(({ id }) => id)] } },
            { memberId: owned },
            { subjectMemberId: owned },
            { targetId: owned },
          ],
        },
      });
      await prisma.membershipSubscriptionChargeComponent.deleteMany({ where: { chargeId: { in: chargeIds } } });
      await prisma.membershipSubscriptionChargeCoverage.deleteMany({ where: { chargeId: { in: chargeIds } } });
      await prisma.membershipSubscriptionCharge.deleteMany({ where: { id: { in: chargeIds } } });
      await prisma.membershipBillingException.deleteMany({ where: { memberId: owned } });
      await prisma.memberSubscription.deleteMany({ where: { memberId: owned } });
      await prisma.seasonalMembershipAssignment.deleteMany({ where: { memberId: owned } });
      await prisma.membershipAnnualFeeComponent.deleteMany({ where: { membershipAnnualFee: { membershipTypeId: { in: TYPE_IDS } } } });
      await prisma.membershipAnnualFee.deleteMany({ where: { membershipTypeId: { in: TYPE_IDS } } });
      await prisma.membershipType.deleteMany({ where: { id: { in: TYPE_IDS } } });
      await prisma.member.deleteMany({ where: { id: owned } });
    }

    async function createMember(id: string, ageTier: AgeTier, dateOfBirth: Date | null = null) {
      await prisma.member.create({
        data: {
          id,
          email: `${id}@example.invalid`,
          passwordHash: "not-a-real-password",
          firstName: "Age-up",
          lastName: id.replace(PREFIX, ""),
          ageTier,
          dateOfBirth,
        },
      });
    }

    async function createType(id: string, name: string, fees: { YOUTH: number; ADULT: number }) {
      await prisma.membershipType.create({
        data: { id, key: id, name, subscriptionBehavior: "BASED_ON_AGE_TIER" },
      });
      for (const ageTier of ["YOUTH", "ADULT"] as const) {
        await prisma.membershipAnnualFee.create({
          data: {
            membershipTypeId: id,
            ageTier,
            amountCents: fees[ageTier],
            billingBasis: "PER_MEMBER",
            prorationRule: "NONE",
            effectiveFrom: new Date("2026-04-01T00:00:00.000Z"),
            // One part that prorates, so a part-season charge is the fee for the months left.
            components: { create: [{ label: "Subscription", amountCents: fees[ageTier], prorate: true }] },
          },
        });
      }
    }

    /** Born so that they turn `age` on the birthday. */
    const bornToTurn = (age: number) => new Date(`${2026 - age}-06-15T00:00:00.000Z`);

    /**
     * Ella turns adult on the dearer type (a top-up), Tom ages into owing on
     * it (a part-season charge) and Cara turns adult on the cheaper type (a
     * credit).
     */
    async function seedClub() {
      await createMember(OFFICER_ID, "ADULT");
      await prisma.membershipType.create({
        data: { id: OFFICER_TYPE_ID, key: OFFICER_TYPE_ID, name: "Race 5190 Officer", subscriptionBehavior: "NOT_REQUIRED" },
      });
      await prisma.seasonalMembershipAssignment.create({
        data: { memberId: OFFICER_ID, seasonYear: SEASON_YEAR, membershipTypeId: OFFICER_TYPE_ID },
      });
      await createType(DEARER_TYPE_ID, "Race 5190 Dearer", { YOUTH: 6_000, ADULT: 12_000 });
      await createType(CHEAPER_TYPE_ID, "Race 5190 Cheaper", { YOUTH: 9_000, ADULT: 6_000 });
      await createMember(ELLA, "YOUTH", bornToTurn(adultFrom));
      await createMember(TOM, "CHILD", bornToTurn(youthFrom));
      await createMember(CARA, "YOUTH", bornToTurn(adultFrom));
      for (const [memberId, membershipTypeId] of [[ELLA, DEARER_TYPE_ID], [TOM, DEARER_TYPE_ID], [CARA, CHEAPER_TYPE_ID]] as const) {
        await prisma.seasonalMembershipAssignment.create({ data: { memberId, seasonYear: SEASON_YEAR, membershipTypeId } });
      }
    }

    /**
     * A top-up is only raised by a whole-club run, which bills every member in
     * the database. Refuse rather than bill another suite's leftovers.
     */
    async function wholeClubPreview() {
      const preview = await billing.buildSubscriptionBillingPreview({
        seasonYear: SEASON_YEAR,
        decisionDate: RUN_DATE,
        yearEndMonth: YEAR_END_MONTH,
      });
      const touched = [
        ...preview.entries.flatMap((entry) => entry.coveredMembers.map((covered) => covered.id)),
        ...preview.ageUpAdjustments.map((item) => item.memberId),
      ];
      expect(
        touched.filter((id) => !id.startsWith(PREFIX)),
        "a foreign member in the race database would be billed by this suite's whole-club run",
      ).toEqual([]);
      return preview;
    }

    function confirm(preview: Awaited<ReturnType<typeof wholeClubPreview>>) {
      return billing.confirmSubscriptionBillingPreview({
        preview,
        expectedConfirmationToken: preview.confirmationToken,
        source: "ANNUAL_BATCH",
        confirmedByMemberId: OFFICER_ID,
      });
    }

    /** Everything the run wrote for a member, in a comparable shape. */
    async function written(memberId: string) {
      const charges = await prisma.membershipSubscriptionCharge.findMany({
        where: { recipientMemberId: memberId },
        orderBy: { chargedAmountCents: "desc" },
        select: {
          id: true,
          idempotencyKey: true,
          status: true,
          prorationRule: true,
          annualAmountCents: true,
          chargedAmountCents: true,
          coveredMonths: true,
          decisionDate: true,
          coverage: { where: { releasedAt: null }, select: { memberId: true } },
          components: { select: { label: true, chargedAmountCents: true } },
        },
      });
      const adjustments = await prisma.memberSubscriptionAgeUpAdjustment.findMany({
        where: { memberId },
        select: {
          id: true, kind: true, status: true, amountCents: true, coveredMonths: true, ageUpDate: true,
          fromAgeTier: true, toAgeTier: true, chargeId: true, memberCreditId: true, xeroInvoiceStatus: true,
          memberSubscriptionId: true,
        },
      });
      return { charges, adjustments };
    }

    const operationsFor = (localModel: string, localId: string) =>
      prisma.xeroSyncOperation.findMany({
        where: { localModel, localId },
        select: { queueType: true, status: true, entityType: true },
      });

    async function counts() {
      const chargeIds = await ownedChargeIds();
      return {
        charges: chargeIds.length,
        coverage: await prisma.membershipSubscriptionChargeCoverage.count({ where: { chargeId: { in: chargeIds } } }),
        adjustments: await prisma.memberSubscriptionAgeUpAdjustment.count({ where: { memberId: owned } }),
        chargeOperations: await prisma.xeroSyncOperation.count({
          where: { localModel: "MembershipSubscriptionCharge", localId: { in: chargeIds } },
        }),
        creditOperations: await prisma.xeroSyncOperation.count({ where: { queueType: "AGE_UP_CREDIT" } }),
      };
    }

    async function settlementOf(memberId: string) {
      const settlements = await lockoutFacts.loadMemberSubscriptionSettlements(prisma, {
        memberIds: [memberId],
        seasonYear: SEASON_YEAR,
        subscriptionBehaviorByMember: new Map([[memberId, "BASED_ON_AGE_TIER" as const]]),
        readAgeTierSettings: async () => ageTierSettings,
        today: clubTime.calendarDateOfDateOnlyInstant(RUN_DATE),
      });
      return settlements.get(memberId);
    }

    /** A pending credit adjustment on its own season row, for the worker proofs. */
    async function seedCreditAdjustment(memberId: string) {
      await createMember(memberId, "ADULT");
      const subscription = await prisma.memberSubscription.create({ data: { memberId, seasonYear: SEASON_YEAR, status: "PAID" } });
      const data = {
        memberSubscriptionId: subscription.id,
        memberId,
        seasonYear: SEASON_YEAR,
        ageUpDate: BIRTHDAY_DATE,
        kind: "CREDIT",
        fromAgeTier: "YOUTH",
        toAgeTier: "ADULT",
        coveredMonths: 10,
        fromAnnualCents: 9_000,
        toAnnualCents: 6_000,
        amountCents: 2_500,
        description: "Race 5190 Cheaper membership (10 months) — age group change credit, Youth to Adult",
      } as const;
      const adjustment = await prisma.memberSubscriptionAgeUpAdjustment.create({ data });
      return { adjustment, data };
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      billing = await import("@/lib/membership-subscription-billing");
      ageUpBilling = await import("@/lib/subscription-age-up-billing");
      ageUpCredit = await import("@/lib/subscription-age-up-credit");
      ageUpSync = await import("@/lib/subscription-age-up-sync");
      lockoutFacts = await import("@/lib/subscription-lockout-facts");
      financialYear = await import("@/lib/financial-year");
      clubTime = await import("@/lib/club-time");
      financialYear.__setFinancialYearEndMonthForTesting(YEAR_END_MONTH);

      // The fixtures cross the club's own tier boundaries, whatever they are.
      const { getAgeTierSettingsStrict } = await import("@/lib/age-tier");
      ageTierSettings = await getAgeTierSettingsStrict(prisma);
      const tier = (name: AgeTier) => {
        const found = ageTierSettings.find((setting) => setting.tier === name);
        if (!found) throw new Error(`The race database has no ${name} age tier.`);
        return found;
      };
      expect(tier("CHILD").subscriptionRequiredForBooking, "CHILD must be exempt for these proofs").toBe(false);
      expect(tier("YOUTH").subscriptionRequiredForBooking, "YOUTH must owe for these proofs").toBe(true);
      expect(tier("ADULT").subscriptionRequiredForBooking, "ADULT must owe for these proofs").toBe(true);
      youthFrom = tier("YOUTH").minAge;
      adultFrom = tier("ADULT").minAge;

      priorLockoutSettings = await prisma.membershipLockoutSettings.findUnique({ where: { id: "default" } });
      // #4986 (INV-INT-040): subscription invoicing refuses while Xero is off.
      priorXeroModule = await prisma.clubModuleSettings.findUnique({ where: { id: "default" }, select: { xeroIntegration: true } });
      await prisma.clubModuleSettings.upsert({
        where: { id: "default" },
        create: { id: "default", xeroIntegration: true },
        update: { xeroIntegration: true },
        select: { id: true },
      });
      const existing = await prisma.xeroAccountMapping.findUnique({ where: { key: MAPPING_KEY } });
      if (!existing) {
        await prisma.xeroAccountMapping.create({ data: { key: MAPPING_KEY, code: "203" } });
        createdMapping = true;
      }
    });

    beforeEach(async () => {
      await deleteFixtures();
      await prisma.membershipLockoutSettings.upsert({
        where: { id: "default" },
        create: { id: "default", requiredTypeAgeRule: "AGE_TIER_EXEMPTS", liabilityAgeSource: "CURRENT_AGE" },
        update: { requiredTypeAgeRule: "AGE_TIER_EXEMPTS", liabilityAgeSource: "CURRENT_AGE" },
      });
    });

    afterAll(async () => {
      if (!prisma) return;
      await deleteFixtures();
      if (priorLockoutSettings) {
        // The only columns this suite writes.
        const { requiredTypeAgeRule, liabilityAgeSource } = priorLockoutSettings;
        await prisma.membershipLockoutSettings.update({
          where: { id: "default" },
          data: { requiredTypeAgeRule, liabilityAgeSource },
        });
      } else {
        await prisma.membershipLockoutSettings.deleteMany({ where: { id: "default" } });
      }
      if (createdMapping) await prisma.xeroAccountMapping.deleteMany({ where: { key: MAPPING_KEY } });
      if (priorXeroModule) await prisma.clubModuleSettings.update({ where: { id: "default" }, data: priorXeroModule, select: { id: true } });
      else await prisma.clubModuleSettings.deleteMany({ where: { id: "default" } });
    });

    it("one run raises a part-season charge, a top-up and a credit; a second run and a replayed confirm raise nothing", async () => {
      await seedClub();
      const preview = await wholeClubPreview();
      expect(preview.ageUpAdjustments.map((item) => [item.memberId, item.kind, item.amountCents])).toEqual([
        // (9000 - 6000) x 10 / 12, and (12000 - 6000) x 10 / 12.
        [CARA, "CREDIT", 2_500],
        [ELLA, "TOP_UP", 5_000],
      ]);

      const confirmed = await confirm(preview);
      expect(confirmed.exceptionCount).toBe(0);

      // Tom, who aged into owing: one charge for the ten months from his
      // birthday, and no adjustment.
      const tom = await written(TOM);
      expect(tom.adjustments).toEqual([]);
      expect(tom.charges).toHaveLength(1);
      expect(tom.charges[0]).toMatchObject({
        status: "QUEUED",
        prorationRule: "REMAINING_MONTHS_INCLUSIVE",
        annualAmountCents: 6_000,
        chargedAmountCents: 5_000,
        coveredMonths: 10,
        decisionDate: BIRTHDAY_DATE,
        coverage: [{ memberId: TOM }],
      });

      // Ella: her season at the Youth fee, and a top-up charge beside it that
      // claims no coverage.
      const ella = await written(ELLA);
      expect(ella.charges).toHaveLength(2);
      const [season, topUp] = ella.charges;
      expect(season).toMatchObject({ annualAmountCents: 6_000, chargedAmountCents: 6_000, coverage: [{ memberId: ELLA }] });
      expect(ella.adjustments).toHaveLength(1);
      const ellaAdjustment = ella.adjustments[0]!;
      expect(topUp).toMatchObject({
        idempotencyKey: ageUpBilling.ageUpTopUpChargeKey(ellaAdjustment.memberSubscriptionId, BIRTHDAY),
        status: "QUEUED",
        prorationRule: "REMAINING_MONTHS_INCLUSIVE",
        annualAmountCents: 6_000,
        chargedAmountCents: 5_000,
        coveredMonths: 10,
        decisionDate: BIRTHDAY_DATE,
        coverage: [],
        components: [{ label: "Age group change", chargedAmountCents: 5_000 }],
      });
      expect(ellaAdjustment).toMatchObject({
        kind: "TOP_UP",
        status: "PENDING",
        amountCents: 5_000,
        coveredMonths: 10,
        ageUpDate: BIRTHDAY_DATE,
        fromAgeTier: "YOUTH",
        toAgeTier: "ADULT",
        chargeId: topUp!.id,
        memberCreditId: null,
        xeroInvoiceStatus: null,
      });
      expect(confirmed.chargeIds).toContain(topUp!.id);
      // Each charge has its own invoice queued.
      expect(await operationsFor("MembershipSubscriptionCharge", season!.id)).toHaveLength(1);
      expect(await operationsFor("MembershipSubscriptionCharge", topUp!.id)).toEqual([
        expect.objectContaining({ status: "PENDING", entityType: "INVOICE" }),
      ]);

      // Cara: her season at the Youth fee, and a credit with one operation queued.
      const cara = await written(CARA);
      expect(cara.charges).toHaveLength(1);
      expect(cara.charges[0]).toMatchObject({ annualAmountCents: 9_000, chargedAmountCents: 9_000 });
      expect(cara.adjustments).toEqual([
        expect.objectContaining({
          kind: "CREDIT", status: "PENDING", amountCents: 2_500, chargeId: null, memberCreditId: null, xeroInvoiceStatus: null,
        }),
      ]);
      expect(await operationsFor("MemberSubscriptionAgeUpAdjustment", cara.adjustments[0]!.id)).toEqual([
        { queueType: "AGE_UP_CREDIT", status: "PENDING", entityType: "CREDIT_NOTE" },
      ]);

      const afterFirstRun = await counts();
      expect(afterFirstRun).toEqual({ charges: 4, coverage: 3, adjustments: 2, chargeOperations: 4, creditOperations: 1 });

      // A second run finds everyone settled.
      const again = await wholeClubPreview();
      expect(again.entries).toEqual([]);
      expect(again.ageUpAdjustments).toEqual([]);
      expect(again.exceptions).toEqual([]);
      await confirm(again);
      expect(await counts()).toEqual(afterFirstRun);

      // ...and so does a double-submit of the first confirmation.
      await confirm(preview);
      expect(await counts()).toEqual(afterFirstRun);
    });

    it("a top-up holds its member back only once its invoice is issued and unpaid; a credit never does", async () => {
      await seedClub();
      await confirm(await wholeClubPreview());
      // Both members have paid their season invoice.
      await prisma.memberSubscription.updateMany({ where: { memberId: { in: [ELLA, CARA] } }, data: { status: "PAID" } });
      const topUpOf = { memberId: ELLA, kind: "TOP_UP" } as const;

      // Queued, not yet an invoice in Xero.
      expect(lockoutFacts.subscriptionIsSettled(await settlementOf(ELLA))).toBe(true);

      for (const xeroInvoiceStatus of ["UNPAID", "OVERDUE"] as const) {
        await prisma.memberSubscriptionAgeUpAdjustment.updateMany({ where: topUpOf, data: { xeroInvoiceStatus } });
        expect(lockoutFacts.subscriptionIsUnpaid(await settlementOf(ELLA)), xeroInvoiceStatus).toBe(true);
      }

      await prisma.memberSubscriptionAgeUpAdjustment.updateMany({ where: topUpOf, data: { xeroInvoiceStatus: "PAID" } });
      expect(lockoutFacts.subscriptionIsSettled(await settlementOf(ELLA))).toBe(true);

      // Voided while its invoice was last seen unpaid.
      await prisma.memberSubscriptionAgeUpAdjustment.updateMany({ where: topUpOf, data: { xeroInvoiceStatus: "UNPAID", status: "VOIDED" } });
      expect(lockoutFacts.subscriptionIsSettled(await settlementOf(ELLA))).toBe(true);

      // Cara's credit is pending the whole time.
      expect(lockoutFacts.subscriptionIsSettled(await settlementOf(CARA))).toBe(true);
    });

    it("a member who aged into owing may book until their part-season invoice is issued", async () => {
      await seedClub();
      // Before any run: Tom has no season row, and may book.
      expect(lockoutFacts.subscriptionIsSettled(await settlementOf(TOM))).toBe(true);

      await confirm(await wholeClubPreview());
      // Billed, the invoice still queued.
      expect(lockoutFacts.subscriptionIsSettled(await settlementOf(TOM))).toBe(true);

      // The sync marks the row once the invoice exists in Xero.
      await prisma.memberSubscription.updateMany({ where: { memberId: TOM }, data: { status: "UNPAID" } });
      expect(lockoutFacts.subscriptionIsUnpaid(await settlementOf(TOM))).toBe(true);

      await prisma.memberSubscription.updateMany({ where: { memberId: TOM }, data: { status: "PAID" } });
      expect(lockoutFacts.subscriptionIsSettled(await settlementOf(TOM))).toBe(true);
    });

    it("the sync follows a top-up's invoice, and a voided top-up is named, not raised again", async () => {
      await seedClub();
      await confirm(await wholeClubPreview());
      const { adjustments } = await written(ELLA);
      const topUpChargeId = adjustments[0]!.chargeId!;
      const invoiceId = `${PREFIX}invoice-top-up`;
      await prisma.membershipSubscriptionCharge.update({
        where: { id: topUpChargeId },
        data: { xeroInvoiceId: invoiceId, status: "EMAILED" },
      });
      const invoice = (status: Invoice.StatusEnum) => ({ invoiceID: invoiceId, status }) as Invoice;
      const today = clubTime.calendarDateOfDateOnlyInstant(RUN_DATE);

      // A top-up's invoice is never taken for the member's season invoice.
      const seasonInvoice = { invoiceID: `${PREFIX}invoice-season` } as Invoice;
      expect(await ageUpSync.withoutAgeUpTopUpInvoices([seasonInvoice, invoice(Invoice.StatusEnum.AUTHORISED)])).toEqual([seasonInvoice]);

      expect(await ageUpSync.syncAgeUpTopUpInvoices([invoice(Invoice.StatusEnum.AUTHORISED)], today)).toBe(1);
      expect((await written(ELLA)).adjustments[0]).toMatchObject({ status: "PENDING", xeroInvoiceStatus: "UNPAID" });
      // The same sweep again writes nothing.
      expect(await ageUpSync.syncAgeUpTopUpInvoices([invoice(Invoice.StatusEnum.AUTHORISED)], today)).toBe(0);

      expect(await ageUpSync.syncAgeUpTopUpInvoices([invoice(Invoice.StatusEnum.VOIDED)], today)).toBe(1);
      const voided = await written(ELLA);
      expect(voided.adjustments[0]).toMatchObject({ status: "VOIDED" });
      expect(voided.charges.find((charge) => charge.id === topUpChargeId)).toMatchObject({ status: "VOIDED" });
      // A later "paid" for the voided invoice does not revive it.
      expect(await ageUpSync.syncAgeUpTopUpInvoices([invoice(Invoice.StatusEnum.PAID)], today)).toBe(0);
      expect((await written(ELLA)).adjustments[0]).toMatchObject({ status: "VOIDED", xeroInvoiceStatus: "UNPAID" });

      const before = await counts();
      const next = await wholeClubPreview();
      expect(next.ageUpAdjustments).toEqual([]);
      expect(next.exceptions).toEqual([
        expect.objectContaining({
          code: "AGE_UP_SETTLE_IN_XERO",
          memberId: ELLA,
          message: expect.stringContaining("its top-up invoice was voided in Xero, so it is not raised again"),
        }),
      ]);
      await confirm(next);
      expect(await counts()).toEqual(before);
    });

    it("the unique key refuses a second adjustment for one birthday, and allows another day's", async () => {
      const { data } = await seedCreditAdjustment(`${PREFIX}unique`);

      await expect(prisma.memberSubscriptionAgeUpAdjustment.create({ data })).rejects.toMatchObject({ code: "P2002" });

      const anotherDay = { ...data, ageUpDate: new Date("2026-09-03T00:00:00.000Z") };
      await prisma.memberSubscriptionAgeUpAdjustment.create({ data: anotherDay });
      expect(await prisma.memberSubscriptionAgeUpAdjustment.count({ where: { memberId: `${PREFIX}unique` } })).toBe(2);
    });

    it("the database refuses a top-up that names no charge, a credit that carries an invoice status, and an adjustment of nothing", async () => {
      const { data } = await seedCreditAdjustment(`${PREFIX}checks`);
      const onAnotherDay = { ...data, ageUpDate: new Date("2026-09-03T00:00:00.000Z") };

      await expect(prisma.memberSubscriptionAgeUpAdjustment.create({ data: { ...onAnotherDay, kind: "TOP_UP" } }))
        .rejects.toThrow("MemberSubscriptionAgeUpAdjustment_kind_links");
      await expect(prisma.memberSubscriptionAgeUpAdjustment.create({ data: { ...onAnotherDay, xeroInvoiceStatus: "UNPAID" } }))
        .rejects.toThrow("MemberSubscriptionAgeUpAdjustment_kind_links");
      await expect(prisma.memberSubscriptionAgeUpAdjustment.create({ data: { ...onAnotherDay, amountCents: 0 } }))
        .rejects.toThrow("MemberSubscriptionAgeUpAdjustment_amount_positive");

      expect(await prisma.memberSubscriptionAgeUpAdjustment.count({ where: { memberId: `${PREFIX}checks` } })).toBe(1);
    });

    it("two credit workers on one adjustment grant one credit lot, with one Xero note queued", async () => {
      const memberId = `${PREFIX}race`;
      const { adjustment } = await seedCreditAdjustment(memberId);

      const results = await Promise.all([
        ageUpCredit.creditAgeUpAdjustmentToAccount(adjustment.id),
        ageUpCredit.creditAgeUpAdjustmentToAccount(adjustment.id),
      ]);

      const granted = results.filter((result) => result !== null);
      expect(granted).toHaveLength(1);
      const lots = await prisma.memberCredit.findMany({
        where: { memberId },
        select: { id: true, amountCents: true, type: true, description: true },
      });
      expect(lots).toEqual([{
        id: granted[0]!.memberCreditId,
        amountCents: 2_500,
        type: "ADMIN_ADJUSTMENT",
        description: adjustment.description,
      }]);
      expect(
        await prisma.memberSubscriptionAgeUpAdjustment.findUniqueOrThrow({
          where: { id: adjustment.id },
          select: { status: true, memberCreditId: true, xeroCreditNoteId: true },
        }),
      ).toEqual({ status: "CREDITED_TO_ACCOUNT", memberCreditId: lots[0]!.id, xeroCreditNoteId: null });
      expect(await operationsFor("MemberCredit", lots[0]!.id)).toEqual([
        expect.objectContaining({ status: "PENDING", entityType: "CREDIT_NOTE" }),
      ]);
      expect(
        await prisma.auditLog.count({ where: { action: "member.credit.age_up_credit", entityId: adjustment.id } }),
      ).toBe(1);

      // A later retry of the same operation finds it settled.
      expect(await ageUpCredit.creditAgeUpAdjustmentToAccount(adjustment.id)).toBeNull();
      expect(await prisma.memberCredit.count({ where: { memberId } })).toBe(1);
    });
  },
);
