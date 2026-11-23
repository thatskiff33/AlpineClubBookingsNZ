/**
 * Real-PostgreSQL proof for the #5190 subscription-liability opt-in, where
 * money state moves.
 *
 * 1. THE CLEAR-UP flips only untouched rows. A club opting in through the real
 *    settings save (`saveLockoutSettings`) over five season rows — untouched,
 *    invoiced, covered by a no-invoice fee, manually marked, and covered then
 *    released — moves exactly the untouched and the released one to
 *    `NOT_INVOICED`. Each guarded row differs from the untouched one in ONE
 *    column, so each guard in `UNTOUCHED_NOT_REQUIRED_ROW` is proved alone.
 * 2. THE SEASON KEY serialises a billing confirm with the settings save, in both
 *    orders: queued first, the confirm bills under the old rule; queued second,
 *    it re-previews under the new rule and refuses the stale token.
 * 3. THE LIABILITY-RULE KEY orders the seasonal-assignment reconcile (shared)
 *    against a rule writer (exclusive): the reconcile waits for a writer
 *    holding it and reads the committed rule; a real opt-in's clear-up waits
 *    for a real assignment save holding it shared, then clears the row that
 *    save left (red when the clear-up's exclusive key is removed); it never
 *    waits on a billing
 *    confirm — a real roll-forward, whose chunk holds lock(1), finishes while
 *    the season key is held, and no lock(1) holder is ever seen waiting.
 * 4. THE SQL DATE-OF-BIRTH CHECK (`subscription-liability-where.ts`) agrees with
 *    the TS rule on PostgreSQL's own `date` comparison, for members born either
 *    side of every tier birthday at the season's start and end — including a
 *    29 February birth against a 28 February season end.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so CI reaches it; it owns and cleans its own
 * `race-5190-` fixtures and restores the club singletons it changes.
 *
 * To run directly against a throwaway scratch database:
 *   RUN_CONCURRENCY_RACE_TESTS=1 \
 *   CONCURRENCY_RACE_DATABASE_URL=postgresql://user:pass@127.0.0.1:55442/concurrency_race_1881 \
 *   pnpm exec vitest run src/lib/__tests__/subscription-liability-opt-in.realdb.test.ts
 */
import type {
  AgeTier,
  MembershipLockoutSettings,
  MembershipTypeSubscriptionBehavior,
} from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { realElapsedMs } from "./helpers/clock";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
const RACE_TEST_TIMEOUT_MS = 60_000;
/** Longer than Prisma's default 5 s interactive-transaction budget. */
const PAST_DEFAULT_TRANSACTION_BUDGET_MS = 6_500;

const PREFIX = "race-5190-";
const OFFICER_ID = `${PREFIX}officer`;
const REQUIRED_TYPE_ID = `${PREFIX}type-required`;
const AGE_TYPE_ID = `${PREFIX}type-age`;
const NOT_REQUIRED_TYPE_ID = `${PREFIX}type-not-required`;
const FEE_ID = `${PREFIX}fee`;
const SEASON_YEAR = 2026;
const DECISION_DATE = new Date("2026-07-01T00:00:00.000Z");
const YEAR_END_MONTH = 3;
const MAPPING_KEY = "subscriptionIncome";
const FEE_CENTS = 12_000;

const CHOSEN_ALWAYS = { requiredTypeAgeRule: "ALWAYS_OWES", liabilityAgeSource: "SEASON_START" } as const;
const CHOSEN_EXEMPTS = { requiredTypeAgeRule: "AGE_TIER_EXEMPTS", liabilityAgeSource: "SEASON_START" } as const;

// INFANT and CHILD are age-exempt; YOUTH and ADULT owe. Passed to the SQL
// builder and the TS rule alike, so the DB's own tier table is not involved.
const AGE_TIER_SETTINGS = [
  { tier: "INFANT", minAge: 0, maxAge: 4, label: "Infant", sortOrder: 0, subscriptionRequiredForBooking: false },
  { tier: "CHILD", minAge: 5, maxAge: 12, label: "Child", sortOrder: 1, subscriptionRequiredForBooking: false },
  { tier: "YOUTH", minAge: 13, maxAge: 17, label: "Youth", sortOrder: 2, subscriptionRequiredForBooking: true },
  { tier: "ADULT", minAge: 18, maxAge: null, label: "Adult", sortOrder: 3, subscriptionRequiredForBooking: true },
] as const;

/** Standalone fail-closed copy: importing this file must not register another suite. */
function assertSafeRaceDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Liability opt-in proofs need a valid CONCURRENCY_RACE_DATABASE_URL.");
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(
      `Refusing to run liability opt-in proofs against port ${parsed.port || "(none)"}: use a throwaway PostgreSQL on 55442+ (never 5432).`,
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error("Liability opt-in proof DB must be loopback-only.");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName.includes("concurrency_race_1881")) {
    throw new Error("Liability opt-in proof DB name must contain 'concurrency_race_1881'.");
  }
}

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let billing: typeof import("@/lib/membership-subscription-billing");
let defaults: typeof import("@/lib/member-subscription-defaults");
let settingsWrite: typeof import("@/lib/subscription-liability-settings-write");
let seasonLock: typeof import("@/lib/subscription-billing-season-lock");
let ruleLock: typeof import("@/lib/subscription-liability-rule-lock");
let assignments: typeof import("@/lib/seasonal-membership-assignments");
let where: typeof import("@/lib/subscription-liability-where");
let membershipTypes: typeof import("@/lib/membership-types");
let financialYear: typeof import("@/lib/financial-year");
let clubTime: typeof import("@/lib/club-time");

let createdMapping = false;
let priorXeroModule: { xeroIntegration: boolean } | null = null;
let priorLockoutSettings: MembershipLockoutSettings | null = null;

(RUN ? describe : describe.skip)(
  "subscription-liability opt-in moves only untouched rows, under the billing season key — real PostgreSQL (#5190)",
  { timeout: RACE_TEST_TIMEOUT_MS },
  () => {
    async function ownedChargeIds(): Promise<string[]> {
      const rows = await prisma.membershipSubscriptionCharge.findMany({
        where: { OR: [{ id: { startsWith: PREFIX } }, { recipientMemberId: { startsWith: PREFIX } }] },
        select: { id: true },
      });
      return rows.map((row) => row.id);
    }

    async function deleteFixtures() {
      const chargeIds = await ownedChargeIds();
      const ownedMember = { startsWith: PREFIX };
      await prisma.auditLog.deleteMany({
        where: { OR: [{ entityId: { in: chargeIds } }, { memberId: ownedMember }, { subjectMemberId: ownedMember }] },
      });
      await prisma.xeroSyncOperation.deleteMany({
        where: { localModel: "MembershipSubscriptionCharge", localId: { in: chargeIds } },
      });
      await prisma.membershipSubscriptionChargeComponent.deleteMany({ where: { chargeId: { in: chargeIds } } });
      await prisma.membershipSubscriptionChargeCoverage.deleteMany({ where: { chargeId: { in: chargeIds } } });
      await prisma.membershipSubscriptionCharge.deleteMany({ where: { id: { in: chargeIds } } });
      await prisma.membershipBillingException.deleteMany({ where: { memberId: ownedMember } });
      await prisma.memberSubscription.deleteMany({ where: { memberId: ownedMember } });
      await prisma.seasonalMembershipAssignment.deleteMany({ where: { memberId: ownedMember } });
      await prisma.membershipAnnualFeeComponent.deleteMany({ where: { membershipAnnualFeeId: FEE_ID } });
      await prisma.membershipAnnualFee.deleteMany({ where: { id: FEE_ID } });
      await prisma.membershipType.deleteMany({
        where: { id: { in: [REQUIRED_TYPE_ID, AGE_TYPE_ID, NOT_REQUIRED_TYPE_ID] } },
      });
      await prisma.member.deleteMany({ where: { id: ownedMember } });
    }

    /** The club back on NOT_CHOSEN, every other column as this suite found it. */
    async function resetLockoutSettings() {
      await prisma.membershipLockoutSettings.upsert({
        where: { id: "default" },
        create: { id: "default", requiredTypeAgeRule: "NOT_CHOSEN", liabilityAgeSource: "NOT_CHOSEN" },
        update: { requiredTypeAgeRule: "NOT_CHOSEN", liabilityAgeSource: "NOT_CHOSEN" },
      });
    }

    async function createMember(id: string, ageTier: AgeTier, dateOfBirth: Date | null = null) {
      await prisma.member.create({
        data: {
          id,
          email: `${id}@example.invalid`,
          passwordHash: "not-a-real-password",
          firstName: "Liability",
          lastName: id.replace(PREFIX, ""),
          ageTier,
          dateOfBirth,
        },
      });
    }

    async function seedTypesAndFee() {
      await createMember(OFFICER_ID, "ADULT");
      await prisma.membershipType.create({
        data: { id: REQUIRED_TYPE_ID, key: `${PREFIX}required`, name: "Race 5190 Required", subscriptionBehavior: "REQUIRED" },
      });
      await prisma.membershipType.create({
        data: { id: AGE_TYPE_ID, key: `${PREFIX}age`, name: "Race 5190 By Age", subscriptionBehavior: "BASED_ON_AGE_TIER" },
      });
      await prisma.membershipAnnualFee.create({
        data: {
          id: FEE_ID,
          membershipTypeId: REQUIRED_TYPE_ID,
          ageTier: null,
          amountCents: FEE_CENTS,
          billingBasis: "PER_MEMBER",
          prorationRule: "NONE",
          effectiveFrom: new Date("2026-04-01T00:00:00.000Z"),
          components: { create: [{ label: "Subscription", amountCents: FEE_CENTS, prorate: false }] },
        },
      });
    }

    async function assign(memberId: string, typeId: string, seasonYear = SEASON_YEAR) {
      await prisma.seasonalMembershipAssignment.create({ data: { memberId, seasonYear, membershipTypeId: typeId } });
    }

    /** A charge holding one coverage claim on `subscriptionId`. */
    async function chargeCovering(input: {
      key: string;
      memberId: string;
      subscriptionId: string;
      billingBasis: "NO_INVOICE" | "PER_MEMBER";
      status: "NOT_REQUIRED" | "VOIDED";
      releasedAt: Date | null;
    }) {
      await prisma.membershipSubscriptionCharge.create({
        data: {
          id: `${PREFIX}charge-${input.key}`,
          idempotencyKey: `${PREFIX}charge-${input.key}-key`,
          seasonYear: SEASON_YEAR,
          source: "ANNUAL_BATCH",
          status: input.status,
          membershipAnnualFeeId: FEE_ID,
          membershipTypeId: REQUIRED_TYPE_ID,
          membershipTypeKey: `${PREFIX}required`,
          membershipTypeName: "Race 5190 Required",
          billingBasis: input.billingBasis,
          prorationRule: "NONE",
          annualAmountCents: FEE_CENTS,
          chargedAmountCents: input.billingBasis === "NO_INVOICE" ? 0 : FEE_CENTS,
          coveredMonths: 12,
          decisionDate: DECISION_DATE,
          coverageStart: new Date("2026-04-01T00:00:00.000Z"),
          coverageEnd: new Date("2027-03-31T00:00:00.000Z"),
          recipientMemberId: input.memberId,
          recipientName: "Liability member",
          recipientEmail: `${input.memberId}@example.invalid`,
          dueDays: 30,
          xeroAccountCode: "203",
          invoiceReference: `MEMSUB-RACE-5190-${input.key.toUpperCase()}`,
          coverage: {
            create: [{
              subscriptionId: input.subscriptionId,
              memberId: input.memberId,
              memberName: "Liability member",
              releasedAt: input.releasedAt,
            }],
          },
        },
      });
    }

    /**
     * The clear-up scans the whole season, so a foreign untouched row would be
     * moved too. Refuse rather than touch another suite's data.
     */
    async function assertNoForeignUntouchedRows() {
      const foreign = await prisma.memberSubscription.count({
        where: {
          seasonYear: SEASON_YEAR,
          status: "NOT_REQUIRED",
          NOT: { memberId: { startsWith: PREFIX } },
        },
      });
      expect(foreign, "a foreign NOT_REQUIRED row in the race database would be cleared by this suite").toBe(0);
    }

    async function optIn(choice: { requiredTypeAgeRule: "ALWAYS_OWES" | "AGE_TIER_EXEMPTS"; liabilityAgeSource: "SEASON_START" }) {
      return settingsWrite.saveLockoutSettings(prisma, {
        data: { ...choice, updatedByMemberId: OFFICER_ID },
        liabilityAfterSave: choice,
        seasonYear: SEASON_YEAR,
      });
    }

    async function storedRule() {
      return prisma.membershipLockoutSettings.findUniqueOrThrow({
        where: { id: "default" },
        select: { requiredTypeAgeRule: true, liabilityAgeSource: true },
      });
    }

    async function advisoryWaiters(): Promise<number> {
      const rows = await prisma.$queryRaw<Array<{ count: number }>>`
        SELECT COUNT(*)::int AS "count" FROM pg_locks l JOIN pg_database d ON d.oid = l.database
        WHERE d.datname = current_database() AND l.locktype = 'advisory' AND NOT l.granted`;
      return rows[0]?.count ?? 0;
    }

    async function untilAdvisoryWaiters(count: number) {
      const startedAt = process.hrtime.bigint();
      while ((await advisoryWaiters()) < count) {
        if (realElapsedMs(startedAt) > 10_000) throw new Error(`never saw ${count} advisory-lock waiter(s)`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }

    /**
     * Hold the billing season key in a transaction of its own until `release()`,
     * so the writers queued behind it are released in the order they arrived.
     */
    async function holdSeasonKey() {
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let acquired!: () => void;
      const isHeld = new Promise<void>((resolve) => {
        acquired = resolve;
      });
      const done = prisma.$transaction(
        async (tx) => {
          await seasonLock.lockSubscriptionBillingSeason(tx, SEASON_YEAR);
          acquired();
          await released;
        },
        { timeout: 30_000 },
      );
      await isHeld;
      return { release, done };
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      billing = await import("@/lib/membership-subscription-billing");
      defaults = await import("@/lib/member-subscription-defaults");
      settingsWrite = await import("@/lib/subscription-liability-settings-write");
      seasonLock = await import("@/lib/subscription-billing-season-lock");
      ruleLock = await import("@/lib/subscription-liability-rule-lock");
      assignments = await import("@/lib/seasonal-membership-assignments");
      where = await import("@/lib/subscription-liability-where");
      membershipTypes = await import("@/lib/membership-types");
      financialYear = await import("@/lib/financial-year");
      clubTime = await import("@/lib/club-time");
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
      await resetLockoutSettings();
      await seedTypesAndFee();
    });

    afterAll(async () => {
      if (!prisma) return;
      await deleteFixtures();
      financialYear.__setFinancialYearEndMonthForTesting(YEAR_END_MONTH);
      if (priorLockoutSettings) {
        // The only columns this suite writes.
        const { requiredTypeAgeRule, liabilityAgeSource, updatedByMemberId } = priorLockoutSettings;
        await prisma.membershipLockoutSettings.update({
          where: { id: "default" },
          data: { requiredTypeAgeRule, liabilityAgeSource, updatedByMemberId },
        });
      } else {
        await prisma.membershipLockoutSettings.deleteMany({ where: { id: "default" } });
      }
      if (createdMapping) await prisma.xeroAccountMapping.deleteMany({ where: { key: MAPPING_KEY } });
      if (priorXeroModule) await prisma.clubModuleSettings.update({ where: { id: "default" }, data: priorXeroModule, select: { id: true } });
      else await prisma.clubModuleSettings.deleteMany({ where: { id: "default" } });
    });

    it("opting in flips only the untouched and the covered-then-released row; invoiced, no-invoice-covered and manually marked rows stay", async () => {
      const released = new Date("2026-05-01T00:00:00.000Z");
      const cases = ["untouched", "invoiced", "no-invoice", "manual", "released", "other-season"] as const;
      const subscriptionIds = new Map<string, string>();
      for (const key of cases) {
        const memberId = `${PREFIX}${key}`;
        const seasonYear = key === "other-season" ? SEASON_YEAR + 1 : SEASON_YEAR;
        await createMember(memberId, "ADULT");
        await assign(memberId, REQUIRED_TYPE_ID, seasonYear);
        const subscription = await prisma.memberSubscription.create({
          data: {
            memberId,
            seasonYear,
            status: "NOT_REQUIRED",
            // Each guarded row differs from the untouched one in one column.
            xeroInvoiceId: key === "invoiced" ? `${PREFIX}inv` : null,
            manuallyMarkedPaidAt: key === "manual" ? released : null,
            manuallyMarkedPaidByMemberId: key === "manual" ? OFFICER_ID : null,
          },
        });
        subscriptionIds.set(key, subscription.id);
      }
      await chargeCovering({
        key: "no-invoice", memberId: `${PREFIX}no-invoice`, subscriptionId: subscriptionIds.get("no-invoice")!,
        billingBasis: "NO_INVOICE", status: "NOT_REQUIRED", releasedAt: null,
      });
      await chargeCovering({
        key: "released", memberId: `${PREFIX}released`, subscriptionId: subscriptionIds.get("released")!,
        billingBasis: "PER_MEMBER", status: "VOIDED", releasedAt: released,
      });
      await assertNoForeignUntouchedRows();

      const { clearedStaleRows } = await optIn(CHOSEN_ALWAYS);

      expect(clearedStaleRows).toEqual({
        clearedCount: 2,
        clearedMemberIds: [`${PREFIX}released`, `${PREFIX}untouched`],
      });
      const after = await prisma.memberSubscription.findMany({
        where: { memberId: { startsWith: PREFIX } },
        select: { memberId: true, status: true },
      });
      expect(Object.fromEntries(after.map((row) => [row.memberId.replace(PREFIX, ""), row.status]))).toEqual({
        untouched: "NOT_INVOICED",
        invoiced: "NOT_REQUIRED",
        "no-invoice": "NOT_REQUIRED",
        manual: "NOT_REQUIRED",
        released: "NOT_INVOICED",
        "other-season": "NOT_REQUIRED",
      });
      expect(await storedRule()).toEqual(CHOSEN_ALWAYS);

      // A second save of the same choice matches nothing.
      await expect(optIn(CHOSEN_ALWAYS)).resolves.toMatchObject({
        clearedStaleRows: { clearedCount: 0, clearedMemberIds: [] },
      });
    });

    describe("a billing confirm and the settings save serialise on the season key", () => {
      const CHILD_ID = `${PREFIX}child`;

      /** A REQUIRED-type child: billed under the default rule, exempt under AGE_TIER_EXEMPTS. */
      async function seedRequiredTypeChild() {
        await createMember(CHILD_ID, "CHILD");
        await assign(CHILD_ID, REQUIRED_TYPE_ID);
        await assertNoForeignUntouchedRows();
      }

      async function previewUnderDefaultRule() {
        const preview = await billing.buildSubscriptionBillingPreview({
          seasonYear: SEASON_YEAR,
          decisionDate: DECISION_DATE,
          memberIds: [CHILD_ID],
          yearEndMonth: YEAR_END_MONTH,
        });
        // The default billing rule charges every REQUIRED-type member (Edge 1).
        expect(preview.entries).toHaveLength(1);
        return preview;
      }

      function confirm(preview: Awaited<ReturnType<typeof previewUnderDefaultRule>>) {
        return billing.confirmSubscriptionBillingPreview({
          preview,
          expectedConfirmationToken: preview.confirmationToken,
          source: "ANNUAL_BATCH",
          confirmedByMemberId: OFFICER_ID,
        });
      }

      async function childChargeCount() {
        return prisma.membershipSubscriptionChargeCoverage.count({
          where: { memberId: CHILD_ID, releasedAt: null },
        });
      }

      it("confirm queued first: it bills under the rule it previewed, and the save waits for it", async () => {
        await seedRequiredTypeChild();
        const preview = await previewUnderDefaultRule();
        const gate = await holdSeasonKey();

        const confirmed = confirm(preview);
        await untilAdvisoryWaiters(1);
        const saved = optIn(CHOSEN_EXEMPTS);
        await untilAdvisoryWaiters(2);
        // The save is queued behind the key BEFORE its upsert: nothing changed yet.
        expect(await storedRule()).toEqual({ requiredTypeAgeRule: "NOT_CHOSEN", liabilityAgeSource: "NOT_CHOSEN" });

        gate.release();
        await gate.done;
        await expect(confirmed).resolves.toMatchObject({ exceptionCount: 0 });
        await saved;

        expect(await childChargeCount()).toBe(1);
        expect(await storedRule()).toEqual(CHOSEN_EXEMPTS);
      });

      it("save queued first: the confirm re-previews under the new rule and refuses its stale token, billing nobody", async () => {
        await seedRequiredTypeChild();
        const preview = await previewUnderDefaultRule();
        const gate = await holdSeasonKey();

        const saved = optIn(CHOSEN_EXEMPTS);
        await untilAdvisoryWaiters(1);
        const confirmed = confirm(preview);
        // Attach a handler now: the rejection lands before the assertion below.
        const outcome = confirmed.then(
          () => "confirmed",
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        );
        await untilAdvisoryWaiters(2);

        gate.release();
        await gate.done;
        await saved;

        expect(await outcome).toMatch(/Billing preview changed/);
        expect(await childChargeCount()).toBe(0);
        expect(await storedRule()).toEqual(CHOSEN_EXEMPTS);
      });

      it(
        "an opt-in queued behind a season-key holder for longer than Prisma's default 5 s still commits",
        async () => {
          // Billing confirm may hold the season key for its whole budget. The
          // save's transaction counts that wait, so on the default 5 s it would
          // fail with P2028 and the route would answer 500.
          expect(seasonLock.SUBSCRIPTION_BILLING_SEASON_WAITER_TIMEOUT_MS).toBeGreaterThan(
            seasonLock.SUBSCRIPTION_BILLING_CONFIRM_TIMEOUT_MS,
          );
          const gate = await holdSeasonKey();
          const saved = optIn(CHOSEN_ALWAYS);
          await untilAdvisoryWaiters(1);
          await new Promise((resolve) => setTimeout(resolve, PAST_DEFAULT_TRANSACTION_BUDGET_MS));
          gate.release();
          await gate.done;

          await expect(saved).resolves.toMatchObject({ record: CHOSEN_ALWAYS });
          expect(await storedRule()).toEqual(CHOSEN_ALWAYS);
        },
        RACE_TEST_TIMEOUT_MS,
      );

      it("an opt-in queued behind a confirm never holds up the seasonal-assignment reconcile; its clear-up still moves the row", async () => {
        const memberId = `${PREFIX}reconciled`;
        await createMember(memberId, "ADULT");
        await assign(memberId, AGE_TYPE_ID);
        await prisma.memberSubscription.create({ data: { memberId, seasonYear: SEASON_YEAR, status: "NOT_REQUIRED" } });
        await assertNoForeignUntouchedRows();
        const gate = await holdSeasonKey();

        // The opt-in waits on the season key BEFORE it takes the rule key, so
        // the reconcile is not queued behind it: it runs now, under NOT_CHOSEN
        // (only a REQUIRED type flips the row), and commits.
        const saved = optIn(CHOSEN_ALWAYS);
        await untilAdvisoryWaiters(1);
        await expect(
          prisma.$transaction((tx) =>
            defaults.reconcileSeasonSubscriptionForAssignment(tx, {
              memberId,
              seasonYear: SEASON_YEAR,
              subscriptionBehavior: "BASED_ON_AGE_TIER",
            }),
          ),
        ).resolves.toEqual({ reconciled: false });

        gate.release();
        await gate.done;
        // The clear-up, after the reconcile committed, sees and moves the row.
        await expect(saved).resolves.toMatchObject({ clearedStaleRows: { clearedCount: 1 } });
        expect(
          await prisma.memberSubscription.findUniqueOrThrow({
            where: { memberId_seasonYear: { memberId, seasonYear: SEASON_YEAR } },
            select: { status: true },
          }),
        ).toEqual({ status: "NOT_INVOICED" });
      });
    });

    describe("the seasonal-assignment reconcile and the liability-rule key (#5190 review)", () => {
      /**
       * A transaction standing in for a rule writer mid-save: it holds the
       * liability-rule key exclusive and has written the chosen rule, but has
       * not committed until `release()`.
       */
      async function holdRuleKeyWhileChoosing(choice: typeof CHOSEN_ALWAYS) {
        let release!: () => void;
        const released = new Promise<void>((resolve) => {
          release = resolve;
        });
        let acquired!: () => void;
        const isHeld = new Promise<void>((resolve) => {
          acquired = resolve;
        });
        const done = prisma.$transaction(
          async (tx) => {
            await ruleLock.lockSubscriptionLiabilityRuleExclusive(tx);
            await tx.membershipLockoutSettings.update({ where: { id: "default" }, data: choice });
            acquired();
            await released;
          },
          { timeout: 30_000 },
        );
        await isHeld;
        return { release, done };
      }

      /**
       * Backends holding the global key `lock(1)` while waiting on any other
       * advisory lock: the stall the review found. A bigint key 1 is
       * (classid 0, objid 1, objsubid 1) in `pg_locks`.
       */
      async function lock1HoldersWaitingOnAdvisory(): Promise<number> {
        const rows = await prisma.$queryRaw<Array<{ count: number }>>`
          SELECT COUNT(*)::int AS "count"
          FROM pg_locks held
          JOIN pg_locks waiting ON waiting.pid = held.pid
          JOIN pg_database d ON d.oid = held.database
          WHERE d.datname = current_database()
            AND held.locktype = 'advisory' AND held.granted
            AND held.classid = 0 AND held.objid = 1 AND held.objsubid = 1
            AND waiting.locktype = 'advisory' AND NOT waiting.granted`;
        return rows[0]?.count ?? 0;
      }

      it("the reconcile waits on the rule key while a rule writer holds it, then reads the rule that writer committed", async () => {
        const memberId = `${PREFIX}rule-wait`;
        await createMember(memberId, "ADULT");
        await assign(memberId, AGE_TYPE_ID);
        await prisma.memberSubscription.create({ data: { memberId, seasonYear: SEASON_YEAR, status: "NOT_REQUIRED" } });
        const gate = await holdRuleKeyWhileChoosing(CHOSEN_ALWAYS);

        const reconciled = prisma.$transaction((tx) =>
          defaults.reconcileSeasonSubscriptionForAssignment(tx, {
            memberId,
            seasonYear: SEASON_YEAR,
            subscriptionBehavior: "BASED_ON_AGE_TIER",
          }),
        );
        // Released whatever happens, so a failure here cannot strand the
        // rule key and the settings row for the tests after it.
        try {
          await untilAdvisoryWaiters(1);
        } finally {
          gate.release();
          await gate.done;
        }

        // Under NOT_CHOSEN a BASED_ON_AGE_TIER row is never flipped; under the
        // chosen ALWAYS_OWES rule this ADULT owes, so only a reconcile that
        // waited for the commit flips it.
        await expect(reconciled).resolves.toEqual({ reconciled: true });
      });

      // #5190 review: real writers on both sides. An assignment save moves a
      // member onto an age-based type and reconciles under NOT_CHOSEN (which
      // leaves a BASED_ON_AGE_TIER row alone), holding the rule key SHARED
      // until it commits. A real opt-in through `saveLockoutSettings` queues
      // behind it on the rule key inside its clear-up, then sees the committed
      // assignment and flips the row. Without the clear-up's exclusive rule
      // key it would judge the member on the old, not-required type, skip the
      // row, and leave it stale once the assignment commits.
      it("an opt-in's clear-up waits for a reconcile holding the rule key shared, then clears the row it left", async () => {
        const memberId = `${PREFIX}reconcile-first`;
        await createMember(memberId, "ADULT");
        await prisma.membershipType.create({
          data: {
            id: NOT_REQUIRED_TYPE_ID,
            key: `${PREFIX}not-required`,
            name: "Race 5190 Not Required",
            subscriptionBehavior: "NOT_REQUIRED",
          },
        });
        await assign(memberId, NOT_REQUIRED_TYPE_ID);
        await prisma.memberSubscription.create({ data: { memberId, seasonYear: SEASON_YEAR, status: "NOT_REQUIRED" } });
        await assertNoForeignUntouchedRows();

        let release!: () => void;
        const released = new Promise<void>((resolve) => {
          release = resolve;
        });
        let reconciledInside!: (value: { reconciled: boolean }) => void;
        const reconcileResult = new Promise<{ reconciled: boolean }>((resolve) => {
          reconciledInside = resolve;
        });
        const assignmentSave = prisma.$transaction(
          async (tx) => {
            await tx.seasonalMembershipAssignment.updateMany({
              where: { memberId, seasonYear: SEASON_YEAR },
              data: { membershipTypeId: AGE_TYPE_ID },
            });
            reconciledInside(
              await defaults.reconcileSeasonSubscriptionForAssignment(tx, {
                memberId,
                seasonYear: SEASON_YEAR,
                subscriptionBehavior: "BASED_ON_AGE_TIER",
              }),
            );
            await released;
          },
          { timeout: 30_000 },
        );
        // Under NOT_CHOSEN the reconcile leaves the age-based row alone.
        await expect(reconcileResult).resolves.toEqual({ reconciled: false });

        const saved = optIn(CHOSEN_ALWAYS);
        try {
          // The opt-in's clear-up is queued on the rule key behind the reconcile.
          await untilAdvisoryWaiters(1);
        } finally {
          release();
          await assignmentSave;
        }

        await expect(saved).resolves.toMatchObject({
          record: CHOSEN_ALWAYS,
          clearedStaleRows: { clearedCount: 1, clearedMemberIds: [memberId] },
        });
        expect(
          await prisma.memberSubscription.findUniqueOrThrow({
            where: { memberId_seasonYear: { memberId, seasonYear: SEASON_YEAR } },
            select: { status: true },
          }),
        ).toEqual({ status: "NOT_INVOICED" });
      });

      it("a roll-forward runs to completion while a billing confirm holds the season key, and never holds lock(1) while waiting", async () => {
        // Rolling forward from a season nothing else uses into the club's
        // current season, so the chunk takes lock(1), lodge and member keys and
        // then reconciles this member's untouched NOT_REQUIRED row.
        const FROM_SEASON = 1990;
        const memberId = `${PREFIX}roll-forward`;
        await createMember(memberId, "ADULT");
        await assign(memberId, REQUIRED_TYPE_ID, FROM_SEASON);
        await prisma.memberSubscription.create({ data: { memberId, seasonYear: SEASON_YEAR, status: "NOT_REQUIRED" } });
        expect(
          await prisma.seasonalMembershipAssignment.count({ where: { seasonYear: FROM_SEASON, NOT: { memberId } } }),
          "another suite's assignment in the source season would be rolled forward too",
        ).toBe(0);
        // A transaction standing in for a billing confirm: confirm holds the
        // season key for its whole in-transaction re-preview.
        const gate = await holdSeasonKey();

        let rollDone = false;
        const rolled = assignments
          .rollForwardSeasonalMembershipAssignments({
            fromSeasonYear: FROM_SEASON,
            toSeasonYear: SEASON_YEAR,
            adminMemberId: OFFICER_ID,
          })
          .finally(() => {
            rollDone = true;
          });

        // Sample the lock table until the roll-forward finishes or 10 s pass,
        // with the season key held throughout.
        let worstStall = 0;
        const startedAt = process.hrtime.bigint();
        while (!rollDone && realElapsedMs(startedAt) < 10_000) {
          worstStall = Math.max(worstStall, await lock1HoldersWaitingOnAdvisory());
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const finishedWhileHeld = rollDone;
        gate.release();
        await gate.done;
        const result = await rolled;

        expect(worstStall, "a transaction held lock(1) while waiting on an advisory key").toBe(0);
        expect(finishedWhileHeld, "the roll-forward waited for the billing confirm").toBe(true);
        expect(result.init?.status ?? 200).toBe(200);
        expect(
          await prisma.memberSubscription.findUniqueOrThrow({
            where: { memberId_seasonYear: { memberId, seasonYear: SEASON_YEAR } },
            select: { status: true },
          }),
        ).toEqual({ status: "NOT_INVOICED" });
      });
    });

    describe("the SQL date-of-birth check agrees with the TS rule at every tier birthday", () => {
      type Behavior = Extract<MembershipTypeSubscriptionBehavior, "REQUIRED" | "BASED_ON_AGE_TIER">;
      const SOURCES = ["SEASON_START", "SEASON_END"] as const;
      const RULES = ["ALWAYS_OWES", "AGE_TIER_EXEMPTS"] as const;
      const MIN_AGES = [5, 13, 18];

      /**
       * Births one day either side of, and on, each tier birthday at the
       * reference day, plus 29 February births whose 13th or 5th birthday
       * falls in a non-leap year.
       */
      function boundaryBirths(reference: string): string[] {
        const births = new Set<string>(["2012-02-29", "2016-02-29", "2020-02-29", "2015-02-28", "2015-03-01"]);
        for (const minAge of MIN_AGES) {
          const anniversary = clubTime.addCalendarMonths(reference as never, -12 * minAge);
          for (const offset of [-1, 0, 1]) births.add(clubTime.addCalendarDays(anniversary, offset));
        }
        return [...births].sort();
      }

      async function proveSeason(input: { yearEndMonth: number; seasonYear: number; label: string }) {
        financialYear.__setFinancialYearEndMonthForTesting(input.yearEndMonth);
        const { getSeasonStartCalendarDate } = await import("@/lib/policies/age-tier");
        const { getSeasonEndCalendarDate } = await import("@/lib/policies/subscription");
        const references = [getSeasonStartCalendarDate(input.seasonYear), getSeasonEndCalendarDate(input.seasonYear)];
        const births = [...new Set(references.flatMap(boundaryBirths))].sort();

        const members: Array<{ id: string; behavior: Behavior; ageTier: AgeTier; dateOfBirth: Date | null }> = [];
        const subjects: Array<{ dateOfBirth: string | null; ageTier: AgeTier }> = [
          ...births.map((dateOfBirth) => ({ dateOfBirth, ageTier: "ADULT" as AgeTier })),
          { dateOfBirth: null, ageTier: "CHILD" },
          { dateOfBirth: null, ageTier: "ADULT" },
        ];
        let index = 0;
        for (const subject of subjects) {
          for (const behavior of ["REQUIRED", "BASED_ON_AGE_TIER"] as const) {
            const id = `${PREFIX}dob-${input.label}-${index++}`;
            const dateOfBirth = subject.dateOfBirth ? new Date(`${subject.dateOfBirth}T00:00:00.000Z`) : null;
            await createMember(id, subject.ageTier, dateOfBirth);
            await assign(id, behavior === "REQUIRED" ? REQUIRED_TYPE_ID : AGE_TYPE_ID, input.seasonYear);
            members.push({ id, behavior, ageTier: subject.ageTier, dateOfBirth });
          }
        }
        const ids = members.map((member) => member.id);

        for (const requiredTypeAgeRule of RULES) {
          for (const liabilityAgeSource of SOURCES) {
            const liabilitySettings = { requiredTypeAgeRule, liabilityAgeSource };
            const conditions = where.subscriptionNotRequiredMemberConditions({
              seasonYear: input.seasonYear,
              ageTierSettings: [...AGE_TIER_SETTINGS],
              liabilitySettings,
            });
            const [notRequired, owing] = await Promise.all([
              prisma.member.findMany({ where: { id: { in: ids }, OR: conditions }, select: { id: true } }),
              prisma.member.findMany({ where: { id: { in: ids }, NOT: { OR: conditions } }, select: { id: true } }),
            ]);
            const sqlNotRequired = new Set(notRequired.map((row) => row.id));
            // Every member lands on exactly one side: no NULL drops either.
            expect(notRequired.length + owing.length).toBe(ids.length);
            const disagreements = members.filter((member) => {
              const tsNotRequired = membershipTypes.isSubscriptionNotRequiredForMembershipType({
                subscriptionBehavior: member.behavior,
                member,
                seasonRowStatus: null,
                seasonYear: input.seasonYear,
                ageTierSettings: [...AGE_TIER_SETTINGS],
                liabilitySettings,
              });
              return tsNotRequired !== sqlNotRequired.has(member.id);
            });
            expect(
              disagreements.map((member) => ({
                behavior: member.behavior,
                dateOfBirth: member.dateOfBirth?.toISOString().slice(0, 10) ?? null,
                ageTier: member.ageTier,
              })),
              `${input.label} ${requiredTypeAgeRule}/${liabilityAgeSource}`,
            ).toEqual([]);
            // Neither side may agree by matching everyone or no one.
            expect(sqlNotRequired.size, `${input.label} ${requiredTypeAgeRule}/${liabilityAgeSource}`).toBeGreaterThan(0);
            expect(owing.length).toBeGreaterThan(0);
          }
        }
      }

      it("31 March year-end: season 2026 runs 2026-04-01 to 2027-03-31", async () => {
        await proveSeason({ yearEndMonth: 3, seasonYear: 2026, label: "mar" });
      });

      it("February year-end: 28 February season ends against 29 February births, and a leap-day season end", async () => {
        try {
          // Season 2024 ends 2025-02-28 (13th birthdays of 2012-02-29 births);
          // season 2027 ends 2028-02-29; season 2028 ends 2029-02-28.
          await proveSeason({ yearEndMonth: 2, seasonYear: 2024, label: "feb24" });
          await proveSeason({ yearEndMonth: 2, seasonYear: 2027, label: "feb27" });
          await proveSeason({ yearEndMonth: 2, seasonYear: 2028, label: "feb28" });
        } finally {
          financialYear.__setFinancialYearEndMonthForTesting(YEAR_END_MONTH);
        }
      });
    });
  },
);
