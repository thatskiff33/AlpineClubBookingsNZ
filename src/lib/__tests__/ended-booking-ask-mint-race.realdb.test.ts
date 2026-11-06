/**
 * Real-PostgreSQL proof for #4316 (`INV-ADDPAY-044`): an edit's after-commit
 * mint never leaves a live additional ask on a booking cancelled in the gap.
 *
 * The edit doors decide to ask the card under `lock(1)` but create the Stripe
 * intent after their commit, in `createModificationAdditionalPaymentIntent`. The
 * paid cancel's claim retires only the intent it reads on the `Payment` mirror,
 * so a cancel landing between the edit's commit and the mint's row write had no
 * intent to see. The minter now re-reads the booking before the provider call
 * and after its row write, and retires what it wrote through the claim's own
 * routine. Each case runs the REAL `cancelBooking` against the REAL minter on
 * real rows; only Stripe is a fake that keeps its intents' statuses:
 *
 *  - the cancel commits BEFORE the mint: nothing is minted;
 *  - the cancel commits after the provider call, before the row write (run
 *    inside the fake's create): the minter retires its own ask;
 *  - the cancel's claim HOLDS the `Payment` row while the row write queues on
 *    it (forced: both queue behind a third connection, the cancel first): the
 *    minter's re-read after the write sees the commit and retires the ask;
 *  - the row write holds it first and the cancel queues behind it: the cancel
 *    reads the new intent on the mirror and retires it itself.
 *
 *  - review round 2: both Payment-row orders again on a fully REFUNDED payment,
 *    which reads captured to the minter but cancels down the never-captured
 *    branch - that branch now takes the row lock and retires the ask too;
 *  - the recovery runner's replay of a failed mint, the same two ways: on a
 *    booking bumped before it runs (nothing minted), and with a cancel landing
 *    between its provider call and its row write (it retires its own ask).
 *
 * In every case no ask intent is left live at Stripe and its row is FAILED.
 *
 * Envelope: identical to `concurrency-lock-races.realdb.test.ts`, which imports
 * this file; the describe runs ONLY when `RUN_CONCURRENCY_RACE_TESTS=1`, against
 * a loopback database on port 55442+ named with `concurrency_race_1881`. It owns
 * and cleans its own `race-4316-` fixtures.
 *
 *   RUN_CONCURRENCY_RACE_TESTS=1 \
 *   CONCURRENCY_RACE_DATABASE_URL=postgresql://user:pass@127.0.0.1:55442/concurrency_race_1881 \
 *   pnpm exec vitest run src/lib/__tests__/ended-booking-ask-mint-race.realdb.test.ts
 */
import type { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { releaseBookingJournalForTeardown } from "./support/booking-financial-history-teardown";

import { realElapsedMs } from "@/lib/__tests__/helpers/clock";

import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";
import { resetStripeRaceHooks, stripeRaceHooks } from "./support/stripe-race-double";

// The harness's one shared Stripe double: pass-through unless a case hooks it.
vi.mock("@/lib/stripe", async (importOriginal) =>
  (await import("./support/stripe-race-double")).stripeRaceDouble(await importOriginal()),
);

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const MEMBER_ID = "race-4316-member";
const LODGE_ID = "race-4316-lodge";
const BOOKING_ID = "race-4316-booking";
const PAYMENT_ID = "race-4316-payment";
const PRIMARY_TXN_ID = "race-4316-primary";
const MODIFICATION_ID = "race-4316-guest-add";
const PRIMARY_INTENT = "pi_race_4316_primary";
const CHECK_IN = new Date("2027-08-01T00:00:00.000Z");
const CHECK_OUT = new Date("2027-08-03T00:00:00.000Z");

const PAID_CENTS = 20_000;
/** The issue's +$80 guest add, committed before the mint. */
const ASK_CENTS = 8_000;

const LOCK_POLL_TIMEOUT_MS = 10_000;

/** The sibling harness's envelope, re-declared so running this file alone registers no other suite. */
function assertSafeRaceDbUrl(url: string): void {
  const parsed = new URL(url);
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) throw new Error(`Refusing port ${parsed.port || "(none)"}: use a throwaway Postgres on 55442+.`);
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname.toLowerCase())) throw new Error("The race DB must be loopback-only.");
  if (!decodeURIComponent(parsed.pathname).includes("concurrency_race_1881")) throw new Error("The race DB name must carry 'concurrency_race_1881'.");
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

type FakeIntent = { id: string; status: string; amount: number; client_secret: string };

/** Stripe as the cases need it: intents keep their status, and a cancel moves it. */
const stripe = { intents: new Map<string, FakeIntent>(), created: [] as string[] };

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let holderClient: PrismaClient;
let observerClient: PrismaClient;

(RUN ? describe : describe.skip)(
  "#4316: an edit's after-commit mint never leaves a live ask on a booking cancelled in the gap - real PostgreSQL",
  { timeout: 60_000 },
  () => {
    async function deleteFixtures() {
      await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: [BOOKING_ID, PAYMENT_ID, MODIFICATION_ID] } } });
      // The cancel's own email and audit rows, so a rerun starts clean.
      await prisma.emailLog.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.auditLog.deleteMany({ where: { targetId: BOOKING_ID } });
      // #4627: the doors post journal batches bridged to these lines; release them first.
      await releaseBookingJournalForTeardown(prisma, [BOOKING_ID]);
      await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.memberCredit.deleteMany({ where: { memberId: MEMBER_ID } });
      await prisma.paymentRecoveryOperation.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.manualRefundTask.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.paymentRefund.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
      await prisma.bookingModification.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
      await prisma.cancellationPolicy.deleteMany({ where: { lodgeId: LODGE_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
    }

    /** A PAID card booking whose +$80 guest add has just committed; its ask is not yet minted. */
    async function seedEditedBooking() {
      await prisma.member.create({
        data: { id: MEMBER_ID, email: `${MEMBER_ID}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Mint", lastName: "Proof", ageTier: "ADULT" },
      });
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4316 Lodge", slug: "race-4316" } });
      await prisma.cancellationPolicy.create({ data: { lodgeId: LODGE_ID, daysBeforeStay: 0, refundPercentage: 50, fixedFeeCents: 0 } });
      await prisma.booking.create({
        data: {
          id: BOOKING_ID,
          memberId: MEMBER_ID,
          lodgeId: LODGE_ID,
          checkIn: CHECK_IN,
          checkOut: CHECK_OUT,
          status: "PAID",
          totalPriceCents: PAID_CENTS + ASK_CENTS,
          finalPriceCents: PAID_CENTS + ASK_CENTS,
        },
      });
      await prisma.payment.create({
        data: {
          id: PAYMENT_ID,
          bookingId: BOOKING_ID,
          amountCents: PAID_CENTS,
          source: "STRIPE",
          status: "SUCCEEDED",
          stripePaymentIntentId: PRIMARY_INTENT,
          stripeCustomerId: "cus_race_4316",
          transactions: {
            create: { id: PRIMARY_TXN_ID, kind: "PRIMARY", source: "STRIPE", stripePaymentIntentId: PRIMARY_INTENT, amountCents: PAID_CENTS, status: "SUCCEEDED" },
          },
        },
      });
      await prisma.bookingModification.create({
        data: {
          id: MODIFICATION_ID,
          bookingId: BOOKING_ID,
          memberId: MEMBER_ID,
          modificationType: "GUEST_ADD",
          previousData: {},
          newData: {},
          priceDiffCents: ASK_CENTS,
        },
      });
    }

    async function mintTheEditsAsk() {
      const [{ createModificationAdditionalPaymentIntent }, { sizeAdditionalAsk }] = await Promise.all([
        import("@/lib/booking-modification-settlement"),
        import("@/lib/additional-payment-ask"),
      ]);
      return createModificationAdditionalPaymentIntent({
        format: CLUB_FORMAT_TEST,
        bookingId: BOOKING_ID,
        door: "guestAdd",
        failureMessage: "race-4316: the mint failed",
        result: {
          pendingRefundAmountCents: 0,
          organiserChildRefund: null,
          paymentId: PAYMENT_ID,
          additionalAsk: sizeAdditionalAsk({
            priceDiffCents: ASK_CENTS,
            changeFeeCents: 0,
            payment: { additionalAmountCents: 0, additionalPaymentStatus: null },
          }),
          retiredAdditionalAsks: [],
          hasSucceededPayment: true,
          hasIssuedXeroInvoice: false,
          paymentCustomerId: "cus_race_4316",
          memberEmail: `${MEMBER_ID}@example.invalid`,
          memberName: "Mint Proof",
          memberFirstName: "Mint",
          memberId: MEMBER_ID,
          bookingModificationId: MODIFICATION_ID,
          priceLines: null,
        },
      });
    }

    /**
     * The edit's mint failed and left its debt on a recovery row, as the door
     * writes it; the runner's replay is then run now, as the cron would run it.
     */
    async function replayTheFailedMint() {
      const [{ enqueueAdditionalPaymentIntentRecovery, runPaymentRecoveryOperationNow }, keys, request] = await Promise.all([
        import("@/lib/payment-recovery"),
        import("@/lib/payment-recovery-keys"),
        import("@/lib/ordinary-ask-request"),
      ]);
      const operation = await enqueueAdditionalPaymentIntentRecovery({
        bookingId: BOOKING_ID,
        paymentId: PAYMENT_ID,
        idempotencyKey: keys.buildAdditionalIntentRecoveryIdempotencyKey(MODIFICATION_ID),
        amountCents: ASK_CENTS,
        stripeIdempotencyKey: request.ordinaryAskDoorRequest("guestAdd", BOOKING_ID, MODIFICATION_ID).idempotencyKey,
        hadIssuedXeroInvoice: false,
        nextRetryAt: new Date(0),
      });
      const outcome = await runPaymentRecoveryOperationNow(operation.id, CLUB_FORMAT_TEST);
      const after = await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { id: operation.id }, select: { status: true } });
      return { outcome, status: after.status };
    }

    async function cancelTheBooking() {
      const { cancelBooking } = await import("@/lib/booking-cancel");
      return cancelBooking(BOOKING_ID, MEMBER_ID, "MEMBER", "127.0.0.1", CLUB_FORMAT_TEST, "credit");
    }

    /**
     * How many sessions wait on a lock behind the holder, directly or in line:
     * the first waiter on the row holds its tuple lock, so `pg_blocking_pids`
     * names that waiter, not the holder, for the second.
     */
    async function queuedInLine(holderPid: number): Promise<number> {
      const rows = await observerClient.$queryRaw<Array<{ count: number }>>`
        WITH RECURSIVE line(pid) AS (
          SELECT pid FROM pg_stat_activity
          WHERE datname = current_database() AND ${holderPid}::int = ANY(pg_blocking_pids(pid))
          UNION
          SELECT activity.pid FROM pg_stat_activity activity
          JOIN line ON line.pid = ANY(pg_blocking_pids(activity.pid))
          WHERE activity.datname = current_database()
        )
        SELECT COUNT(*)::int AS "count" FROM line
      `;
      return rows[0]?.count ?? 0;
    }

    async function waitForQueue(holderPid: number, depth: number, what: string) {
      const startedAt = process.hrtime.bigint();
      let seen = 0;
      while (realElapsedMs(startedAt) < LOCK_POLL_TIMEOUT_MS) {
        seen = await queuedInLine(holderPid);
        if (seen >= depth) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`${what}: ${seen} session(s) in line behind pid ${holderPid}, expected ${depth}.`);
    }

    /** Hold the Payment row on a third connection until `release` resolves. */
    async function holdPaymentRow(release: Promise<void>) {
      const held = deferred();
      let pid = 0;
      let error: unknown;
      const holder = holderClient
        .$transaction(
          async (tx) => {
            const rows = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`;
            pid = rows[0]?.pid ?? 0;
            await tx.$executeRaw`SELECT 1 FROM "Payment" WHERE "id" = ${PAYMENT_ID} FOR NO KEY UPDATE`;
            held.resolve();
            await release;
          },
          { maxWait: 5_000, timeout: 30_000 },
        )
        .catch((err: unknown) => {
          error = err;
          held.resolve();
        });
      await held.promise;
      if (error) throw new Error(`The holder could not take the Payment row: ${String(error)}`);
      return { pid, holder };
    }

    /** The ask's own ledger row, the mirror, its durable cancellation, and what Stripe says of it. */
    async function readTheAsk() {
      const row = await prisma.paymentTransaction.findFirst({
        where: { paymentId: PAYMENT_ID, kind: "ADDITIONAL" },
        select: { id: true, stripePaymentIntentId: true, status: true },
      });
      const payment = await prisma.payment.findUniqueOrThrow({
        where: { id: PAYMENT_ID },
        select: { additionalPaymentIntentId: true, additionalPaymentStatus: true },
      });
      const cancellation = row
        ? await prisma.paymentRecoveryOperation.findFirst({
            where: { paymentTransactionId: row.id, type: "CANCEL_PAYMENT_INTENT" },
            select: { paymentIntentId: true },
          })
        : null;
      const booking = await prisma.booking.findUniqueOrThrow({ where: { id: BOOKING_ID }, select: { status: true } });
      return { row, payment, cancellation, booking };
    }

    /** Every intent the mint created is dead at Stripe, and its row says so. */
    async function expectNoLiveAsk() {
      const { row, payment, cancellation, booking } = await readTheAsk();
      expect(booking.status).toBe("CANCELLED");
      expect(stripe.created).toHaveLength(1);
      const intentId = stripe.created[0]!;
      expect(stripe.intents.get(intentId)?.status, "INV-ADDPAY-044: the ask's intent is left live at Stripe on a cancelled booking").toBe("canceled");
      expect(row).toMatchObject({ stripePaymentIntentId: intentId, status: "FAILED" });
      expect(payment).toMatchObject({ additionalPaymentIntentId: intentId, additionalPaymentStatus: "FAILED" });
      // The durable backstop both writers key the same way (#1350).
      expect(cancellation).toMatchObject({ paymentIntentId: intentId });
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      const [{ PrismaClient: SeparatePrismaClient }, { createPrismaPgAdapter }] = await Promise.all([
        import("@prisma/client"),
        import("@/lib/prisma-adapter"),
      ]);
      const createSeparateClient = (applicationName: string) => {
        const url = new URL(RACE_DB_URL);
        url.searchParams.set("connection_limit", "1");
        url.searchParams.set("application_name", applicationName);
        return new SeparatePrismaClient({ adapter: createPrismaPgAdapter(url.toString()) });
      };
      holderClient = createSeparateClient("race-4316-holder");
      observerClient = createSeparateClient("race-4316-observer");
      await Promise.all([holderClient.$connect(), observerClient.$connect()]);
    });

    beforeEach(async () => {
      await deleteFixtures();
      await seedEditedBooking();
      stripe.intents.clear();
      stripe.created = [];
      stripeRaceHooks.create = async (args) => {
        const id = `pi_race_4316_ask_${stripe.created.length + 1}`;
        stripe.intents.set(id, { id, status: "requires_payment_method", amount: args.amountCents, client_secret: `${id}_secret` });
        stripe.created.push(id);
        return { ...stripe.intents.get(id)!, metadata: args.metadata ?? {} };
      };
      stripeRaceHooks.cancel = async (id) => {
        const intent = stripe.intents.get(id);
        if (!intent) throw new Error(`fake Stripe: no such intent ${id}`);
        if (intent.status === "succeeded" || intent.status === "canceled") return { paymentIntent: { ...intent }, canceled: false };
        intent.status = "canceled";
        return { paymentIntent: { ...intent }, canceled: true };
      };
    });

    afterEach(() => {
      resetStripeRaceHooks();
    });

    afterAll(async () => {
      resetStripeRaceHooks();
      if (!prisma) return;
      await deleteFixtures();
      await Promise.all([holderClient?.$disconnect(), observerClient?.$disconnect()]);
    });

    it("a cancel committed before the mint: nothing is minted and nothing is owed", async () => {
      expect((await cancelTheBooking()).status).toBe(200);

      const minted = await mintTheEditsAsk();

      expect(stripe.created).toEqual([]);
      expect(minted).toEqual({ additionalPaymentClientSecret: undefined, additionalPaymentIntentId: undefined, additionalAskRetired: true });
      const { row } = await readTheAsk();
      expect(row).toBeNull();
      const debts = await prisma.paymentRecoveryOperation.count({ where: { bookingId: BOOKING_ID, type: "CREATE_ADDITIONAL_PAYMENT_INTENT" } });
      expect(debts).toBe(0);
    });

    it("a cancel committed between the provider call and the row write: the minter retires the ask it wrote", async () => {
      const realCreate = stripeRaceHooks.create!;
      let cancelStatus = 0;
      // The cancel lands, whole, after Stripe minted and before the row exists:
      // its claim reads a mirror with no ask on it.
      stripeRaceHooks.create = async (args) => {
        const intent = await realCreate(args);
        cancelStatus = (await cancelTheBooking()).status;
        return intent;
      };

      const minted = await mintTheEditsAsk();

      expect(cancelStatus).toBe(200);
      expect(minted).toEqual({ additionalPaymentClientSecret: undefined, additionalPaymentIntentId: undefined, additionalAskRetired: true });
      await expectNoLiveAsk();
    });

    it("the cancel's claim holds the Payment row while the row write waits on it: the re-read after the write sees the commit", async () => {
      const release = deferred();
      const { pid, holder } = await holdPaymentRow(release.promise);
      let cancel: Promise<unknown> = Promise.resolve();
      let mint: Promise<unknown> = Promise.resolve();
      try {
        cancel = cancelTheBooking();
        await waitForQueue(pid, 1, "The cancel's claim never queued on the Payment row");
        mint = mintTheEditsAsk();
        await waitForQueue(pid, 2, "The mint's row write never queued behind the cancel");
      } finally {
        release.resolve();
        await holder;
      }
      const [cancelled, minted] = await Promise.all([cancel, mint]);

      expect(cancelled).toMatchObject({ status: 200 });
      expect(minted).toEqual({ additionalPaymentClientSecret: undefined, additionalPaymentIntentId: undefined, additionalAskRetired: true });
      await expectNoLiveAsk();
    });

    it("the row write holds the Payment row first: the cancel reads the new ask on the mirror and retires it itself", async () => {
      const release = deferred();
      const { pid, holder } = await holdPaymentRow(release.promise);
      let cancel: Promise<unknown> = Promise.resolve();
      let mint: Promise<unknown> = Promise.resolve();
      try {
        mint = mintTheEditsAsk();
        await waitForQueue(pid, 1, "The mint's row write never queued on the Payment row");
        cancel = cancelTheBooking();
        await waitForQueue(pid, 2, "The cancel's claim never queued behind the row write");
      } finally {
        release.resolve();
        await holder;
      }
      const [cancelled] = await Promise.all([cancel, mint]);

      expect(cancelled).toMatchObject({ status: 200 });
      // Whether the minter's re-read saw the commit is timing; either way the
      // ask is dead, retired by whichever writer ran second.
      await expectNoLiveAsk();
    });

    /** Review round 2: the card refunded in full - captured to the minter, never-captured to the cancel. */
    async function refundTheWholeCard() {
      await prisma.paymentTransaction.update({ where: { id: PRIMARY_TXN_ID }, data: { status: "REFUNDED", refundedAmountCents: PAID_CENTS } });
      await prisma.payment.update({ where: { id: PAYMENT_ID }, data: { status: "REFUNDED", refundedAmountCents: PAID_CENTS } });
    }

    /** Review round 3 (M5): the cancel leaves the refunded money's record as it was. */
    async function expectRefundStillRecorded() {
      const payment = await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID }, select: { status: true, refundedAmountCents: true } });
      expect(payment).toEqual({ status: "REFUNDED", refundedAmountCents: PAID_CENTS });
    }

    it("a fully REFUNDED payment: the never-captured cancel's claim holds the Payment row while the row write waits on it", async () => {
      await refundTheWholeCard();
      const release = deferred();
      const { pid, holder } = await holdPaymentRow(release.promise);
      let cancel: Promise<unknown> = Promise.resolve();
      let mint: Promise<unknown> = Promise.resolve();
      try {
        cancel = cancelTheBooking();
        await waitForQueue(pid, 1, "The never-captured cancel's claim never queued on the Payment row");
        mint = mintTheEditsAsk();
        await waitForQueue(pid, 2, "The mint's row write never queued behind the cancel");
      } finally {
        release.resolve();
        await holder;
      }
      const [cancelled, minted] = await Promise.all([cancel, mint]);

      expect(cancelled).toMatchObject({ status: 200 });
      expect(minted).toEqual({ additionalPaymentClientSecret: undefined, additionalPaymentIntentId: undefined, additionalAskRetired: true });
      await expectNoLiveAsk();
      await expectRefundStillRecorded();
    });

    it("a fully REFUNDED payment: the row write holds the Payment row first, and the never-captured cancel reads the new ask and retires it", async () => {
      await refundTheWholeCard();
      const release = deferred();
      const { pid, holder } = await holdPaymentRow(release.promise);
      let cancel: Promise<unknown> = Promise.resolve();
      let mint: Promise<unknown> = Promise.resolve();
      try {
        mint = mintTheEditsAsk();
        await waitForQueue(pid, 1, "The mint's row write never queued on the Payment row");
        cancel = cancelTheBooking();
        await waitForQueue(pid, 2, "The never-captured cancel's claim never queued behind the row write");
      } finally {
        release.resolve();
        await holder;
      }
      const [cancelled] = await Promise.all([cancel, mint]);

      expect(cancelled).toMatchObject({ status: 200 });
      await expectNoLiveAsk();
      await expectRefundStillRecorded();
    });

    it("the recovery runner's replay on a booking bumped before it runs: nothing is minted and the debt closes", async () => {
      await prisma.booking.update({ where: { id: BOOKING_ID }, data: { status: "BUMPED" } });

      const replayed = await replayTheFailedMint();

      expect(replayed).toEqual({ outcome: "succeeded", status: "SUCCEEDED" });
      expect(stripe.created).toEqual([]);
      expect((await readTheAsk()).row).toBeNull();
    });

    it("the recovery runner's replay with a cancel committed between its provider call and its row write: it retires the ask it wrote and closes the debt", async () => {
      const realCreate = stripeRaceHooks.create!;
      let cancelStatus = 0;
      stripeRaceHooks.create = async (args) => {
        const intent = await realCreate(args);
        cancelStatus = (await cancelTheBooking()).status;
        return intent;
      };

      const replayed = await replayTheFailedMint();

      expect(cancelStatus).toBe(200);
      expect(replayed).toEqual({ outcome: "succeeded", status: "SUCCEEDED" });
      await expectNoLiveAsk();
      // Nothing is owed on a cancelled booking: no supplementary invoice waits on the dead intent.
      expect(await prisma.xeroSyncOperation.count({ where: { localId: MODIFICATION_ID } })).toBe(0);
    });
  },
);
