/**
 * Real-PostgreSQL proof of Stuck States' settlement of a dead refund out of the
 * group organiser's card (#4851, owner decision 10 Nov 2026; `INV-PAY-152`).
 *
 * Driven through the real close (`closeGroupCardRefundPaidAnotherWay`), the real
 * re-arm (`tryOrganiserChildCardRefundAgain`), the shared lock and claim
 * (`lockDeadCardRefundRow`, `deadRowClaimWhere`), the executor's record step and
 * the real mirrors, against the migrated schema. Stripe is the harness's one
 * shared double; nothing reaches a live provider.
 *
 * - PER-JOINER, STRIPE ALREADY HAS IT. A live refund under the row's key is
 *   recorded (its `PaymentRefund`, the mirror) and nobody is paid again: no
 *   refund is sent and no bank hand-back is written.
 * - PER-JOINER, BANK. With no such refund the whole amount is a bank payment:
 *   the child's mirror, a COMPLETED `:no-xero-note` hand-back and its
 *   `BANK_REFUND` line, no `PaymentRefund`; the combined settlement is untouched.
 * - ONE ROW, ONE WINNER. A bank close and a re-arm of the same dead row, queued
 *   behind a held `lock(1)`: one commits, the other is refused and writes
 *   nothing.
 * - A RE-ARM'S FIRST ATTEMPT READS STRIPE. Re-armed (attempts 0), claimed by the
 *   runner (attempt 1), the executor finds the refund Stripe already holds under
 *   the key and records it without sending another.
 * - OLD WHOLE-GROUP. The plan's one unkeyed refund flips the settlement and
 *   raises every child's mirror; with no refund, the same flip and mirrors are
 *   recorded as a bank payment and officers are told to credit Xero by hand.
 *
 * The group, its settlement and bookings are seeded rows, as the #4368 suite
 * seeds its payment. A per-joiner debt is written by the real reservation
 * (`reserveOrganiserChildModificationRefund`) and then given up (attempts
 * spent). A pre-#3653 whole-group row cannot be written by today's code, so it
 * is seeded as such a row stood.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions, which
 * imports this file so CI reaches it; it owns and cleans its own `race-4851-`
 * fixtures.
 */
import type Stripe from "stripe";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { releaseBookingJournalForTeardown } from "./support/booking-financial-history-teardown";
import { assertSafeRaceDbUrl } from "./support/race-db-url";
import { resetStripeRaceHooks, stripeRaceHooks } from "./support/stripe-race-double";

/** The one shared double: the LAST file to register a factory wins, so every realdb file registers this same one. */
vi.mock("@/lib/stripe", async (importOriginal) =>
  (await import("./support/stripe-race-double")).stripeRaceDouble(await importOriginal()),
);

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const P = "race-4851";
const MEMBER_ID = `${P}-member`;
const OFFICER_ID = `${P}-officer`;
const LODGE_ID = `${P}-lodge`;
const CHECK_IN = new Date("2027-08-01T00:00:00.000Z");
const CHECK_OUT = new Date("2027-08-03T00:00:00.000Z");
const COMBINED_CENTS = 9_000;
const CHILD_CENTS = 4_500;
const REFUND_CENTS = 2_000;
const LOCK_POLL_TIMEOUT_MS = 5_000;

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let groupClose: typeof import("@/lib/card-refund-group-paid-another-way");
let groupTryAgain: typeof import("@/lib/card-refund-group-try-again");
let core: typeof import("@/lib/organiser-child-refund");
let executor: typeof import("@/lib/organiser-child-refund-executor");
let mirrorHandBack: typeof import("@/lib/group-settlement-mirror-hand-back");
let MAX_ATTEMPTS: number;
let PAID_ANOTHER_WAY_MARKER: string;
let legacyKey: (settlementId: string) => string;
let CLUB_FORMAT_TEST: (typeof import("@/lib/__tests__/support/club-format-fixture"))["CLUB_FORMAT_TEST"];
let realElapsedMs: (typeof import("@/lib/__tests__/helpers/clock"))["realElapsedMs"];
let lockHolderClient: import("@prisma/client").PrismaClient;
let observerClient: import("@prisma/client").PrismaClient;

/** One organiser-pays group settled by one combined card payment. Every id is the case's own. */
function groupIds(tag: string) {
  return {
    organiser: `${P}-${tag}-organiser`,
    organiserPayment: `${P}-${tag}-org-pay`,
    group: `${P}-${tag}-group`,
    settlement: `${P}-${tag}-settlement`,
    children: [`${P}-${tag}-child-1`, `${P}-${tag}-child-2`],
    payments: [`${P}-${tag}-pay-1`, `${P}-${tag}-pay-2`],
    intent: `pi_${P.replace("-", "_")}_${tag}`,
  };
}
type Group = ReturnType<typeof groupIds>;

function stripeRefund(input: { id: string; intent: string; amount: number; key?: string }): Stripe.Refund {
  return {
    id: input.id,
    object: "refund",
    amount: input.amount,
    currency: "nzd",
    status: "succeeded",
    reason: null,
    created: Math.floor(new Date("2026-06-30T00:00:00.000Z").getTime() / 1000),
    charge: `ch_${input.intent}`,
    payment_intent: input.intent,
    metadata: input.key ? { organiserChildRefundKey: input.key } : {},
  } as unknown as Stripe.Refund;
}

(RUN ? describe : describe.skip)(
  "a dead refund out of the group organiser's card, settled on Stuck States — real PostgreSQL (#4851)",
  { timeout: 60_000 },
  () => {
    let alertSpy: MockInstance<(typeof import("@/lib/group-settlement-mirror-hand-back"))["alertGroupMirrorRefundXeroByHand"]>;
    /** Every refund a door asked Stripe to make. None may be asked for here. */
    let sent: Array<{ idempotencyKey?: string; amountCents: number }> = [];
    /** What Stripe lists for each intent. */
    let listed: Map<string, Stripe.Refund[]>;

    async function deleteFixtures() {
      const bookings = await prisma.booking.findMany({ where: { id: { startsWith: P } }, select: { id: true } });
      const bookingIds = bookings.map((row) => row.id);
      const payments = await prisma.payment.findMany({ where: { id: { startsWith: P } }, select: { id: true } });
      const paymentIds = payments.map((row) => row.id);
      await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: [...paymentIds, ...bookingIds] } } });
      await prisma.bookingEvent.deleteMany({ where: { bookingId: { in: bookingIds } } });
      // #4627: the doors post journal batches bridged to these lines; release them first.
      await releaseBookingJournalForTeardown(prisma, bookingIds);
      await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: { in: bookingIds } } });
      await prisma.auditLog.deleteMany({ where: { targetId: { in: bookingIds } } });
      await prisma.manualRefundTask.deleteMany({ where: { bookingId: { in: bookingIds } } });
      await prisma.paymentRecoveryOperation.deleteMany({ where: { bookingId: { in: bookingIds } } });
      await prisma.paymentRefund.deleteMany({ where: { paymentId: { in: paymentIds } } });
      await prisma.paymentTransaction.deleteMany({ where: { paymentId: { in: paymentIds } } });
      await prisma.payment.deleteMany({ where: { id: { in: paymentIds } } });
      await prisma.groupBookingSettlement.deleteMany({ where: { id: { startsWith: P } } });
      await prisma.groupBooking.deleteMany({ where: { id: { startsWith: P } } });
      await prisma.booking.deleteMany({ where: { id: { in: bookingIds }, parentBookingId: { not: null } } });
      await prisma.booking.deleteMany({ where: { id: { in: bookingIds } } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: { in: [MEMBER_ID, OFFICER_ID] } } });
    }

    const bookingBase = {
      memberId: MEMBER_ID,
      lodgeId: LODGE_ID,
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      totalPriceCents: CHILD_CENTS,
      finalPriceCents: CHILD_CENTS,
    };

    /** The group, its combined card settlement, and two joiners the organiser paid for. */
    async function createGroup(group: Group, options: { childStatus: "PAID" | "CANCELLED"; refundPlan?: Record<string, number> }) {
      await prisma.booking.create({
        data: { ...bookingBase, id: group.organiser, status: "PAID", totalPriceCents: COMBINED_CENTS, finalPriceCents: COMBINED_CENTS },
      });
      await prisma.payment.create({
        data: { id: group.organiserPayment, bookingId: group.organiser, amountCents: COMBINED_CENTS, source: "STRIPE", status: "SUCCEEDED", stripePaymentIntentId: group.intent },
      });
      await prisma.groupBooking.create({
        data: { id: group.group, organiserBookingId: group.organiser, organiserMemberId: MEMBER_ID, joinCode: group.group, paymentMode: "ORGANISER_PAYS" },
      });
      await prisma.groupBookingSettlement.create({
        data: {
          id: group.settlement,
          groupBookingId: group.group,
          stripePaymentIntentId: group.intent,
          source: "STRIPE",
          amountCents: COMBINED_CENTS,
          status: "SUCCEEDED",
          ...(options.refundPlan ? { refundPlan: options.refundPlan } : {}),
        },
      });
      for (const [index, childId] of group.children.entries()) {
        await prisma.booking.create({
          data: { ...bookingBase, id: childId, status: options.childStatus, parentBookingId: group.organiser, organiserSettled: true },
        });
        await prisma.payment.create({
          data: { id: group.payments[index]!, bookingId: childId, amountCents: CHILD_CENTS, source: "STRIPE", status: "SUCCEEDED" },
        });
      }
    }

    /** A joiner's reduction refund, written by the real reservation, then given up with every attempt spent. */
    async function deadPerJoinerRow(group: Group) {
      const settlement = await prisma.groupBookingSettlement.findUniqueOrThrow({ where: { id: group.settlement } });
      const row = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
        const payment = await tx.payment.findUniqueOrThrow({ where: { id: group.payments[0]! } });
        return core.reserveOrganiserChildModificationRefund(tx, {
          plan: { settlement: { id: settlement.id, stripePaymentIntentId: group.intent, amountCents: settlement.amountCents }, amountCents: REFUND_CENTS },
          bookingId: group.children[0]!,
          payment,
          bookingModificationId: `${group.settlement}-modification`,
        });
      });
      if (!row) throw new Error("The reservation wrote no debt");
      return prisma.paymentRecoveryOperation.update({
        where: { id: row.id },
        data: { status: "FAILED", attempts: MAX_ATTEMPTS, nextRetryAt: null, lastError: "Stripe: card_declined" },
      });
    }

    /** A pre-#3653 whole-group refund row, as it stood: anchored on the organiser's payment, every attempt spent. */
    async function deadLegacyRow(group: Group, totalCents: number) {
      return prisma.paymentRecoveryOperation.create({
        data: {
          id: `${group.settlement}-op`,
          type: "REFUND_BOOKING_MODIFICATION",
          status: "FAILED",
          bookingId: group.organiser,
          paymentId: group.organiserPayment,
          paymentIntentId: group.intent,
          amountCents: totalCents,
          idempotencyKey: legacyKey(group.settlement),
          attempts: MAX_ATTEMPTS,
          nextRetryAt: null,
          lastError: "Stripe: card_declined",
        },
      });
    }

    const childPayment = (group: Group, index = 0) => prisma.payment.findUniqueOrThrow({ where: { id: group.payments[index]! } });
    const settlementNow = (group: Group) => prisma.groupBookingSettlement.findUniqueOrThrow({ where: { id: group.settlement } });
    const closeAudits = (operationId: string) =>
      prisma.auditLog.findMany({ where: { entityId: operationId, action: "booking-payment.card-refund.paid-another-way" } });

    const closeInput = (operationId: string, cents: number) => ({
      operationId,
      amountCents: cents,
      expectedOwedCents: cents,
      paidBack: "full" as const,
      note: "Paid to the organiser by bank transfer.",
      actingMemberId: OFFICER_ID,
    });

    async function waitForBlockedBy(blockerPid: number, count: number) {
      const startedAt = process.hrtime.bigint();
      while (realElapsedMs(startedAt) < LOCK_POLL_TIMEOUT_MS) {
        const rows = await observerClient.$queryRaw<Array<{ count: number }>>`
          SELECT COUNT(*)::int AS "count" FROM pg_stat_activity
          WHERE datname = current_database() AND ${blockerPid}::int = ANY(pg_blocking_pids(pid))
        `;
        if ((rows[0]?.count ?? 0) >= count) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Timed out waiting for ${count} transaction(s) to queue behind pid ${blockerPid}.`);
    }

    /** Hold `lock(1)` on the holder client until released. Resolves with the holder's pid once it holds it. */
    async function holdLockOne() {
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let ready!: (pid: number) => void;
      const started = new Promise<number>((resolve) => {
        ready = resolve;
      });
      const done = lockHolderClient.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
          const rows = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS "pid"`;
          ready(rows[0]!.pid);
          await released;
        },
        { timeout: 20_000 },
      );
      return { pid: await started, release, done };
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "#4851 group card refund settlements");
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      groupClose = await import("@/lib/card-refund-group-paid-another-way");
      groupTryAgain = await import("@/lib/card-refund-group-try-again");
      core = await import("@/lib/organiser-child-refund");
      executor = await import("@/lib/organiser-child-refund-executor");
      mirrorHandBack = await import("@/lib/group-settlement-mirror-hand-back");
      ({ MAX_PAYMENT_RECOVERY_ATTEMPTS: MAX_ATTEMPTS } = await import("@/lib/payment-recovery-constants"));
      ({ PAID_ANOTHER_WAY_MARKER } = await import("@/lib/card-refund-paid-another-way"));
      ({ buildGroupSettlementRefundRecoveryIdempotencyKey: legacyKey } = await import("@/lib/payment-recovery-keys"));
      ({ CLUB_FORMAT_TEST } = await import("@/lib/__tests__/support/club-format-fixture"));
      ({ realElapsedMs } = await import("@/lib/__tests__/helpers/clock"));
      const [{ PrismaClient: SeparatePrismaClient }, { createPrismaPgAdapter }] = await Promise.all([
        import("@prisma/client"),
        import("@/lib/prisma-adapter"),
      ]);
      const separate = (applicationName: string) => {
        const url = new URL(RACE_DB_URL);
        url.searchParams.set("connection_limit", "1");
        url.searchParams.set("application_name", applicationName);
        return new SeparatePrismaClient({ adapter: createPrismaPgAdapter(url.toString()) });
      };
      lockHolderClient = separate(`${P}-holder`);
      observerClient = separate(`${P}-observer`);
      await Promise.all([lockHolderClient.$connect(), observerClient.$connect()]);

      await deleteFixtures();
      for (const id of [MEMBER_ID, OFFICER_ID]) {
        await prisma.member.create({
          data: { id, email: `${id}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Group", lastName: "Proof", ageTier: "ADULT" },
        });
      }
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4851 Lodge", slug: P } });
    }, 120_000);

    beforeEach(() => {
      sent = [];
      listed = new Map();
      stripeRaceHooks.listRefunds = async (intent: string) => listed.get(intent) ?? [];
      stripeRaceHooks.refund = async (args) => {
        sent.push({ idempotencyKey: args.idempotencyKey, amountCents: args.amountCents });
        throw new Error("No refund may be sent to Stripe in this suite");
      };
      alertSpy = vi.spyOn(mirrorHandBack, "alertGroupMirrorRefundXeroByHand").mockResolvedValue(undefined);
    });

    afterEach(() => {
      alertSpy.mockRestore();
      resetStripeRaceHooks();
    });

    afterAll(async () => {
      await Promise.all(
        [lockHolderClient, observerClient].map((client) => (client ? client.$disconnect().catch(() => {}) : Promise.resolve())),
      );
      if (!prisma) return;
      await deleteFixtures();
    });

    // ------------------------------------------------------------ per joiner

    it("records a refund Stripe already holds under the row's key, and pays nobody again", async () => {
      const group = groupIds("keyed");
      await createGroup(group, { childStatus: "PAID" });
      const row = await deadPerJoinerRow(group);
      listed.set(group.intent, [stripeRefund({ id: "re_race_4851_keyed", intent: group.intent, amount: REFUND_CENTS, key: row.idempotencyKey })]);

      const result = await groupClose.closeGroupCardRefundPaidAnotherWay(closeInput(row.id, REFUND_CENTS));

      expect(result.outcome).toBe("recorded-stripe");
      expect(sent).toEqual([]);
      const operation = await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { id: row.id } });
      expect(operation).toMatchObject({ status: "SUCCEEDED", lastError: null });
      expect(await prisma.paymentRefund.findMany({ where: { paymentId: group.payments[0]! }, select: { stripeRefundId: true, amountCents: true } }))
        .toEqual([{ stripeRefundId: "re_race_4851_keyed", amountCents: REFUND_CENTS }]);
      expect((await childPayment(group)).refundedAmountCents).toBe(REFUND_CENTS);
      expect(await prisma.manualRefundTask.count({ where: { bookingId: group.children[0]! } })).toBe(0);
      expect(alertSpy).not.toHaveBeenCalled();
      expect(await closeAudits(row.id)).toHaveLength(1);
    });

    it("records a bank payment: the mirror, a no-Xero-note hand-back and its ledger line, no card refund", async () => {
      const group = groupIds("bank");
      await createGroup(group, { childStatus: "PAID" });
      const row = await deadPerJoinerRow(group);

      const result = await groupClose.closeGroupCardRefundPaidAnotherWay(closeInput(row.id, REFUND_CENTS));

      expect(result.outcome).toBe("bank");
      expect(sent).toEqual([]);
      const operation = await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { id: row.id } });
      expect(operation).toMatchObject({ status: "SUCCEEDED", lastError: PAID_ANOTHER_WAY_MARKER });
      expect((await childPayment(group)).refundedAmountCents).toBe(REFUND_CENTS);
      expect(await prisma.paymentRefund.count({ where: { paymentId: group.payments[0]! } })).toBe(0);
      const tasks = await prisma.manualRefundTask.findMany({ where: { bookingId: group.children[0]! } });
      expect(tasks).toEqual([
        expect.objectContaining({ status: "COMPLETED", amountCents: REFUND_CENTS, occurrenceKey: `card-refund-paid-another-way:${row.id}:no-xero-note` }),
      ]);
      expect(
        await prisma.bookingLedgerLine.count({ where: { bookingId: group.children[0]!, kind: "BANK_REFUND", unitCents: REFUND_CENTS } }),
      ).toBe(1);
      expect((await settlementNow(group)).status).toBe("SUCCEEDED");
      expect(alertSpy).toHaveBeenCalledTimes(1);
      expect(alertSpy.mock.calls[0]![0]).toMatchObject({ bookingId: group.children[0]!, refundCents: REFUND_CENTS, paidBy: "card" });
      expect(await closeAudits(row.id)).toHaveLength(1);
    });

    it("one row, one winner: a bank close and a re-arm queued behind lock(1) - one commits, the other writes nothing", async () => {
      const group = groupIds("race");
      await createGroup(group, { childStatus: "PAID" });
      const row = await deadPerJoinerRow(group);

      const holder = await holdLockOne();
      const close = groupClose.closeGroupCardRefundPaidAnotherWay(closeInput(row.id, REFUND_CENTS));
      const rearm = groupTryAgain.tryOrganiserChildCardRefundAgain({ operationId: row.id, expectedOwedCents: REFUND_CENTS, actingMemberId: OFFICER_ID });
      await waitForBlockedBy(holder.pid, 2);
      holder.release();
      await holder.done;
      const [closed, rearmed] = await Promise.allSettled([close, rearm]);

      const winners = [closed, rearmed].filter((outcome) => outcome.status === "fulfilled");
      expect(winners).toHaveLength(1);
      const loser = [closed, rearmed].find((outcome) => outcome.status === "rejected") as PromiseRejectedResult;
      expect(loser.reason).toMatchObject({ status: 409 });

      const operation = await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { id: row.id } });
      const tasks = await prisma.manualRefundTask.count({ where: { bookingId: group.children[0]! } });
      const tryAgainAudits = await prisma.auditLog.count({ where: { entityId: row.id, action: "booking-payment.card-refund.try-card-again" } });
      if (closed.status === "fulfilled") {
        expect(operation).toMatchObject({ status: "SUCCEEDED", lastError: PAID_ANOTHER_WAY_MARKER });
        expect(tasks).toBe(1);
        expect(tryAgainAudits).toBe(0);
        expect((await childPayment(group)).refundedAmountCents).toBe(REFUND_CENTS);
      } else {
        expect(operation).toMatchObject({ status: "PENDING", attempts: 0 });
        expect(tasks).toBe(0);
        expect(await closeAudits(row.id)).toHaveLength(0);
        expect((await childPayment(group)).refundedAmountCents).toBe(0);
      }
      expect(sent).toEqual([]);
    });

    it("a re-arm's first attempt finds the refund Stripe already holds under the key and records it, sending none", async () => {
      const group = groupIds("rearm");
      await createGroup(group, { childStatus: "PAID" });
      const row = await deadPerJoinerRow(group);

      const rearmed = await groupTryAgain.tryOrganiserChildCardRefundAgain({ operationId: row.id, expectedOwedCents: REFUND_CENTS, actingMemberId: OFFICER_ID });
      expect(rearmed.owedCents).toBe(REFUND_CENTS);
      expect(await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ status: "PENDING", attempts: 0 });

      // Between the re-arm and the runner, Stripe comes to hold the refund under this key (a lost answer, then made).
      const made = stripeRefund({ id: "re_race_4851_rearm", intent: group.intent, amount: REFUND_CENTS, key: row.idempotencyKey });
      let asked = 0;
      const claimed = await prisma.paymentRecoveryOperation.update({
        where: { id: row.id },
        data: { status: "PROCESSING", attempts: { increment: 1 } },
      });
      expect(claimed.attempts).toBe(1);
      const refundId = await executor.processOrganiserChildRefundOperation(claimed, CLUB_FORMAT_TEST, {
        listRefundsForPaymentIntent: async () => [made],
        processRefund: async () => {
          asked += 1;
          throw new Error("The runner must not send a refund Stripe already holds");
        },
      });

      expect(refundId).toBe("re_race_4851_rearm");
      expect(asked).toBe(0);
      expect(await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ status: "SUCCEEDED" });
      expect((await childPayment(group)).refundedAmountCents).toBe(REFUND_CENTS);
      expect(await prisma.paymentRefund.count({ where: { paymentId: group.payments[0]!, stripeRefundId: "re_race_4851_rearm" } })).toBe(1);
    });

    // --------------------------------------------------------- old whole group

    const LEGACY_PLAN_CENTS = [3_000, 2_000];

    it("an old whole-group refund Stripe made is recorded: the settlement flips and every child's mirror is raised", async () => {
      const group = groupIds("legacy-stripe");
      const plan = Object.fromEntries(group.children.map((id, index) => [id, LEGACY_PLAN_CENTS[index]!]));
      await createGroup(group, { childStatus: "CANCELLED", refundPlan: plan });
      const total = LEGACY_PLAN_CENTS[0]! + LEGACY_PLAN_CENTS[1]!;
      const row = await deadLegacyRow(group, total);
      listed.set(group.intent, [stripeRefund({ id: "re_race_4851_legacy", intent: group.intent, amount: total })]);

      const result = await groupClose.closeGroupCardRefundPaidAnotherWay(closeInput(row.id, total));

      expect(result.outcome).toBe("recorded-stripe");
      expect(sent).toEqual([]);
      expect((await settlementNow(group)).status).toBe("PARTIALLY_REFUNDED");
      expect((await childPayment(group, 0)).refundedAmountCents).toBe(LEGACY_PLAN_CENTS[0]);
      expect((await childPayment(group, 1)).refundedAmountCents).toBe(LEGACY_PLAN_CENTS[1]);
      expect(await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ status: "SUCCEEDED", lastError: null });
      expect(alertSpy).not.toHaveBeenCalled();
      expect(await closeAudits(row.id)).toHaveLength(1);
    });

    it("with no such refund, the old whole-group close records the bank payment and tells officers to credit Xero by hand", async () => {
      const group = groupIds("legacy-bank");
      const plan = Object.fromEntries(group.children.map((id, index) => [id, LEGACY_PLAN_CENTS[index]!]));
      await createGroup(group, { childStatus: "CANCELLED", refundPlan: plan });
      const total = LEGACY_PLAN_CENTS[0]! + LEGACY_PLAN_CENTS[1]!;
      const row = await deadLegacyRow(group, total);

      const result = await groupClose.closeGroupCardRefundPaidAnotherWay(closeInput(row.id, total));

      expect(result.outcome).toBe("bank");
      expect(sent).toEqual([]);
      expect((await settlementNow(group)).status).toBe("PARTIALLY_REFUNDED");
      expect((await childPayment(group, 0)).refundedAmountCents).toBe(LEGACY_PLAN_CENTS[0]);
      expect((await childPayment(group, 1)).refundedAmountCents).toBe(LEGACY_PLAN_CENTS[1]);
      expect(await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ status: "SUCCEEDED", lastError: PAID_ANOTHER_WAY_MARKER });
      expect(alertSpy).toHaveBeenCalledTimes(2);
      expect(alertSpy.mock.calls.map(([input]) => input.paidBy)).toEqual(["card", "card"]);
      expect(await closeAudits(row.id)).toHaveLength(1);
      // A second close finds the row closed and writes nothing.
      await expect(groupClose.closeGroupCardRefundPaidAnotherWay(closeInput(row.id, total))).rejects.toMatchObject({ status: 409 });
      expect(await closeAudits(row.id)).toHaveLength(1);
    });
  },
);
