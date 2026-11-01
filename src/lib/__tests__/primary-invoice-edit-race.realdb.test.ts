/**
 * Real-PostgreSQL proof for #3980 (`INV-PAY-136`; owner decision 21 Oct 2026,
 * "refuse, and bill the gap"): an ordinary edit racing the booking's primary
 * Xero invoice create either is refused, or lands in what the create measures
 * at its link and is billed (a price increase) or handed to the treasurer (a
 * reduction).
 *
 * THE EDIT IS THE REAL DOOR: `modifyBookingBatch`, under its real `lock(1)`,
 * lodge key and post-lock re-read, through `applyPaymentAdjustments` and its
 * claim on the Payment row (`claimPrimaryInvoiceStillUnlinked`). THE LINK'S
 * SIDE IS THE REAL CODE TOO: `persistPrimaryInvoiceLink` and
 * `queuePrimaryInvoiceWorthGap`, then the real create's "invoice already
 * exists" exit (`createXeroInvoiceForBooking`). Only the create's provider leg
 * is stood in for: {@link inFlightCreate} reads the booking and builds its
 * lines exactly as the create does (`buildInvoiceLineItems`,
 * `bookingWorthCents`, `invoiceLineItemsTotalCents`), then waits where the
 * create waits on Xero. The shared harness's one Xero-client fake belongs to
 * #3836's suite, so this one does not register a second.
 *
 *  1. A price increase that commits while the create is in flight: the edit's
 *     claim wins, its history row is marked, and the link's save reads the new
 *     worth back - the gap goes on ONE supplementary invoice anchored on that
 *     edit, unpaid, and the create's replay queues nothing more.
 *  2. A reduction in the same window: the invoice bills more than the booking
 *     is worth, so ONE Xero Operations task is raised for the treasurer, FAILED
 *     and not replayable; no credit note, nothing queued, and the replay raises
 *     no second task.
 *  3. An edit arriving while the link's save holds the Payment row: it queues
 *     on the row, finds the link and is refused (409, try again) with nothing
 *     applied; its retry reads the link and adjusts the invoice like any edit.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so CI reaches it; it cleans its own
 * uniquely-namespaced `race-3980-` fixtures.
 */
import { Role, type PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { releaseBookingJournalForTeardown } from "./support/booking-financial-history-teardown";

import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";
import { assertSafeRaceDbUrl } from "@/lib/__tests__/support/race-db-url";
import { realElapsedMs } from "@/lib/__tests__/helpers/clock";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const OWNER_ID = "race-3980-owner";
const OFFICER_ID = "race-3980-officer";
const LODGE_ID = "race-3980-lodge";
const SEASON_ID = "race-3980-season";
const BOOKING_ID = "race-3980-booking";
const GUEST_ID = "race-3980-guest";
const GUEST_2_ID = "race-3980-guest-2";
const PAYMENT_ID = "race-3980-payment";
const INVOICE_ID = "race-3980-xero-invoice";
// Future against the frozen suite clock (1 July 2026), beyond every fee tier.
const CHECK_IN = new Date("2026-09-10T00:00:00.000Z");
const NIGHT_2 = new Date("2026-09-11T00:00:00.000Z");
const CHECK_OUT = new Date("2026-09-12T00:00:00.000Z");
const NIGHT_CENTS = 5_000;
/** Two guests, two nights each. */
const PRICE_CENTS = 4 * NIGHT_CENTS;
/** One guest's two nights: what an add raises the price by, or a removal lowers it. */
const GUEST_CENTS = 2 * NIGHT_CENTS;

let prisma: PrismaClient;
let batchService: typeof import("@/lib/booking-batch-modification-service");
let clubTimeServer: typeof import("@/lib/club-time/server");
let gap: typeof import("@/lib/xero-primary-invoice-fee-gap");
let invoices: typeof import("@/lib/xero-booking-invoices");
let xeroSync: typeof import("@/lib/xero-sync");
let invoiceKey: typeof import("@/lib/xero-booking-invoice-key");
let lineItems: typeof import("@/lib/xero-modification-line-items");
let paymentState: typeof import("@/lib/booking-payment-state");
let claim: typeof import("@/lib/booking-primary-invoice-claim");
let snapshot: typeof import("@/lib/xero-primary-invoice-read");
const pendingXeroWork: Promise<unknown>[] = [];
let restoreXeroQueue: (() => void) | undefined;
let restoreClaim: (() => void) | undefined;
/** Review C1/C2: a connection of its own, to see who waits on whom. */
let observerClient: PrismaClient;
/** Review C2: when set, the edit pauses inside its transaction right after its claim. */
let pauseAfterClaim: { claimed: ReturnType<typeof deferred>; release: ReturnType<typeof deferred>; pid: number } | null = null;
const LOCK_POLL_TIMEOUT_MS = 5_000;

/** How many sessions are queued behind this backend (`pg_blocking_pids`). */
async function queuedBehind(blockerPid: number): Promise<number> {
  const rows = await observerClient.$queryRaw<Array<{ count: number }>>`
    SELECT COUNT(*)::int AS "count"
    FROM pg_stat_activity
    WHERE datname = current_database()
      AND ${blockerPid}::int = ANY(pg_blocking_pids(pid))
  `;
  return rows[0]?.count ?? 0;
}

/** Waits (real clock) until a session queues behind `blockerPid`; returns how many did. */
async function untilQueuedBehind(blockerPid: number): Promise<number> {
  const startedAt = process.hrtime.bigint();
  let queued = 0;
  while (realElapsedMs(startedAt) < LOCK_POLL_TIMEOUT_MS) {
    queued = await queuedBehind(blockerPid);
    if (queued >= 1) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return queued;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function modificationIds(): Promise<string[]> {
  const rows = await prisma.bookingModification.findMany({ where: { bookingId: BOOKING_ID }, select: { id: true } });
  return rows.map((row) => row.id);
}

async function drainXeroWork(): Promise<unknown[]> {
  const errors: unknown[] = [];
  while (pendingXeroWork.length > 0) {
    for (const result of await Promise.allSettled(pendingXeroWork.splice(0))) {
      if (result.status === "rejected") errors.push(result.reason);
    }
  }
  return errors;
}

async function clean(): Promise<void> {
  // The batch's post-commit Xero leg is not awaited by the service; let it
  // finish before deleting the operations and modifications that name it.
  const enqueueErrors = await drainXeroWork();
  const localIds = [BOOKING_ID, PAYMENT_ID, ...(await modificationIds())];
  await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: localIds } } });
  await prisma.xeroObjectLink.deleteMany({ where: { localId: { in: localIds } } });
  await prisma.auditLog.deleteMany({
    where: {
      OR: [
        { targetId: BOOKING_ID },
        { memberId: { in: [OWNER_ID, OFFICER_ID] } },
        { actorMemberId: { in: [OWNER_ID, OFFICER_ID] } },
        { subjectMemberId: OWNER_ID },
      ],
    },
  });
  await prisma.paymentRecoveryOperation.deleteMany({ where: { bookingId: BOOKING_ID } });
  // #4627: the doors post journal batches bridged to these lines; release them first.
  await releaseBookingJournalForTeardown(prisma, [BOOKING_ID]);
  await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.manualRefundTask.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.memberCredit.deleteMany({ where: { memberId: OWNER_ID } });
  await prisma.bookingModification.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.hostingCoverageReevaluation.deleteMany({ where: { memberId: OWNER_ID } });
  await prisma.hostingCoverageIncident.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.bedAllocation.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
  await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
  await prisma.bookingGuestNight.deleteMany({ where: { bookingGuest: { bookingId: BOOKING_ID } } });
  await prisma.bookingGuest.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
  if (enqueueErrors.length > 0) {
    throw new AggregateError(enqueueErrors, "#3980: a fixture's Xero enqueue failed; all work drained and owned fixtures cleaned");
  }
}

/**
 * A PAYMENT_PENDING card booking with nothing captured yet, two guests for two
 * nights at the season's rate, and no primary invoice: the moment the invoice
 * create is raising it.
 */
async function seed(): Promise<void> {
  await prisma.booking.create({
    data: {
      id: BOOKING_ID,
      memberId: OWNER_ID,
      lodgeId: LODGE_ID,
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      status: "PAYMENT_PENDING",
      totalPriceCents: PRICE_CENTS,
      finalPriceCents: PRICE_CENTS,
    },
  });
  for (const [id, firstName] of [
    [GUEST_ID, "Original"],
    [GUEST_2_ID, "Second"],
  ] as const) {
    await prisma.bookingGuest.create({
      data: {
        id,
        bookingId: BOOKING_ID,
        firstName,
        lastName: "Guest",
        ageTier: "ADULT",
        isMember: false,
        stayStart: CHECK_IN,
        stayEnd: CHECK_OUT,
        priceCents: GUEST_CENTS,
        nights: {
          create: [
            { stayDate: CHECK_IN, priceCents: NIGHT_CENTS, priceSource: "SOLD" },
            { stayDate: NIGHT_2, priceCents: NIGHT_CENTS, priceSource: "SOLD" },
          ],
        },
      },
    });
  }
  await prisma.payment.create({
    data: { id: PAYMENT_ID, bookingId: BOOKING_ID, amountCents: 0, source: "STRIPE", status: "PENDING" },
  });
}

/** The officer's edit through the real batch door. */
async function edit(input: Record<string, unknown>) {
  return batchService.modifyBookingBatch({
    bookingId: BOOKING_ID,
    actor: { id: OFFICER_ID, role: Role.ADMIN },
    input: input as never,
    ipAddress: "127.0.0.1",
    todayAtClub: (await clubTimeServer.clubTime()).today(),
    format: CLUB_FORMAT_TEST,
  });
}

const ADD_GUEST = { addGuests: [{ firstName: "Late", lastName: "Friend", ageTier: "ADULT", isMember: false }] };
const REMOVE_GUEST = { removeGuestIds: [GUEST_2_ID] };

/**
 * The create, up to Xero and back: one read of the booking, its lines built
 * from that read as `createXeroInvoiceForBooking` builds them, its operation
 * started, then a wait where the create waits on Xero - released by the test -
 * and the real link save and gap check with the invoice Xero hands back, which
 * bills the lines the create sent.
 */
async function inFlightCreate(release: Promise<void>, reached: () => void) {
  // The create's own snapshot read (review M1).
  const { booking: read, markedModificationIdsAtBuild } = await snapshot.readBookingForPrimaryInvoice(BOOKING_ID);
  const booking = read!;
  const nights = 2;
  const lines = invoices.buildInvoiceLineItems(
    booking.guests.map((guest) => ({
      firstName: guest.firstName,
      lastName: guest.lastName,
      ageTier: guest.ageTier,
      isMember: guest.isMember,
      priceCents: guest.priceCents,
      nights: guest.nights.map((night) => ({ stayDate: night.stayDate, priceCents: night.priceCents })),
    })),
    booking.checkIn,
    booking.checkOut,
    nights,
  );
  const built = {
    worthCents: paymentState.bookingWorthCents({
      finalPriceCents: booking.finalPriceCents,
      changeFeeCents: booking.payment!.changeFeeCents,
    }),
    lineTotalCents: lineItems.invoiceLineItemsTotalCents(lines),
    markedModificationIdsAtBuild,
  };
  const key = invoiceKey.buildXeroBookingInvoiceCorrelationKey(BOOKING_ID);
  const operation = await xeroSync.startXeroSyncOperation({
    direction: "OUTBOUND",
    entityType: "INVOICE",
    operationType: "CREATE",
    localModel: "Payment",
    localId: PAYMENT_ID,
    idempotencyKey: key,
    correlationKey: key,
    requestPayload: { invoices: [{ lineItems: lines }] },
  });
  reached();
  await release;
  const atLink = await gap.persistPrimaryInvoiceLink({
    operationId: operation.id,
    paymentId: PAYMENT_ID,
    xeroInvoiceNumber: "INV-3980",
    billed: gap.primaryInvoiceBilledFee(INVOICE_ID, lines),
    built,
    primaryInvoiceCashCents: 0,
    primaryInvoiceAttemptedCashCents: 0,
  });
  if (!atLink) throw new Error("expected the first save of this link");
  const worthGap = await gap.queuePrimaryInvoiceWorthGap({ bookingId: BOOKING_ID, atLink });
  await xeroSync.completeXeroSyncOperation(operation, { status: "SUCCEEDED", responsePayload: { invoice: INVOICE_ID } });
  return { atLink, worthGap, operationId: operation.id };
}

/** Runs `during` while the create waits on Xero, then lets the create finish. */
async function raceTheCreate<T>(during: () => Promise<T>) {
  const release = deferred();
  const reached = deferred();
  const create = inFlightCreate(release.promise, reached.resolve);
  await reached.promise;
  const edited = await during();
  release.resolve();
  const created = await create;
  return { edited, created };
}

async function supplementaryInvoices() {
  return prisma.xeroSyncOperation.findMany({
    where: { localModel: "BookingModification", localId: { in: await modificationIds() }, queueType: "SUPPLEMENTARY_INVOICE" },
    select: { localId: true, status: true, requestPayload: true },
  });
}

async function reviewTasks() {
  return prisma.xeroSyncOperation.findMany({
    where: { localModel: "Booking", localId: BOOKING_ID, entityType: "REVIEW" },
    select: { status: true, replayable: true, lastErrorCode: true, lastErrorMessage: true, requestPayload: true },
  });
}

(RUN ? describe : describe.skip)("an edit racing the primary invoice create, on PostgreSQL (#3980)", () => {
  beforeAll(async () => {
    assertSafeRaceDbUrl(RACE_DB_URL, "Primary invoice edit race");
    process.env.DATABASE_URL = RACE_DB_URL;
    ({ prisma } = (await import("@/lib/prisma")) as unknown as { prisma: PrismaClient });
    batchService = await import("@/lib/booking-batch-modification-service");
    clubTimeServer = await import("@/lib/club-time/server");
    gap = await import("@/lib/xero-primary-invoice-fee-gap");
    invoices = await import("@/lib/xero-booking-invoices");
    xeroSync = await import("@/lib/xero-sync");
    invoiceKey = await import("@/lib/xero-booking-invoice-key");
    lineItems = await import("@/lib/xero-modification-line-items");
    paymentState = await import("@/lib/booking-payment-state");
    claim = await import("@/lib/booking-primary-invoice-claim");
    snapshot = await import("@/lib/xero-primary-invoice-read");
    const xeroQueue = await import("@/lib/xero-booking-edit-settlement");
    const queue = xeroQueue.queueXeroBookingEditSettlement;
    const spy = vi.spyOn(xeroQueue, "queueXeroBookingEditSettlement").mockImplementation((input) => {
      const pending = queue(input);
      if (input.bookingId === BOOKING_ID) pendingXeroWork.push(pending);
      return pending;
    });
    restoreXeroQueue = () => spy.mockRestore();
    // Review C2: pass-through unless a case sets `pauseAfterClaim`, because the
    // harness imports every suite into one process.
    const writeEditOnPayment = claim.writeEditOnPayment;
    const claimSpy = vi.spyOn(claim, "writeEditOnPayment").mockImplementation(async (tx, input) => {
      const settled = await writeEditOnPayment(tx, input);
      const pause = pauseAfterClaim;
      if (pause && settled) {
        const rows = await (tx as unknown as PrismaClient).$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`;
        pause.pid = rows[0]?.pid ?? 0;
        pause.claimed.resolve();
        await pause.release.promise;
      }
      return settled;
    });
    restoreClaim = () => claimSpy.mockRestore();
    const [{ PrismaClient: SeparatePrismaClient }, { createPrismaPgAdapter }] = await Promise.all([
      import("@prisma/client"),
      import("@/lib/prisma-adapter"),
    ]);
    const observerUrl = new URL(RACE_DB_URL);
    observerUrl.searchParams.set("connection_limit", "1");
    observerUrl.searchParams.set("application_name", "race-3980-observer");
    observerClient = new SeparatePrismaClient({ adapter: createPrismaPgAdapter(observerUrl.toString()) });
    await observerClient.$connect();

    await clean();
    await prisma.membershipTypeSeasonRate.deleteMany({ where: { seasonId: SEASON_ID } });
    await prisma.season.deleteMany({ where: { id: SEASON_ID } });
    await prisma.cancellationPolicy.deleteMany({ where: { lodgeId: LODGE_ID } });
    await prisma.lodgeSettings.deleteMany({ where: { id: LODGE_ID } });
    await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
    await prisma.memberAccessRole.deleteMany({ where: { memberId: OFFICER_ID } });
    await prisma.member.deleteMany({ where: { id: { in: [OWNER_ID, OFFICER_ID] } } });

    for (const [id, firstName, role] of [
      [OWNER_ID, "Owner", Role.USER],
      [OFFICER_ID, "Officer", Role.ADMIN],
    ] as const) {
      await prisma.member.create({
        data: {
          id,
          email: `${id}@example.invalid`,
          passwordHash: "not-a-real-password",
          firstName,
          lastName: "Proof",
          ageTier: "ADULT",
          canLogin: true,
          role,
        },
      });
    }
    await prisma.memberAccessRole.create({ data: { memberId: OFFICER_ID, role: "ADMIN" } });
    await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 3980 Lodge", slug: "race-3980" } });
    await prisma.lodgeSettings.create({ data: { id: LODGE_ID, lodgeId: LODGE_ID, capacity: 10 } });
    await prisma.cancellationPolicy.createMany({
      data: [
        { lodgeId: LODGE_ID, daysBeforeStay: 14, refundPercentage: 100, creditRefundPercentage: 100 },
        { lodgeId: LODGE_ID, daysBeforeStay: 0, refundPercentage: 50, creditRefundPercentage: 80 },
      ],
    });
    const nonMember = await prisma.membershipType.findUniqueOrThrow({ where: { key: "NON_MEMBER" } });
    await prisma.season.create({
      data: {
        id: SEASON_ID,
        name: "Race 3980 spring",
        type: "WINTER",
        startDate: new Date("2026-09-01T00:00:00.000Z"),
        endDate: new Date("2026-09-30T00:00:00.000Z"),
        active: true,
        lodgeId: LODGE_ID,
        membershipTypeRates: {
          create: [
            { membershipTypeId: nonMember.id, ageTier: "ADULT", pricePerNightCents: NIGHT_CENTS },
            { membershipTypeId: nonMember.id, ageTier: null, pricePerNightCents: NIGHT_CENTS },
          ],
        },
      },
    });
  }, 120_000);

  beforeEach(async () => {
    await clean();
    await seed();
  });

  afterAll(async () => {
    try {
      if (!prisma) return;
      await clean();
      await prisma.membershipTypeSeasonRate.deleteMany({ where: { seasonId: SEASON_ID } });
      await prisma.season.deleteMany({ where: { id: SEASON_ID } });
      await prisma.cancellationPolicy.deleteMany({ where: { lodgeId: LODGE_ID } });
      await prisma.lodgeSettings.deleteMany({ where: { id: LODGE_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.memberAccessRole.deleteMany({ where: { memberId: OFFICER_ID } });
      await prisma.member.deleteMany({ where: { id: { in: [OWNER_ID, OFFICER_ID] } } });
    } finally {
      restoreXeroQueue?.();
      restoreClaim?.();
      pauseAfterClaim = null;
      await observerClient?.$disconnect();
    }
  });

  it("a price increase committed mid-create is billed once, on a supplementary invoice anchored on the edit", async () => {
    const { created } = await raceTheCreate(() => edit(ADD_GUEST));

    // The edit won its claim before the link: applied, and marked.
    const [modification] = await prisma.bookingModification.findMany({ where: { bookingId: BOOKING_ID } });
    expect(modification.newData).toMatchObject({ primaryInvoiceSettlement: { settledAgainstPrimaryInvoice: true } });
    expect(await prisma.bookingGuest.count({ where: { bookingId: BOOKING_ID } })).toBe(3);

    // The link read back the edited worth; the invoice billed the old one.
    expect(created.atLink).toMatchObject({
      xeroInvoiceId: INVOICE_ID,
      billedTotalCents: PRICE_CENTS,
      worth: { atBuildCents: PRICE_CENTS, builtTotalCents: PRICE_CENTS, atLinkCents: PRICE_CENTS + GUEST_CENTS },
    });
    expect(created.worthGap).toMatchObject({ gapCents: GUEST_CENTS, alreadyQueued: false, reviewOperationId: null });

    await drainXeroWork();
    const queued = await supplementaryInvoices();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      localId: modification.id,
      status: "PENDING",
      requestPayload: expect.objectContaining({
        bookingId: BOOKING_ID,
        bookingModificationId: modification.id,
        priceDiffCents: GUEST_CENTS,
        changeFeeCents: 0,
        recordPayment: false,
      }),
    });
    expect(await reviewTasks()).toHaveLength(0);

    // The create's retry takes its "invoice already exists" exit and re-checks
    // from the stored figures: nothing more is queued.
    await expect(invoices.createXeroInvoiceForBooking(BOOKING_ID)).resolves.toBe(INVOICE_ID);
    expect(await supplementaryInvoices()).toHaveLength(1);
    expect(await reviewTasks()).toHaveLength(0);
  }, 60_000);

  it("a reduction committed mid-create raises one Xero Operations task for the treasurer, and no credit note", async () => {
    const { created } = await raceTheCreate(() => edit(REMOVE_GUEST));

    const [modification] = await prisma.bookingModification.findMany({ where: { bookingId: BOOKING_ID } });
    expect(modification.newData).toMatchObject({ primaryInvoiceSettlement: { settledAgainstPrimaryInvoice: true } });
    expect(created.atLink.worth).toEqual({
      atBuildCents: PRICE_CENTS,
      builtTotalCents: PRICE_CENTS,
      atLinkCents: PRICE_CENTS - GUEST_CENTS,
      // The create's snapshot held no marked edit: this one landed mid-create.
      markedModificationIdsAtBuild: [],
    });
    expect(created.worthGap).toMatchObject({ gapCents: -GUEST_CENTS, queueOperationId: null });

    const tasks = await reviewTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      status: "FAILED",
      replayable: false,
      lastErrorCode: "PRIMARY_INVOICE_OVERBILLED",
      requestPayload: expect.objectContaining({ kind: "OVERBILLED", gapCents: -GUEST_CENTS, xeroInvoiceId: INVOICE_ID }),
    });
    expect(tasks[0].lastErrorMessage).toContain("bills $100.00 more than the booking is worth");
    // Review M5: how the reduction settled - nothing was paid, so nothing came back.
    expect(tasks[0].lastErrorMessage).toContain("The change returned no money.");
    expect(tasks[0].requestPayload).toMatchObject({ reductionModificationIds: [modification.id] });

    await drainXeroWork();
    expect(await supplementaryInvoices()).toHaveLength(0);
    expect(
      await prisma.xeroSyncOperation.count({
        where: { localId: { in: [BOOKING_ID, PAYMENT_ID, modification.id] }, entityType: "CREDIT_NOTE" },
      }),
    ).toBe(0);

    // The replay re-checks and finds the task already raised.
    await expect(invoices.createXeroInvoiceForBooking(BOOKING_ID)).resolves.toBe(INVOICE_ID);
    expect(await reviewTasks()).toHaveLength(1);
  }, 60_000);

  it("review C2: the link's save queues behind an edit that has claimed, and reads its worth back once it commits", async () => {
    // The create reads the booking (before the edit) and waits on Xero.
    const xeroAnswered = deferred();
    const createReached = deferred();
    const create = inFlightCreate(xeroAnswered.promise, createReached.resolve);
    await createReached.promise;

    // The edit claims the unlinked payment row and pauses inside its transaction.
    const pause = { claimed: deferred(), release: deferred(), pid: 0 };
    pauseAfterClaim = pause;
    const edited = edit(ADD_GUEST).then(
      () => "applied",
      (error: unknown) => error,
    );
    let queued = 0;
    try {
      await pause.claimed.promise;
      // Xero answers: the create's REAL link save now runs, and must queue on
      // the row the edit's claim holds.
      xeroAnswered.resolve();
      queued = await untilQueuedBehind(pause.pid);
    } finally {
      pauseAfterClaim = null;
      pause.release.resolve();
      xeroAnswered.resolve();
    }
    expect(queued).toBe(1);
    expect(await edited).toBe("applied");
    const { atLink, worthGap } = await create;

    // The save waited for the edit, so the worth it read back holds it.
    expect(atLink.worth).toMatchObject({ atBuildCents: PRICE_CENTS, atLinkCents: PRICE_CENTS + GUEST_CENTS });
    const [modification] = await prisma.bookingModification.findMany({ where: { bookingId: BOOKING_ID } });
    expect(worthGap).toMatchObject({ gapCents: GUEST_CENTS, alreadyQueued: false });
    await drainXeroWork();
    const queuedInvoices = await supplementaryInvoices();
    expect(queuedInvoices).toHaveLength(1);
    expect(queuedInvoices[0]).toMatchObject({
      localId: modification.id,
      requestPayload: expect.objectContaining({ priceDiffCents: GUEST_CENTS, changeFeeCents: 0 }),
    });
  }, 60_000);

  it("an edit arriving while the link's save holds the Payment row is refused whole, and its retry adjusts the invoice", async () => {
    // The link's save: its first statement is the Payment row's update, held
    // uncommitted while the edit reads "no invoice" and reaches its claim.
    const holding = deferred();
    const release = deferred();
    let holderPid = 0;
    const persist = prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`;
        holderPid = rows[0]?.pid ?? 0;
        await tx.payment.update({
          where: { id: PAYMENT_ID },
          data: { xeroInvoiceId: INVOICE_ID, xeroInvoiceNumber: "INV-3980" },
        });
        holding.resolve();
        await release.promise;
      },
      { timeout: 30_000 },
    );
    await holding.promise;
    const outcome = edit(ADD_GUEST).then(
      () => "applied",
      (error: unknown) => error,
    );
    // Review C1: wait until the edit's claim is QUEUED on the row the save
    // holds, as PostgreSQL reports it, not for a guessed length of time.
    let queuedOnRow = 0;
    try {
      queuedOnRow = await untilQueuedBehind(holderPid);
    } finally {
      release.resolve();
      await persist;
    }
    expect(queuedOnRow).toBe(1);

    const refusal = await outcome;
    expect(refusal).toBeInstanceOf(claim.PrimaryInvoiceRaisedDuringEditError);
    expect(refusal).toMatchObject({ status: 409, message: claim.PRIMARY_INVOICE_RAISED_DURING_EDIT_MESSAGE });
    // Nothing applied: no guest, no history row, no price change.
    expect(await prisma.bookingGuest.count({ where: { bookingId: BOOKING_ID } })).toBe(2);
    expect(await prisma.bookingModification.count({ where: { bookingId: BOOKING_ID } })).toBe(0);
    expect(await prisma.booking.findUniqueOrThrow({ where: { id: BOOKING_ID }, select: { finalPriceCents: true } })).toEqual({
      finalPriceCents: PRICE_CENTS,
    });

    // The member's retry reads the link and settles against the invoice like
    // any edit: its own supplementary invoice, no claim, no marker.
    await edit(ADD_GUEST);
    const [modification] = await prisma.bookingModification.findMany({ where: { bookingId: BOOKING_ID } });
    expect(modification.newData).not.toHaveProperty("primaryInvoiceSettlement");
    await drainXeroWork();
    const queued = await supplementaryInvoices();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      localId: modification.id,
      requestPayload: expect.objectContaining({ priceDiffCents: GUEST_CENTS }),
    });
  }, 60_000);
});
