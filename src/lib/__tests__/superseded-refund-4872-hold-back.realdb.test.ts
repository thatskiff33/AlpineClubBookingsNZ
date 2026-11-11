/**
 * Real-PostgreSQL proof of #4872 (`INV-PAY-150`): the refund doors besides a
 * cancellation leave a live superseded capture to the refund that returns it.
 *
 * A superseded intent's refund with no stored plan (R) sizes its one request on
 * its charge's ledger. Each door below used to plan newest-charge-first over
 * that same headroom, so it could take part of R's charge and R then closed
 * short. Run here through the real door, then the real
 * `runPaymentRecoveryOperationNow` on R.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so CI reaches it; it owns and cleans its own
 * `race-4872-` fixtures. Stripe is the harness's one shared double, refusing
 * any refund larger than what the charge still holds.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { releaseBookingFinancialHistoryForTeardown } from "./support/booking-financial-history-teardown";
import { assertSafeRaceDbUrl } from "./support/race-db-url";
import { resetStripeRaceHooks, stripeRaceHooks } from "./support/stripe-race-double";

/** The one shared double: the LAST file to register a factory wins, so every realdb file registers this same one. */
vi.mock("@/lib/stripe", async (importOriginal) =>
  (await import("./support/stripe-race-double")).stripeRaceDouble(await importOriginal()),
);

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const MEMBER_ID = "race-4872-member";
const LODGE_ID = "race-4872-lodge";
const BOOKING_ID = "race-4872-booking";
const PAYMENT_ID = "race-4872-payment";
const PRIMARY_TXN = "race-4872-txn-primary";
const SUPERSEDED_TXN = "race-4872-txn-superseded";
const BANK_TXN = "race-4872-txn-bank";
const PRIMARY_INTENT = "pi_race_4872_primary";
const SUPERSEDED_INTENT = "pi_race_4872_superseded";
const MOD_ID = "race-4872-mod";
const REQUEST_ID = "race-4872-request";
const CHECK_IN = new Date("2026-08-01T00:00:00.000Z");
const NIGHT_2 = new Date("2026-08-02T00:00:00.000Z");
const CHECK_OUT = new Date("2026-08-03T00:00:00.000Z");
const PRIMARY_CENTS = 13_000;
const SUPERSEDED_CENTS = 6_500;
const SLICE_CENTS = 4_000;
const BANK_CENTS = 1_000;
const LOCK_POLL_TIMEOUT_MS = 5_000;

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let runPaymentRecoveryOperationNow: (typeof import("@/lib/payment-recovery"))["runPaymentRecoveryOperationNow"];
let reconcilePaymentAggregates: (typeof import("@/lib/payment-transactions"))["reconcilePaymentAggregates"];
let lockPaymentForRefundedTotal: (typeof import("@/lib/payment-transactions"))["lockPaymentForRefundedTotal"];
let keys: typeof import("@/lib/payment-recovery-keys");
let recoveryAlert: typeof import("@/lib/payment-recovery-alert");
let CLUB_FORMAT_TEST: (typeof import("@/lib/__tests__/support/club-format-fixture"))["CLUB_FORMAT_TEST"];
let realElapsedMs: (typeof import("@/lib/__tests__/helpers/clock"))["realElapsedMs"];
let lockHolderClient: import("@prisma/client").PrismaClient;
let observerClient: import("@prisma/client").PrismaClient;
let harnessRole: { restore: () => void } | undefined;

(RUN ? describe : describe.skip)(
  "other refund doors leave a live superseded capture to its own refund - real PostgreSQL (#4872)",
  { timeout: 60_000 },
  () => {
    let alertSpy: MockInstance<(typeof import("@/lib/payment-recovery-alert"))["alertPaymentRecoveryOfficers"]>;
    let made: Array<{ paymentIntentId: string; amountCents: number; idempotencyKey: string | null }> = [];

    async function deleteBookingRows() {
      await prisma.emailLog.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.alertCooldown.deleteMany({ where: { key: { contains: BOOKING_ID } } });
      const operations = await prisma.paymentRecoveryOperation.findMany({ where: { bookingId: BOOKING_ID }, select: { id: true } });
      await prisma.auditLog.deleteMany({
        where: {
          OR: [
            { targetId: { in: [BOOKING_ID, PAYMENT_ID, REQUEST_ID] } },
            { entityId: { in: [BOOKING_ID, PAYMENT_ID, REQUEST_ID, MOD_ID, ...operations.map((row) => row.id)] } },
          ],
        },
      });
      await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: [BOOKING_ID, PAYMENT_ID] } } });
      await prisma.xeroObjectLink.deleteMany({ where: { localId: { in: [BOOKING_ID, PAYMENT_ID] } } });
      await releaseBookingFinancialHistoryForTeardown(prisma, [BOOKING_ID]);
      await prisma.memberCredit.deleteMany({ where: { memberId: MEMBER_ID } });
      await prisma.manualRefundTask.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.refundRequest.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.paymentRecoveryOperation.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.paymentRefund.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.payment.updateMany({ where: { id: PAYMENT_ID }, data: { settledByTransactionId: null } });
      await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
      await prisma.bookingModification.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.bookingGuest.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
    }

    async function deleteFixtures() {
      await deleteBookingRows();
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
    }

    async function seed(options: {
      /** "refund": captured, R live with no plan. "handing-off": not yet captured, its cancel row live. "none": no superseded charge. */
      superseded?: "refund" | "handing-off" | "none";
      /** The booking is waiting on the primary capture, at a lodge with no beds. */
      capacity?: boolean;
      /** Captured non-card charge the check part prefers before newest-first. */
      bank?: boolean;
      /** Already refunded on the primary charge's mirror, with no refund row. */
      primaryRefundedCents?: number;
      /** Payment holds only the superseded capture. */
      supersededOnly?: boolean;
    } = {}): Promise<string | null> {
      const superseded = options.superseded ?? "refund";
      const captured = superseded === "refund";
      const primaryCents = options.supersededOnly ? 0 : PRIMARY_CENTS;
      const priceCents = options.capacity || options.supersededOnly ? primaryCents || SUPERSEDED_CENTS : primaryCents;
      await prisma.booking.create({
        data: {
          id: BOOKING_ID, memberId: MEMBER_ID, lodgeId: LODGE_ID, checkIn: CHECK_IN, checkOut: CHECK_OUT,
          status: options.capacity ? "PAYMENT_PENDING" : "PAID",
          totalPriceCents: priceCents, finalPriceCents: priceCents,
        },
      });
      if (options.capacity) {
        for (const id of ["race-4872-g1", "race-4872-g2"]) {
          await prisma.bookingGuest.create({
            data: {
              id, bookingId: BOOKING_ID, firstName: "Race", lastName: id, ageTier: "ADULT", isMember: true,
              stayStart: CHECK_IN, stayEnd: CHECK_OUT, priceCents: Math.floor(priceCents / 2),
              nights: { create: [{ stayDate: CHECK_IN, priceCents: 1, priceSource: "SOLD" }, { stayDate: NIGHT_2, priceCents: 1, priceSource: "SOLD" }] },
            },
          });
        }
      }
      await prisma.payment.create({
        data: {
          id: PAYMENT_ID, bookingId: BOOKING_ID,
          amountCents: primaryCents + (captured ? SUPERSEDED_CENTS : 0) + (options.bank ? BANK_CENTS : 0),
          source: "STRIPE", status: options.capacity ? "PENDING" : "SUCCEEDED",
          stripePaymentIntentId: primaryCents > 0 ? PRIMARY_INTENT : SUPERSEDED_INTENT,
        },
      });
      if (options.bank) {
        await prisma.paymentTransaction.create({
          data: { id: BANK_TXN, paymentId: PAYMENT_ID, kind: "ADDITIONAL", source: "INTERNET_BANKING", amountCents: BANK_CENTS, status: "SUCCEEDED", createdAt: new Date("2026-04-01T00:00:00.000Z") },
        });
      }
      if (primaryCents > 0) {
        await prisma.paymentTransaction.create({
          data: {
            id: PRIMARY_TXN, paymentId: PAYMENT_ID, kind: "PRIMARY", source: "STRIPE", stripePaymentIntentId: PRIMARY_INTENT,
            amountCents: PRIMARY_CENTS, refundedAmountCents: options.primaryRefundedCents ?? 0, status: "SUCCEEDED",
            createdAt: new Date("2026-05-01T00:00:00.000Z"),
          },
        });
      }
      if (superseded === "none") return null;
      await prisma.paymentTransaction.create({
        data: {
          id: SUPERSEDED_TXN, paymentId: PAYMENT_ID, kind: primaryCents > 0 ? "ADDITIONAL" : "PRIMARY", source: "STRIPE",
          stripePaymentIntentId: SUPERSEDED_INTENT, amountCents: SUPERSEDED_CENTS, status: captured ? "SUCCEEDED" : "PENDING",
          createdAt: new Date("2026-06-01T00:00:00.000Z"),
        },
      });
      const row = await prisma.paymentRecoveryOperation.create({
        data: captured
          ? {
              type: "REFUND_SUPERSEDED_PAYMENT", status: "PENDING", bookingId: BOOKING_ID, paymentId: PAYMENT_ID,
              paymentTransactionId: SUPERSEDED_TXN, paymentIntentId: SUPERSEDED_INTENT, amountCents: SUPERSEDED_CENTS,
              idempotencyKey: keys.buildSupersededPaymentRefundRecoveryIdempotencyKey(SUPERSEDED_TXN, SUPERSEDED_INTENT),
              nextRetryAt: new Date(0), createdAt: new Date("2026-06-15T00:00:00.000Z"),
            }
          : {
              type: "CANCEL_PAYMENT_INTENT", status: "PENDING", bookingId: BOOKING_ID, paymentId: PAYMENT_ID,
              paymentTransactionId: SUPERSEDED_TXN, paymentIntentId: SUPERSEDED_INTENT, amountCents: SUPERSEDED_CENTS,
              idempotencyKey: `race-4872-cancel-${SUPERSEDED_INTENT}`, nextRetryAt: new Date(0),
              createdAt: new Date("2026-06-15T00:00:00.000Z"),
            },
      });
      return row.id;
    }

    async function modification() {
      await prisma.bookingModification.create({
        data: { id: MOD_ID, bookingId: BOOKING_ID, memberId: MEMBER_ID, modificationType: "DATE_CHANGE", previousData: {}, newData: {}, priceDiffCents: -SLICE_CENTS },
      });
    }

    const refunded = (id: string) => prisma.paymentTransaction.findUniqueOrThrow({ where: { id }, select: { refundedAmountCents: true } }).then((row) => row.refundedAmountCents);
    const madeOn = (paymentIntentId: string) => made.filter((refund) => refund.paymentIntentId === paymentIntentId).reduce((sum, refund) => sum + refund.amountCents, 0);

    async function editRefund(cents = SLICE_CENTS) {
      const { executeBookingModificationRefund } = await import("@/lib/booking-modification-settlement");
      return executeBookingModificationRefund({
        format: CLUB_FORMAT_TEST, bookingId: BOOKING_ID,
        result: { pendingRefundAmountCents: cents, paymentId: PAYMENT_ID, bookingModificationId: MOD_ID, organiserChildRefund: null } as never,
        idempotencyKeyPrefix: `mod_dates_refund_${BOOKING_ID}`, failureMessage: "race-4872 edit refund failed", recoveryFailureMessage: "race-4872 edit enqueue failed",
      });
    }

    async function approve(cents: number) {
      const guards = await import("@/lib/session-guards");
      const formatServer = await import("@/lib/club-format-server");
      const { bindClubFormat } = await import("@/lib/club-format-bound");
      const xero = await import("@/lib/xero");
      const guard = vi.spyOn(guards, "requireAdmin").mockResolvedValue({ ok: true, session: { user: { id: MEMBER_ID } } } as never);
      const format = vi.spyOn(formatServer, "clubFormat").mockResolvedValue(bindClubFormat(CLUB_FORMAT_TEST));
      const connected = vi.spyOn(xero, "isXeroConnected").mockResolvedValue(false);
      try {
        const { PUT } = await import("@/app/api/admin/refund-requests/[id]/route");
        const { NextRequest } = await import("next/server");
        const response = await PUT(
          new NextRequest(`http://localhost/api/admin/refund-requests/${REQUEST_ID}`, {
            method: "PUT", headers: { "Content-Type": "application/json", "x-forwarded-for": "127.0.0.1" },
            body: JSON.stringify({ status: "APPROVED", approvedAmountCents: cents, notifyMember: false }),
          }),
          { params: Promise.resolve({ id: REQUEST_ID }) },
        );
        return { status: response.status, body: await response.json().catch(() => null) };
      } finally {
        guard.mockRestore();
        format.mockRestore();
        connected.mockRestore();
      }
    }

    async function capacityRace() {
      const { markBookingPaymentSucceeded } = await import("@/lib/payment-reconciliation");
      return markBookingPaymentSucceeded({ bookingId: BOOKING_ID, paymentIntentId: PRIMARY_INTENT, amountCents: PRIMARY_CENTS, paymentMethodId: null, format: CLUB_FORMAT_TEST });
    }

    async function credit() {
      await modification();
      const { createBookingModificationCredit } = await import("@/lib/member-credit");
      await createBookingModificationCredit(MEMBER_ID, SLICE_CENTS, BOOKING_ID, MOD_ID, undefined, undefined, PAYMENT_ID);
    }

    async function planlessRecovery(plan: unknown = null) {
      return prisma.paymentRecoveryOperation.create({
        data: {
          type: "REFUND_BOOKING_MODIFICATION", status: "PENDING", bookingId: BOOKING_ID, paymentId: PAYMENT_ID,
          paymentIntentId: PRIMARY_INTENT, amountCents: SLICE_CENTS, allocationPlan: plan === null ? undefined : plan,
          idempotencyKey: `race-4872-mod-refund-${plan === null ? "open" : "stored"}`,
          stripeKeyPrefix: `race_4872_mod_${BOOKING_ID}`, nextRetryAt: new Date(0),
        },
      });
    }

    async function handBack(part: "plain" | "check") {
      const occurrenceKey = part === "check" ? `cancel-card-shortfall:${BOOKING_ID}:check` : "race-4872-hand-back";
      const task = await prisma.manualRefundTask.create({
        data: {
          bookingId: BOOKING_ID, paymentId: PAYMENT_ID, kind: "CANCELLED_BOOKING_HAND_BACK",
          amountCents: part === "check" && (await prisma.paymentTransaction.count({ where: { id: BANK_TXN } })) > 0 ? SLICE_CENTS : SLICE_CENTS,
          raisedAmountCents: SLICE_CENTS, reason: "race-4872 hand-back", occurrenceKey,
        },
      });
      const { resolveManualRefundTask } = await import("@/lib/manual-refund-task-resolution");
      await resolveManualRefundTask(
        { taskId: task.id, resolution: "completed", note: null, actingMemberId: MEMBER_ID, confirmedAmountCents: null, direction: "REFUND_TO_MEMBER", recordedNightPrices: null },
        CLUB_FORMAT_TEST,
      );
      return task.id;
    }

    async function returnCapture(rowId: string) {
      expect(await refunded(SUPERSEDED_TXN)).toBe(0);
      expect(madeOn(SUPERSEDED_INTENT)).toBe(0);
      expect(await runPaymentRecoveryOperationNow(rowId, CLUB_FORMAT_TEST)).toBe("succeeded");
      expect(madeOn(SUPERSEDED_INTENT)).toBe(SUPERSEDED_CENTS);
      expect(await refunded(SUPERSEDED_TXN)).toBe(SUPERSEDED_CENTS);
    }

    async function waitForBlockedBy(blockerPid: number) {
      const startedAt = process.hrtime.bigint();
      while (realElapsedMs(startedAt) < LOCK_POLL_TIMEOUT_MS) {
        const rows = await observerClient.$queryRaw<Array<{ count: number }>>`
          SELECT COUNT(*)::int AS "count" FROM pg_stat_activity
          WHERE datname = current_database() AND ${blockerPid}::int = ANY(pg_blocking_pids(pid))
        `;
        if ((rows[0]?.count ?? 0) >= 1) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Timed out waiting for a transaction to queue behind pid ${blockerPid}.`);
    }

    async function holdOpen(inside: (tx: Parameters<Parameters<typeof lockHolderClient.$transaction>[0]>[0]) => Promise<void>) {
      let release!: () => void;
      const released = new Promise<void>((resolve) => { release = resolve; });
      let ready!: (pid: number) => void;
      const started = new Promise<number>((resolve) => { ready = resolve; });
      const done = lockHolderClient.$transaction(async (tx) => {
        const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
        await inside(tx);
        ready(pid);
        await released;
      }, { timeout: 20_000 });
      return { pid: await started, release, done };
    }

    /** The hand-off holds the Payment row with the charge flipped captured and its cancel row still in flight. */
    async function behindHandoff(door: () => Promise<unknown>) {
      const holder = await holdOpen(async (tx) => {
        await lockPaymentForRefundedTotal(tx, PAYMENT_ID);
        await tx.paymentRecoveryOperation.updateMany({
          where: { bookingId: BOOKING_ID, type: "CANCEL_PAYMENT_INTENT" },
          data: { status: "PROCESSING", processingStartedAt: new Date() },
        });
        await tx.paymentTransaction.update({ where: { id: SUPERSEDED_TXN }, data: { status: "SUCCEEDED" } });
        await reconcilePaymentAggregates({ paymentId: PAYMENT_ID, store: tx });
      });
      const pending = door();
      await waitForBlockedBy(holder.pid);
      holder.release();
      await holder.done;
      await pending;
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "#4872 superseded capture at the other refund doors");
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      const { declareEnvironmentRoleForSuite } = await import("./helpers/environment-role");
      harnessRole = declareEnvironmentRoleForSuite("non-production");
      ({ runPaymentRecoveryOperationNow } = await import("@/lib/payment-recovery"));
      ({ reconcilePaymentAggregates, lockPaymentForRefundedTotal } = await import("@/lib/payment-transactions"));
      keys = await import("@/lib/payment-recovery-keys");
      recoveryAlert = await import("@/lib/payment-recovery-alert");
      ({ CLUB_FORMAT_TEST } = await import("@/lib/__tests__/support/club-format-fixture"));
      ({ realElapsedMs } = await import("@/lib/__tests__/helpers/clock"));
      const [{ PrismaClient: SeparatePrismaClient }, { createPrismaPgAdapter }] = await Promise.all([
        import("@prisma/client"), import("@/lib/prisma-adapter"),
      ]);
      const separate = (applicationName: string) => {
        const url = new URL(RACE_DB_URL);
        url.searchParams.set("connection_limit", "1");
        url.searchParams.set("application_name", applicationName);
        return new SeparatePrismaClient({ adapter: createPrismaPgAdapter(url.toString()) });
      };
      lockHolderClient = separate("race-4872-holder");
      observerClient = separate("race-4872-observer");
      await Promise.all([lockHolderClient.$connect(), observerClient.$connect()]);
      await deleteFixtures();
      await prisma.member.create({ data: { id: MEMBER_ID, email: `${MEMBER_ID}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Ada", lastName: "Proof", ageTier: "ADULT" } });
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4872 Lodge", slug: "race-4872" } });
    }, 60_000);

    beforeEach(async () => {
      await deleteBookingRows();
      resetStripeRaceHooks();
      alertSpy = vi.spyOn(recoveryAlert, "alertPaymentRecoveryOfficers").mockResolvedValue(null);
      made = [];
      const capturedByIntent = new Map([[PRIMARY_INTENT, PRIMARY_CENTS], [SUPERSEDED_INTENT, SUPERSEDED_CENTS]]);
      stripeRaceHooks.refund = async (args) => {
        const left = (capturedByIntent.get(args.paymentIntentId) ?? 0) - madeOn(args.paymentIntentId);
        if (args.amountCents > left) throw new Error(`Refund amount (${args.amountCents}) is greater than unrefunded amount on charge (${left})`);
        made.push({ paymentIntentId: args.paymentIntentId, amountCents: args.amountCents, idempotencyKey: args.idempotencyKey ?? null });
        return {
          id: `re_race_4872_${made.length}`, object: "refund", amount: args.amountCents, currency: "nzd", status: "succeeded",
          reason: "requested_by_customer", created: 4_070_908_800, charge: `ch_${args.paymentIntentId}`,
          payment_intent: args.paymentIntentId, metadata: args.metadata ?? {},
        };
      };
    });

    afterEach(() => {
      alertSpy.mockRestore();
      resetStripeRaceHooks();
    });

    afterAll(async () => {
      try {
        resetStripeRaceHooks();
        await Promise.all([lockHolderClient, observerClient].map((client) => (client ? client.$disconnect().catch(() => {}) : Promise.resolve())));
        if (typeof prisma !== "undefined") await deleteFixtures();
      } finally {
        harnessRole?.restore();
      }
    });

    it("an edit's own-card refund takes the booking's charge, and R returns the whole capture", async () => {
      const supersededRefund = await seed();
      await modification();
      expect(await editRefund()).toMatchObject({ refundDestination: "own" });
      expect(await refunded(PRIMARY_TXN)).toBe(SLICE_CENTS);
      expect(made.map((refund) => refund.paymentIntentId)).toEqual([PRIMARY_INTENT]);
      await returnCapture(supersededRefund!);
      expect(madeOn(PRIMARY_INTENT) + madeOn(SUPERSEDED_INTENT)).toBe(SLICE_CENTS + SUPERSEDED_CENTS);
    });

    it("an edit with only the superseded capture left keeps the whole debt and does not spend it", async () => {
      const supersededRefund = await seed({ supersededOnly: true });
      await modification();
      expect(await editRefund()).toMatchObject({ refundDestination: "own_card_pending" });
      expect(made).toEqual([]);
      const owed = await prisma.paymentRecoveryOperation.findFirstOrThrow({
        where: { bookingId: BOOKING_ID, type: "REFUND_BOOKING_MODIFICATION" },
        select: { amountCents: true, allocationPlan: true, status: true },
      });
      expect(owed).toMatchObject({ amountCents: SLICE_CENTS, status: "PENDING" });
      expect(owed.allocationPlan ?? null).toBeNull();
      await returnCapture(supersededRefund!);
    });

    it("an approved refund request plans off the booking's charge, and R returns the whole capture", async () => {
      const supersededRefund = await seed();
      await prisma.refundRequest.create({ data: { id: REQUEST_ID, bookingId: BOOKING_ID, memberId: MEMBER_ID, reason: "race-4872", requestedAmountCents: SLICE_CENTS } });
      expect(await approve(SLICE_CENTS)).toMatchObject({ status: 200 });
      expect(await refunded(PRIMARY_TXN)).toBe(SLICE_CENTS);
      expect(madeOn(SUPERSEDED_INTENT)).toBe(0);
      await returnCapture(supersededRefund!);
    });

    it("an approval is refused unchanged when only the superseded capture would pay it", async () => {
      const supersededRefund = await seed({ supersededOnly: true });
      await prisma.refundRequest.create({ data: { id: REQUEST_ID, bookingId: BOOKING_ID, memberId: MEMBER_ID, reason: "race-4872", requestedAmountCents: SLICE_CENTS } });
      const response = await approve(SLICE_CENTS);
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ error: expect.stringContaining("$0.00") });
      expect(made).toEqual([]);
      expect(await prisma.refundRequest.findUniqueOrThrow({ where: { id: REQUEST_ID }, select: { status: true } })).toEqual({ status: "PENDING" });
      await returnCapture(supersededRefund!);
    });

    it("a capacity race refunds the capture that just arrived, not the superseded one, and R returns the whole of that", async () => {
      const supersededRefund = await seed({ capacity: true });
      expect(await capacityRace()).toMatchObject({ outcome: "cancelled_refunded" });
      const plan = await prisma.paymentRecoveryOperation.findFirstOrThrow({
        where: { bookingId: BOOKING_ID, type: "REFUND_BOOKING_MODIFICATION" }, select: { allocationPlan: true },
      });
      expect(plan.allocationPlan).toEqual([expect.objectContaining({ paymentTransactionId: PRIMARY_TXN, amountCents: PRIMARY_CENTS })]);
      expect(madeOn(SUPERSEDED_INTENT)).toBe(0);
      await returnCapture(supersededRefund!);
      expect(madeOn(PRIMARY_INTENT)).toBe(PRIMARY_CENTS);
    });

    it("a capacity race whose own charge cannot carry the refund still raises the shortfall task and leaves the capture", async () => {
      const supersededRefund = await seed({ capacity: true, primaryRefundedCents: SLICE_CENTS });
      const settled = await capacityRace();
      expect(settled.outcome === "cancelled_refunded" || settled.outcome === "cancelled_refund_failed").toBe(true);
      const plan = await prisma.paymentRecoveryOperation.findFirstOrThrow({
        where: { bookingId: BOOKING_ID, type: "REFUND_BOOKING_MODIFICATION" }, select: { allocationPlan: true, amountCents: true },
      });
      expect(plan.amountCents).toBe(PRIMARY_CENTS - SLICE_CENTS);
      expect(JSON.stringify(plan.allocationPlan)).not.toContain(SUPERSEDED_TXN);
      const task = await prisma.manualRefundTask.findFirstOrThrow({ where: { bookingId: BOOKING_ID, occurrenceKey: { contains: ":check" } } });
      expect(task.amountCents).toBe(SLICE_CENTS);
      expect(await refunded(SUPERSEDED_TXN)).toBe(0);
      await returnCapture(supersededRefund!);
    });

    it("a booking-change credit is allocated to the booking's charge, and R returns the whole capture", async () => {
      const supersededRefund = await seed();
      await credit();
      expect(await refunded(PRIMARY_TXN)).toBe(SLICE_CENTS);
      expect(await refunded(SUPERSEDED_TXN)).toBe(0);
      expect(await prisma.memberCredit.findFirstOrThrow({ where: { sourceBookingModificationId: MOD_ID }, select: { amountCents: true } })).toEqual({ amountCents: SLICE_CENTS });
      await returnCapture(supersededRefund!);
    });

    it("a plan-less modification refund derives its plan off the capture, and R returns the whole of it", async () => {
      const supersededRefund = await seed();
      const row = await planlessRecovery();
      expect(await runPaymentRecoveryOperationNow(row.id, CLUB_FORMAT_TEST)).toBe("succeeded");
      const stored = await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { id: row.id }, select: { allocationPlan: true } });
      expect(stored.allocationPlan).toEqual([expect.objectContaining({ paymentTransactionId: PRIMARY_TXN, amountCents: SLICE_CENTS })]);
      expect(madeOn(SUPERSEDED_INTENT)).toBe(0);
      await returnCapture(supersededRefund!);
    });

    it("a stored plan is replayed as stored, even when the hold-back would have chosen another charge", async () => {
      const supersededRefund = await seed();
      const row = await planlessRecovery([{ paymentTransactionId: PRIMARY_TXN, amountCents: SLICE_CENTS }]);
      expect(await runPaymentRecoveryOperationNow(row.id, CLUB_FORMAT_TEST)).toBe("succeeded");
      expect(made.map((refund) => refund.idempotencyKey)).toEqual([expect.stringContaining(`${PRIMARY_TXN}_${SLICE_CENTS}`)]);
      const stored = await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { id: row.id }, select: { allocationPlan: true } });
      expect(JSON.stringify(stored.allocationPlan)).toContain(PRIMARY_TXN);
      expect(JSON.stringify(stored.allocationPlan)).not.toContain(SUPERSEDED_TXN);
      await returnCapture(supersededRefund!);
    });

    it("a plain hand-back allocates the booking's charge, and R returns the whole capture", async () => {
      const supersededRefund = await seed();
      await handBack("plain");
      expect(await refunded(PRIMARY_TXN)).toBe(SLICE_CENTS);
      expect(await refunded(SUPERSEDED_TXN)).toBe(0);
      await returnCapture(supersededRefund!);
    });

    it("a card-shortfall check spends its preferred non-card charge, then the booking's card, and R returns the capture", async () => {
      const supersededRefund = await seed({ bank: true });
      await handBack("check");
      expect(await refunded(BANK_TXN)).toBe(BANK_CENTS);
      expect(await refunded(PRIMARY_TXN)).toBe(SLICE_CENTS - BANK_CENTS);
      expect(await refunded(SUPERSEDED_TXN)).toBe(0);
      await returnCapture(supersededRefund!);
    });

    it("the edit waits out the hand-off and then leaves the capture alone", async () => {
      await seed({ superseded: "handing-off" });
      await modification();
      await behindHandoff(() => editRefund());
      expect(await refunded(SUPERSEDED_TXN)).toBe(0);
      expect(await refunded(PRIMARY_TXN)).toBe(SLICE_CENTS);
      expect(madeOn(SUPERSEDED_INTENT)).toBe(0);
    });

    it("an approval waits out the hand-off and then leaves the capture alone", async () => {
      await seed({ superseded: "handing-off" });
      await prisma.refundRequest.create({ data: { id: REQUEST_ID, bookingId: BOOKING_ID, memberId: MEMBER_ID, reason: "race-4872", requestedAmountCents: SLICE_CENTS } });
      await behindHandoff(() => approve(SLICE_CENTS));
      expect(await refunded(SUPERSEDED_TXN)).toBe(0);
      expect(madeOn(SUPERSEDED_INTENT)).toBe(0);
      expect(madeOn(PRIMARY_INTENT)).toBe(SLICE_CENTS);
    });

    it("a capacity race waits out the hand-off and then leaves the capture alone", async () => {
      await seed({ superseded: "handing-off", capacity: true });
      await behindHandoff(() => capacityRace());
      const plan = await prisma.paymentRecoveryOperation.findFirst({
        where: { bookingId: BOOKING_ID, type: "REFUND_BOOKING_MODIFICATION" }, select: { allocationPlan: true },
      });
      expect(JSON.stringify(plan?.allocationPlan ?? [])).not.toContain(SUPERSEDED_TXN);
      expect(await refunded(SUPERSEDED_TXN)).toBe(0);
      expect(madeOn(SUPERSEDED_INTENT)).toBe(0);
    });

    it("a booking-change credit waits out the hand-off and then leaves the capture alone", async () => {
      await seed({ superseded: "handing-off" });
      await behindHandoff(() => credit());
      expect(await refunded(SUPERSEDED_TXN)).toBe(0);
      expect(await refunded(PRIMARY_TXN)).toBe(SLICE_CENTS);
    });

    it("a plan-less recovery waits out the hand-off and then leaves the capture alone", async () => {
      await seed({ superseded: "handing-off" });
      const row = await planlessRecovery();
      await behindHandoff(() => runPaymentRecoveryOperationNow(row.id, CLUB_FORMAT_TEST));
      const stored = await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { id: row.id }, select: { allocationPlan: true } });
      expect(JSON.stringify(stored.allocationPlan)).not.toContain(SUPERSEDED_TXN);
      expect(await refunded(SUPERSEDED_TXN)).toBe(0);
    });

    it("a hand-back waits out the hand-off and then leaves the capture alone", async () => {
      await seed({ superseded: "handing-off" });
      await behindHandoff(() => handBack("plain"));
      expect(await refunded(SUPERSEDED_TXN)).toBe(0);
      expect(await refunded(PRIMARY_TXN)).toBe(SLICE_CENTS);
    });

    it("a card-shortfall check waits out the hand-off and then leaves the capture alone", async () => {
      await seed({ superseded: "handing-off" });
      await behindHandoff(() => handBack("check"));
      expect(await refunded(SUPERSEDED_TXN)).toBe(0);
      expect(await refunded(PRIMARY_TXN)).toBe(SLICE_CENTS);
    });
  },
);
