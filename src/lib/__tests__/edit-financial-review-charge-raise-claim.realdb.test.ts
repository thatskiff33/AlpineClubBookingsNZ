/**
 * Real-PostgreSQL proof that a review-charge RAISE is single-flight per edit
 * (#3402, `INV-PAY-111`).
 *
 * `syncEditFinancialReviewChargeRequest` reads the edit's one request, derives
 * the new ask, calls Stripe, and writes the row. No lock may be held across that
 * Stripe call, so before #3402 two runs for two shares of one edit could both
 * read the stored $50, derive $60 and $100, and both raise the intent: whichever
 * provider call and row write landed LAST won, and if that was the $60 run the
 * second officer's $40 was never asked for and nothing recorded it.
 *
 * The case below drives that exact interleaving through the REAL sync, the real
 * `PaymentTransaction` and `ManualRefundTask` rows and the real ledger writes.
 * Only the two Stripe calls are replaced - by gates the test opens - so the
 * interleaving is FORCED rather than raced for: run A is parked inside its
 * provider call while run B is started and allowed to finish, and only then is A
 * released.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so CI reaches it; it owns and cleans its own
 * `race-3402-` fixtures.
 *
 * To run directly against a throwaway scratch database:
 *   RUN_CONCURRENCY_RACE_TESTS=1 \
 *   CONCURRENCY_RACE_DATABASE_URL=postgresql://user:pass@127.0.0.1:55442/concurrency_race_1881 \
 *   pnpm exec vitest run src/lib/__tests__/edit-financial-review-charge-raise-claim.realdb.test.ts
 */
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { realElapsedMs } from "@/lib/__tests__/helpers/clock";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const MEMBER_ID = "race-3402-member";
const LODGE_ID = "race-3402-lodge";
const BOOKING_ID = "race-3402-booking";
const PAYMENT_ID = "race-3402-payment";
const MODIFICATION_ID = "race-3402-modification";
const REQUEST_INTENT_ID = "pi_race_3402_request";
const CHECK_IN = new Date("2026-08-01T00:00:00.000Z");
const CHECK_OUT = new Date("2026-08-03T00:00:00.000Z");

/** A barrier gives up with a named diagnostic before Vitest's timeout does. */
const LOCK_POLL_TIMEOUT_MS = 2_000;
const RACE_TEST_TIMEOUT_MS = 20_000;
/** Setup imports the whole charge path and opens two extra connections. */
const BEFORE_ALL_TIMEOUT_MS = 60_000;

/**
 * The two provider calls the raise makes, replaced only while a case installs a
 * hook. Every other suite the #1881 harness imports alongside this file sees the
 * REAL functions, because a `vi.mock` here is registered for the whole harness
 * process and must therefore be a pass-through by default.
 */
const stripeHooks = vi.hoisted(() => ({
  update: null as null | ((id: string, amountCents: number) => Promise<unknown>),
  get: null as null | ((id: string) => Promise<unknown>),
}));
vi.mock("@/lib/stripe", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/stripe");
  return {
    ...actual,
    updatePaymentIntentAmount: (id: string, amountCents: number) =>
      stripeHooks.update
        ? stripeHooks.update(id, amountCents)
        : actual.updatePaymentIntentAmount(id, amountCents),
    getPaymentIntent: ((...args: Parameters<typeof actual.getPaymentIntent>) =>
      stripeHooks.get
        ? stripeHooks.get(args[0])
        : actual.getPaymentIntent(...args)) as typeof actual.getPaymentIntent,
  };
});

/** Standalone fail-closed copy: importing this file must not register another suite. */
export function assertSafeReviewChargeClaimRaceDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Review-charge claim race proofs need a valid CONCURRENCY_RACE_DATABASE_URL.");
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(
      `Refusing to run review-charge claim race proofs against port ${parsed.port || "(none)"}: use a throwaway PostgreSQL on 55442+ (never 5432).`,
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error("Review-charge claim race proof DB must be loopback-only.");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName.includes("concurrency_race_1881")) {
    throw new Error("Review-charge claim race proof DB name must contain 'concurrency_race_1881'.");
  }
}

describe("review-charge claim race DB safety guard (#3402)", () => {
  it("accepts only a dedicated loopback scratch database", () => {
    expect(() =>
      assertSafeReviewChargeClaimRaceDbUrl(
        "postgresql://user:pass@127.0.0.1:55442/concurrency_race_1881",
      ),
    ).not.toThrow();
  });

  it.each([
    "postgresql://user:pass@db.example.org:55442/concurrency_race_1881",
    "postgresql://user:pass@127.0.0.1:5432/concurrency_race_1881",
    "postgresql://user:pass@127.0.0.1:55442/app",
    "not-a-url",
  ])("rejects unsafe target %s", (url) => {
    expect(() => assertSafeReviewChargeClaimRaceDbUrl(url)).toThrow();
  });
});

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let syncEditFinancialReviewChargeRequest: (typeof import("@/lib/edit-financial-review-charge"))["syncEditFinancialReviewChargeRequest"];
let buildEditFinancialReviewChargeReason: (typeof import("@/lib/payment-recovery-keys"))["buildEditFinancialReviewChargeReason"];
let stripeChargeCurrency: (typeof import("@/lib/stripe-charge-currency"))["stripeChargeCurrency"];
let claimModule: typeof import("@/lib/edit-financial-review-charge-raise-claim");
let recoveryModule: typeof import("@/lib/payment-recovery");
let buildRecoveryKey: (typeof import("@/lib/payment-recovery-keys"))["buildEditFinancialReviewAdditionalIntentRecoveryIdempotencyKey"];
let buildRecoveryStripeKey: (typeof import("@/lib/payment-recovery-keys"))["buildEditFinancialReviewAdditionalIntentStripeKey"];

/**
 * Two SEPARATE single-connection clients: one pins the claim ROW open inside a
 * real transaction, the other polls `pg_blocking_pids`. Neither shares the
 * application pool, whose connections the queued contenders are holding.
 */
let lockHolderClient: PrismaClient;
let observerClient: PrismaClient;

(RUN ? describe : describe.skip)(
  "review-charge raise claim — real PostgreSQL (#3402)",
  { timeout: RACE_TEST_TIMEOUT_MS },
  () => {
    let shareSeq = 0;

    /** One settled CHARGE share against the edit, as a completed review writes it. */
    async function settleShare(amountCents: number) {
      shareSeq += 1;
      await prisma.manualRefundTask.create({
        data: {
          bookingId: BOOKING_ID,
          kind: "EDIT_FINANCIAL_REVIEW",
          status: "COMPLETED",
          settlementDirection: "CHARGE_TO_MEMBER",
          amountCents,
          occurrenceKey: `race-3402-occurrence-${shareSeq}`,
          reason: "race-3402 settled share",
          completedAt: new Date(),
          reviewContext: {
            version: 1,
            occurrence: {
              bookingId: BOOKING_ID,
              bookingGuestId: `race-3402-guest-${shareSeq}`,
              cause: "NO_STORED_NIGHT_PRICES",
              surrenderedNightDates: [],
              addedNightDates: ["2026-08-02"],
              storedEvidence: { guestTotalCents: null, nightPrices: [] },
            },
            guestMemberId: MEMBER_ID,
            bookingCheckIn: "2026-08-01",
            bookingCheckOut: "2026-08-03",
            bookingModificationId: MODIFICATION_ID,
          },
        },
      });
    }

    const sync = () =>
      syncEditFinancialReviewChargeRequest({
        format: CLUB_FORMAT_TEST,
        bookingId: BOOKING_ID,
        bookingModificationId: MODIFICATION_ID,
        paymentId: PAYMENT_ID,
        member: {
          id: MEMBER_ID,
          email: "race-3402@example.invalid",
          name: "Claim Member",
          stripeCustomerId: null,
        },
        hasIssuedXeroInvoice: false,
      });

    async function clearRunState() {
      await prisma.editReviewChargeRaiseClaim.deleteMany({
        where: { bookingModificationId: MODIFICATION_ID },
      });
      await prisma.paymentRecoveryOperation.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.auditLog.deleteMany({
        where: {
          OR: [
            { memberId: MEMBER_ID },
            { actorMemberId: MEMBER_ID },
            { targetId: { in: [BOOKING_ID, MODIFICATION_ID] } },
          ],
        },
      });
      await prisma.manualRefundTask.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
    }

    async function deleteFixtures() {
      await clearRunState();
      await prisma.bookingModification.deleteMany({ where: { id: MODIFICATION_ID } });
      await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
      await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
    }

    beforeAll(async () => {
      assertSafeReviewChargeClaimRaceDbUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      ({ syncEditFinancialReviewChargeRequest } = await import(
        "@/lib/edit-financial-review-charge"
      ));
      ({
        buildEditFinancialReviewChargeReason,
        buildEditFinancialReviewAdditionalIntentRecoveryIdempotencyKey: buildRecoveryKey,
        buildEditFinancialReviewAdditionalIntentStripeKey: buildRecoveryStripeKey,
      } = await import("@/lib/payment-recovery-keys"));
      recoveryModule = await import("@/lib/payment-recovery");
      ({ stripeChargeCurrency } = await import("@/lib/stripe-charge-currency"));
      claimModule = await import("@/lib/edit-financial-review-charge-raise-claim");

      const [{ PrismaClient: SeparatePrismaClient }, { createPrismaPgAdapter }] =
        await Promise.all([import("@prisma/client"), import("@/lib/prisma-adapter")]);
      const createSeparateClient = (applicationName: string) => {
        const url = new URL(RACE_DB_URL);
        url.searchParams.set("connection_limit", "1");
        url.searchParams.set("application_name", applicationName);
        return new SeparatePrismaClient({ adapter: createPrismaPgAdapter(url.toString()) });
      };
      lockHolderClient = createSeparateClient("race-3402-lock-holder");
      observerClient = createSeparateClient("race-3402-observer");
      await Promise.all([lockHolderClient.$connect(), observerClient.$connect()]);

      await deleteFixtures();
      await prisma.member.create({
        data: {
          id: MEMBER_ID,
          email: "race-3402@example.invalid",
          passwordHash: "not-a-real-password",
          firstName: "Claim",
          lastName: "Member",
          ageTier: "ADULT",
        },
      });
      await prisma.lodge.create({
        data: { id: LODGE_ID, name: "Race 3402 Lodge", slug: "race-3402" },
      });
      await prisma.booking.create({
        data: {
          id: BOOKING_ID,
          memberId: MEMBER_ID,
          lodgeId: LODGE_ID,
          checkIn: CHECK_IN,
          checkOut: CHECK_OUT,
          status: "PAID",
          totalPriceCents: 20_000,
          finalPriceCents: 20_000,
        },
      });
      await prisma.bookingModification.create({
        data: {
          id: MODIFICATION_ID,
          bookingId: BOOKING_ID,
          memberId: MEMBER_ID,
          modificationType: "BATCH_MODIFY",
          previousData: {},
          newData: {},
        },
      });
      await prisma.payment.create({
        data: {
          id: PAYMENT_ID,
          bookingId: BOOKING_ID,
          amountCents: 20_000,
          status: "SUCCEEDED",
          source: "STRIPE",
          stripePaymentIntentId: "pi_race_3402_primary",
        },
      });
    }, BEFORE_ALL_TIMEOUT_MS);

    beforeEach(async () => {
      stripeHooks.update = null;
      stripeHooks.get = null;
      await clearRunState();
    });

    afterAll(async () => {
      stripeHooks.update = null;
      stripeHooks.get = null;
      if (!prisma) return;
      await deleteFixtures();
      await Promise.all([lockHolderClient?.$disconnect(), observerClient?.$disconnect()]);
    });

    /**
     * The request as the first share left it: one PENDING ADDITIONAL row on the
     * edit's intent, asking for that share's $50. The PRIMARY row is the
     * captured booking payment the request hangs off.
     */
    async function seedRequestAt(amountCents: number) {
      await prisma.paymentTransaction.create({
        data: {
          paymentId: PAYMENT_ID,
          kind: "PRIMARY",
          source: "STRIPE",
          stripePaymentIntentId: "pi_race_3402_primary",
          amountCents: 20_000,
          status: "SUCCEEDED",
        },
      });
      await prisma.paymentTransaction.create({
        data: {
          paymentId: PAYMENT_ID,
          kind: "ADDITIONAL",
          source: "STRIPE",
          stripePaymentIntentId: REQUEST_INTENT_ID,
          amountCents,
          status: "PENDING",
          reason: buildEditFinancialReviewChargeReason(MODIFICATION_ID),
        },
      });
    }

    it("two shares settling in one window end with the TRUE total asked, at Stripe and on the row ($60 / $100 against a stored $50)", async () => {
      await settleShare(5_000);
      await seedRequestAt(5_000);

      // The intent at Stripe: what it asks for after every update that LANDED,
      // in the order they landed.
      const landed: number[] = [];
      const runAReachedStripe = deferred();
      const releaseRunA = deferred();
      let updates = 0;
      stripeHooks.get = async (id) => ({
        id,
        status: "requires_payment_method",
        currency: stripeChargeCurrency(CLUB_FORMAT_TEST),
        amount: landed.at(-1) ?? 5_000,
      });
      stripeHooks.update = async (id, amountCents) => {
        updates += 1;
        if (updates === 1) {
          // Run A: parked INSIDE its provider call until the test lets it land.
          runAReachedStripe.resolve();
          await releaseRunA.promise;
        }
        landed.push(amountCents);
        return { id, amount: amountCents, status: "requires_payment_method" };
      };

      // Officer A's share commits: the shares now total $60.
      await settleShare(1_000);
      const runA = sync();
      await runAReachedStripe.promise;

      // Officer B's share commits while A is mid-raise: the shares total $100.
      await settleShare(4_000);
      const runB = await sync();

      releaseRunA.resolve();
      const resultA = await runA;

      const row = await prisma.paymentTransaction.findUniqueOrThrow({
        where: { stripePaymentIntentId: REQUEST_INTENT_ID },
        select: { amountCents: true },
      });
      // The member is asked for all $100, and the row the pay page renders
      // agrees with the intent Stripe holds.
      expect(landed.at(-1)).toBe(10_000);
      expect(row.amountCents).toBe(10_000);
      // Exactly what each run did: B found the claim held, called no provider
      // and made its debt durable; A raised twice - for the $60 it saw, then,
      // after releasing, for the $100 B's share had made it.
      expect(runB.outcome).toBe("deferred");
      expect(resultA).toMatchObject({ outcome: "raised", totalCents: 10_000 });
      expect(landed).toEqual([6_000, 10_000]);
      expect(
        await prisma.paymentRecoveryOperation.count({ where: { bookingId: BOOKING_ID } }),
      ).toBe(1);
      // And the claim is free again for the next settlement.
      expect(
        await prisma.editReviewChargeRaiseClaim.findUniqueOrThrow({
          where: { bookingModificationId: MODIFICATION_ID },
          select: { claimToken: true, claimedAt: true, intendedAmountCents: true },
        }),
      ).toEqual({ claimToken: null, claimedAt: null, intendedAmountCents: null });
    });

    it("a raise Stripe REFUSES leaves the row equal to the unchanged intent and the claim free", async () => {
      await settleShare(5_000);
      await seedRequestAt(5_000);
      await settleShare(2_000);
      stripeHooks.get = async (id) => ({
        id,
        status: "requires_payment_method",
        currency: stripeChargeCurrency(CLUB_FORMAT_TEST),
        amount: 5_000,
      });
      let intentDuringCall: number | null = null;
      stripeHooks.update = async () => {
        // The intent is recorded under the claim BEFORE the provider hears of it.
        intentDuringCall = (
          await prisma.editReviewChargeRaiseClaim.findUniqueOrThrow({
            where: { bookingModificationId: MODIFICATION_ID },
          })
        ).intendedAmountCents;
        throw new Error(
          "This PaymentIntent's amount could not be updated because it has a status of processing.",
        );
      };

      await expect(sync()).rejects.toThrow(/could not be updated/);

      expect(intentDuringCall).toBe(7_000);
      const row = await prisma.paymentTransaction.findUniqueOrThrow({
        where: { stripePaymentIntentId: REQUEST_INTENT_ID },
        select: { amountCents: true, status: true },
      });
      expect(row).toEqual({ amountCents: 5_000, status: "PENDING" });
      expect(
        await prisma.editReviewChargeRaiseClaim.findUniqueOrThrow({
          where: { bookingModificationId: MODIFICATION_ID },
          select: { claimToken: true, intendedAmountCents: true },
        }),
      ).toEqual({ claimToken: null, intendedAmountCents: null });

      // The replay is the same function: once Stripe accepts, it converges.
      stripeHooks.update = async (id, amountCents) => ({ id, amount: amountCents });
      await expect(sync()).resolves.toMatchObject({ outcome: "raised", totalCents: 7_000 });
      expect(
        (
          await prisma.paymentTransaction.findUniqueOrThrow({
            where: { stripePaymentIntentId: REQUEST_INTENT_ID },
          })
        ).amountCents,
      ).toBe(7_000);
    });

    /** How many backends wait on `blockerPid`, directly or through another waiter. */
    async function blockedByHolder(blockerPid: number): Promise<number> {
      const rows = await observerClient.$queryRaw<Array<{ count: number }>>`
        WITH RECURSIVE waits AS (
          SELECT activity.pid AS waiter, blocker.pid AS blocker
          FROM pg_stat_activity AS activity
          CROSS JOIN LATERAL unnest(pg_blocking_pids(activity.pid)) AS blocker(pid)
          WHERE activity.datname = current_database()
            AND activity.pid <> pg_backend_pid()
        ),
        chain AS (
          SELECT waiter, blocker FROM waits
          UNION
          SELECT chain.waiter, waits.blocker
          FROM chain
          JOIN waits ON waits.waiter = chain.blocker
        )
        SELECT COUNT(DISTINCT waiter)::int AS "count"
        FROM chain
        WHERE blocker = ${blockerPid}::int
      `;
      return rows[0]?.count ?? 0;
    }

    it("two claims queued on the SAME row at once: PostgreSQL lets exactly one win", async () => {
      // The row exists and is free; a third connection holds it so that both
      // claims are parked on its row lock before either can evaluate.
      await prisma.editReviewChargeRaiseClaim.create({
        data: { bookingModificationId: MODIFICATION_ID },
      });
      const holderReady = deferred<number>();
      const releaseHolder = deferred();
      const holder = lockHolderClient.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT 1 FROM "EditReviewChargeRaiseClaim" WHERE "bookingModificationId" = ${MODIFICATION_ID} FOR UPDATE`;
          const [{ pid }] = await tx.$queryRaw<
            Array<{ pid: number }>
          >`SELECT pg_backend_pid() AS pid`;
          holderReady.resolve(pid);
          await releaseHolder.promise;
        },
        { maxWait: 5_000, timeout: 15_000 },
      );
      const holderPid = await holderReady.promise;

      const contenders = [
        claimModule.claimEditReviewChargeRaise(MODIFICATION_ID),
        claimModule.claimEditReviewChargeRaise(MODIFICATION_ID),
      ];
      const startedAt = process.hrtime.bigint();
      let queued = 0;
      while (realElapsedMs(startedAt) < LOCK_POLL_TIMEOUT_MS) {
        queued = await blockedByHolder(holderPid);
        if (queued >= 2) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      releaseHolder.resolve();
      await holder;
      const claims = await Promise.all(contenders);
      // Asserted only after both have settled, so a failed barrier cannot leave
      // a contender running into the next case.
      expect(queued, "both claims must be parked behind the held row").toBeGreaterThanOrEqual(2);

      expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
      const winner = claims.find((claim) => claim !== null);
      expect(
        (
          await prisma.editReviewChargeRaiseClaim.findUniqueOrThrow({
            where: { bookingModificationId: MODIFICATION_ID },
          })
        ).claimToken,
      ).toBe(winner?.token);
    });

    it("a live claim refuses a second; an EXPIRED one is taken over, and its stale holder can neither record nor release", async () => {
      const first = await claimModule.claimEditReviewChargeRaise(MODIFICATION_ID);
      expect(first).not.toBeNull();
      expect(await claimModule.claimEditReviewChargeRaise(MODIFICATION_ID)).toBeNull();

      // The holder dies; its lease ages past the limit.
      await prisma.editReviewChargeRaiseClaim.update({
        where: { bookingModificationId: MODIFICATION_ID },
        data: {
          claimedAt: new Date(Date.now() - claimModule.EDIT_REVIEW_CHARGE_RAISE_LEASE_MS - 1),
        },
      });
      const successor = await claimModule.claimEditReviewChargeRaise(MODIFICATION_ID);
      expect(successor).not.toBeNull();
      expect(successor?.token).not.toBe(first?.token);

      // The stale holder wakes: every write is exact-token, so it touches nothing.
      expect(await claimModule.recordEditReviewChargeRaiseIntent(first!, 9_000)).toBe(false);
      expect(await claimModule.releaseEditReviewChargeRaise(first!)).toBe(false);
      const row = await prisma.editReviewChargeRaiseClaim.findUniqueOrThrow({
        where: { bookingModificationId: MODIFICATION_ID },
      });
      expect(row.claimToken).toBe(successor?.token);
      expect(row.intendedAmountCents).toBeNull();

      expect(await claimModule.releaseEditReviewChargeRaise(successor!)).toBe(true);
    });

    /**
     * Under the frozen clock every `new Date()` is the same instant, so a claim
     * taken "now" can never look stale whatever the lease is - a lease of ZERO
     * would pass every case above. These seed the claim time AT the edges of the
     * lease instead, which pins its length and the strictness of its boundary.
     */
    it("the lease protects its holder for its WHOLE length, up to and including the boundary instant", async () => {
      const { EDIT_REVIEW_CHARGE_RAISE_LEASE_MS } = claimModule;
      const ageClaimTo = async (ageMs: number) =>
        prisma.editReviewChargeRaiseClaim.update({
          where: { bookingModificationId: MODIFICATION_ID },
          data: { claimedAt: new Date(Date.now() - ageMs) },
        });
      const first = await claimModule.claimEditReviewChargeRaise(MODIFICATION_ID);
      expect(first).not.toBeNull();

      // A FIXED figure, not one read off the constant (which would agree with any
      // value, zero included): twenty minutes covers the slowest live holder the
      // lease's docblock argues for - a few Stripe calls at about four minutes
      // each - so a claim that old must still be refused.
      await ageClaimTo(20 * 60 * 1000);
      expect(await claimModule.claimEditReviewChargeRaise(MODIFICATION_ID)).toBeNull();

      // One millisecond short of the lease: still the holder's.
      await ageClaimTo(EDIT_REVIEW_CHARGE_RAISE_LEASE_MS - 1);
      expect(await claimModule.claimEditReviewChargeRaise(MODIFICATION_ID)).toBeNull();

      // Exactly the lease: still the holder's (`lt`, not `lte`).
      await ageClaimTo(EDIT_REVIEW_CHARGE_RAISE_LEASE_MS);
      expect(await claimModule.claimEditReviewChargeRaise(MODIFICATION_ID)).toBeNull();

      // One millisecond past it: taken over.
      await ageClaimTo(EDIT_REVIEW_CHARGE_RAISE_LEASE_MS + 1);
      const successor = await claimModule.claimEditReviewChargeRaise(MODIFICATION_ID);
      expect(successor).not.toBeNull();
      expect(successor?.token).not.toBe(first?.token);
      await claimModule.releaseEditReviewChargeRaise(successor!);
    });

    /**
     * `INV-PAY-111`'s backstop. The edit has ONE recovery row; an earlier replay
     * that closed it SUCCEEDED used to leave a later deferral writing nothing that
     * would ever run - the share it deferred was never asked for.
     */
    it("a deferral REOPENS the edit's recovery row an earlier replay closed, and the replay then raises the deferred share", async () => {
      await settleShare(5_000);
      await seedRequestAt(5_000);
      const closed = await prisma.paymentRecoveryOperation.create({
        data: {
          type: "CREATE_ADDITIONAL_PAYMENT_INTENT",
          status: "SUCCEEDED",
          bookingId: BOOKING_ID,
          paymentId: PAYMENT_ID,
          paymentIntentId: buildRecoveryStripeKey(MODIFICATION_ID),
          amountCents: 5_000,
          hadIssuedXeroInvoice: false,
          idempotencyKey: buildRecoveryKey(MODIFICATION_ID),
          attempts: 2,
          nextRetryAt: null,
          succeededAt: new Date(),
        },
      });
      const landed: number[] = [];
      stripeHooks.get = async (id) => ({
        id,
        status: "requires_payment_method",
        currency: stripeChargeCurrency(CLUB_FORMAT_TEST),
        amount: landed.at(-1) ?? 5_000,
      });
      stripeHooks.update = async (id, amountCents) => {
        landed.push(amountCents);
        return { id, amount: amountCents };
      };

      // A new share settles while another run holds the claim: it defers.
      await settleShare(2_000);
      const holder = await claimModule.claimEditReviewChargeRaise(MODIFICATION_ID);
      await expect(sync()).resolves.toMatchObject({ outcome: "deferred", totalCents: 7_000 });
      // The holder then dies without raising.
      await claimModule.releaseEditReviewChargeRaise(holder!);
      expect(landed).toEqual([]);

      const reopened = await prisma.paymentRecoveryOperation.findUniqueOrThrow({
        where: { id: closed.id },
      });
      expect(reopened).toMatchObject({ status: "PENDING", attempts: 0, succeededAt: null });
      expect(reopened.nextRetryAt).not.toBeNull();

      // The cron's replay claims the reopened row and raises the deferred share.
      await expect(
        recoveryModule.runPaymentRecoveryOperationNow(closed.id, CLUB_FORMAT_TEST),
      ).resolves.toBe("succeeded");
      expect(landed).toEqual([7_000]);
      expect(
        (
          await prisma.paymentTransaction.findUniqueOrThrow({
            where: { stripePaymentIntentId: REQUEST_INTENT_ID },
          })
        ).amountCents,
      ).toBe(7_000);
      expect(
        (await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { id: closed.id } }))
          .status,
      ).toBe("SUCCEEDED");
    });

    it("a payment webhook that lands while the raise is in flight is NOT reverted to PENDING by the raise's row write", async () => {
      await settleShare(5_000);
      await seedRequestAt(5_000);
      await settleShare(2_000);
      stripeHooks.get = async (id) => ({
        id,
        status: "requires_payment_method",
        currency: stripeChargeCurrency(CLUB_FORMAT_TEST),
        amount: 5_000,
      });
      stripeHooks.update = async (id, amountCents) => {
        // Stripe accepts the new amount; the member pays it at once, and the
        // `payment_intent.succeeded` webhook records that before our row write.
        await prisma.paymentTransaction.update({
          where: { stripePaymentIntentId: REQUEST_INTENT_ID },
          data: { status: "SUCCEEDED", amountCents },
        });
        return { id, amount: amountCents };
      };

      await expect(sync()).resolves.toMatchObject({
        outcome: "already-paid",
        paymentIntentId: REQUEST_INTENT_ID,
        totalCents: 7_000,
      });

      expect(
        await prisma.paymentTransaction.findUniqueOrThrow({
          where: { stripePaymentIntentId: REQUEST_INTENT_ID },
          select: { status: true, amountCents: true },
        }),
      ).toEqual({ status: "SUCCEEDED", amountCents: 7_000 });
    });

    /** The `ask-closed` audit rows written for this edit, as the totals they name. */
    async function uncollectedTotals(): Promise<number[]> {
      const rows = await prisma.auditLog.findMany({
        where: { action: "booking.editFinancialReview.chargeShareUncollected", targetId: BOOKING_ID },
        orderBy: { createdAt: "asc" },
        select: { metadata: true },
      });
      return rows.map((row) => (row.metadata as { derivedTotalCents: number }).derivedTotalCents);
    }

    async function markRequestPaid() {
      await prisma.paymentTransaction.update({
        where: { stripePaymentIntentId: REQUEST_INTENT_ID },
        data: { status: "SUCCEEDED" },
      });
    }

    /**
     * #3402 delta F3(a): a share that defers while the holder finds the request
     * PAID is traced ONCE - by the replay of the row its deferral armed. The
     * holder used to look again after releasing and trace it too, and each
     * record tells an officer to collect the difference by hand.
     */
    it("a share deferred while the holder finds the request PAID is traced exactly once, by the replay", async () => {
      await settleShare(5_000);
      await seedRequestAt(5_000);
      await markRequestPaid();
      // The edit's recovery row, closed by an earlier replay. (It also keeps D's
      // deferral off an INSERT, whose foreign-key check would queue behind the
      // table lock below.)
      await prisma.paymentRecoveryOperation.create({
        data: {
          type: "CREATE_ADDITIONAL_PAYMENT_INTENT",
          status: "SUCCEEDED",
          bookingId: BOOKING_ID,
          paymentId: PAYMENT_ID,
          paymentIntentId: buildRecoveryStripeKey(MODIFICATION_ID),
          amountCents: 5_000,
          hadIssuedXeroInvoice: false,
          idempotencyKey: buildRecoveryKey(MODIFICATION_ID),
          attempts: 1,
          nextRetryAt: null,
          succeededAt: new Date(),
        },
      });
      await settleShare(1_000); // Officer A's share: the shares total $60.

      // Park run A INSIDE its claimed pass: its read of the request waits on a
      // table lock a third connection holds.
      const holderReady = deferred<number>();
      const releaseHolder = deferred();
      const holder = lockHolderClient.$transaction(
        async (tx) => {
          await tx.$executeRaw`LOCK TABLE "PaymentTransaction" IN ACCESS EXCLUSIVE MODE`;
          const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
          holderReady.resolve(pid);
          await releaseHolder.promise;
        },
        { maxWait: 5_000, timeout: 15_000 },
      );
      const holderPid = await holderReady.promise;
      const runA = sync();
      const startedAt = process.hrtime.bigint();
      let parked = 0;
      while (realElapsedMs(startedAt) < LOCK_POLL_TIMEOUT_MS) {
        parked = await blockedByHolder(holderPid);
        if (parked >= 1) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      // Officer D's share commits while A holds the claim: D defers.
      let resultD: Awaited<ReturnType<typeof sync>> | null = null;
      try {
        await settleShare(4_000);
        resultD = await sync();
      } finally {
        releaseHolder.resolve();
        await holder;
      }
      const resultA = await runA;
      expect(parked, "run A must be parked inside its claimed pass").toBeGreaterThanOrEqual(1);
      expect(resultD?.outcome).toBe("deferred");
      expect(resultA.outcome).toBe("already-paid");
      // A traced the $60 it read; it did NOT also trace D's $100.
      expect(await uncollectedTotals()).toEqual([6_000]);

      // D's armed row replays and traces the $100 - the one record of it.
      const row = await prisma.paymentRecoveryOperation.findUniqueOrThrow({
        where: { idempotencyKey: buildRecoveryKey(MODIFICATION_ID) },
      });
      await expect(
        recoveryModule.runPaymentRecoveryOperationNow(row.id, CLUB_FORMAT_TEST),
      ).resolves.toBe("succeeded");
      expect(await uncollectedTotals()).toEqual([6_000, 10_000]);
    });

    it("a replay that finds the request PAID at a figure covering every share writes NO audit row", async () => {
      await settleShare(5_000);
      await settleShare(5_000);
      await seedRequestAt(10_000);
      await markRequestPaid();
      // The row a deferral re-armed, due now.
      const armed = await prisma.paymentRecoveryOperation.create({
        data: {
          type: "CREATE_ADDITIONAL_PAYMENT_INTENT",
          status: "PENDING",
          bookingId: BOOKING_ID,
          paymentId: PAYMENT_ID,
          paymentIntentId: buildRecoveryStripeKey(MODIFICATION_ID),
          amountCents: 10_000,
          hadIssuedXeroInvoice: false,
          idempotencyKey: buildRecoveryKey(MODIFICATION_ID),
          nextRetryAt: new Date(),
        },
      });

      await expect(
        recoveryModule.runPaymentRecoveryOperationNow(armed.id, CLUB_FORMAT_TEST),
      ).resolves.toBe("succeeded");
      expect(await uncollectedTotals()).toEqual([]);
    });

    /**
     * #3402 delta F4: the raised-amount write touches only a live ADDITIONAL row.
     * A declined card's FAILED row is raised and KEEPS FAILED (the ledger's
     * still-owed shape); a row an officer withdrew in the window is not raised,
     * and the run defers rather than reporting the request paid.
     */
    it("a FAILED (declined) request is raised and stays FAILED; a request WITHDRAWN mid-raise is not written and the run defers", async () => {
      await settleShare(5_000);
      await seedRequestAt(5_000);
      await prisma.paymentTransaction.update({
        where: { stripePaymentIntentId: REQUEST_INTENT_ID },
        data: { status: "FAILED" },
      });
      await settleShare(2_000);
      stripeHooks.get = async (id) => ({
        id,
        status: "requires_payment_method",
        currency: stripeChargeCurrency(CLUB_FORMAT_TEST),
        amount: 5_000,
      });
      stripeHooks.update = async (id, amountCents) => ({ id, amount: amountCents });

      await expect(sync()).resolves.toMatchObject({ outcome: "raised", totalCents: 7_000 });
      expect(
        await prisma.paymentTransaction.findUniqueOrThrow({
          where: { stripePaymentIntentId: REQUEST_INTENT_ID },
          select: { status: true, amountCents: true },
        }),
      ).toEqual({ status: "FAILED", amountCents: 7_000 });

      // Another share; an officer withdraws the request as Stripe accepts it.
      await settleShare(3_000);
      stripeHooks.update = async (id, amountCents) => {
        await prisma.paymentTransaction.update({
          where: { stripePaymentIntentId: REQUEST_INTENT_ID },
          data: { withdrawnAt: new Date() },
        });
        return { id, amount: amountCents };
      };
      await expect(sync()).resolves.toMatchObject({ outcome: "deferred", paymentIntentId: null });
      expect(
        (
          await prisma.paymentTransaction.findUniqueOrThrow({
            where: { stripePaymentIntentId: REQUEST_INTENT_ID },
            select: { amountCents: true },
          })
        ).amountCents,
      ).toBe(7_000);
      expect(
        await prisma.paymentRecoveryOperation.count({
          where: { idempotencyKey: buildRecoveryKey(MODIFICATION_ID), status: "PENDING" },
        }),
      ).toBe(1);
    });

    it("the database refuses a token without its claim time, and a non-positive intent", async () => {
      await expect(
        prisma.editReviewChargeRaiseClaim.create({
          data: { bookingModificationId: MODIFICATION_ID, claimToken: "orphan" },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.editReviewChargeRaiseClaim.create({
          data: { bookingModificationId: MODIFICATION_ID, intendedAmountCents: 0 },
        }),
      ).rejects.toThrow();
    });
  },
);
