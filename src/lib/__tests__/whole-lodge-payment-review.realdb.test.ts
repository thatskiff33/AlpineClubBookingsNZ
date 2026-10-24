import { LEDGER_ROWS_OLDEST_FIRST } from "@/lib/payment-ledger-order";
/**
 * #4019: compose real approval, card attachment, sanctioned placeholder linking,
 * bank switch and inbound receipt writers. Only session/configuration and
 * provider transport are doubled; credit/price/settlement posting is real.
 * Opt in through the disposable concurrency harness, never a developer DB.
 */
import { PrismaClient, Role } from "@prisma/client";
import type { Invoice } from "xero-node";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { raceSession } from "./support/race-session-double";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";
import { assertSafeRaceDbUrl } from "./support/race-db-url";
import { realElapsedMs } from "./helpers/clock";
import type { SuiteEnvironmentRoleDeclaration } from "./helpers/environment-role";

vi.mock("@/lib/auth", async () => (await import("./support/race-session-double")).raceAuthDouble());

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
const OWNER = "race-4019-owner";
const OFFICER = "race-4019-officer";
const LODGE = "race-4019-lodge";
const SEASON = "race-4019-season";
const REQUEST = "race-4019-request";
const CHECK_IN = new Date("2027-09-01T00:00:00.000Z");
const CHECK_OUT = new Date("2027-09-06T00:00:00.000Z");
let prisma: PrismaClient;
let observer: PrismaClient;
let holder: PrismaClient;
let role: SuiteEnvironmentRoleDeclaration | undefined;
let bookingId: string | null = null;
let approval: typeof import("@/lib/school-booking-request");
let attach: typeof import("@/lib/card-intent-attach");
let batch: typeof import("@/lib/booking-batch-modification-service");
let dates: typeof import("@/lib/booking-date-modification-service");
let credit: typeof import("@/lib/member-credit");
let flow: typeof import("@/lib/booking-payment-flow");
let queue: typeof import("@/lib/unpaid-finished-stays");
let switchRoute: typeof import("@/app/api/payments/switch-to-internet-banking/route");
let receipt: typeof import("@/lib/xero-inbound/invoice-paid-effects");
let clubTime: typeof import("@/lib/club-time/server");
let restore: (() => void)[] = [];
const pendingXero: Promise<unknown>[] = [];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function clean() {
  const settled = await Promise.allSettled(pendingXero.splice(0));
  if (bookingId) {
    const payments = await prisma.payment.findMany({ where: { bookingId }, select: { id: true } });
    const edits = await prisma.bookingModification.findMany({ where: { bookingId }, select: { id: true } });
    const ids = [bookingId, ...payments.map((p) => p.id), ...edits.map((e) => e.id)];
    await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: ids } } });
    await prisma.xeroObjectLink.deleteMany({ where: { localId: { in: ids } } });
    await prisma.bookingLedgerLine.deleteMany({ where: { bookingId } });
    await prisma.bookingEvent.deleteMany({ where: { bookingId } });
    await prisma.paymentRecoveryOperation.deleteMany({ where: { bookingId } });
    await prisma.manualRefundTask.deleteMany({ where: { bookingId } });
    await prisma.bookingModification.deleteMany({ where: { bookingId } });
    await prisma.hostingCoverageIncident.deleteMany({ where: { bookingId } });
    await prisma.hostingCoverageReevaluation.deleteMany({ where: { memberId: OWNER } });
    await prisma.bedAllocation.deleteMany({ where: { bookingId } });
    await prisma.paymentRefund.deleteMany({ where: { paymentId: { in: payments.map((p) => p.id) } } });
    await prisma.paymentTransaction.deleteMany({ where: { paymentId: { in: payments.map((p) => p.id) } } });
    await prisma.payment.deleteMany({ where: { bookingId } });
    await prisma.bookingGuestNight.deleteMany({ where: { bookingGuest: { bookingId } } });
    await prisma.bookingGuest.deleteMany({ where: { bookingId } });
  }
  await prisma.bookingRequest.deleteMany({ where: { id: REQUEST } });
  await prisma.memberCredit.deleteMany({ where: { memberId: OWNER } });
  await prisma.auditLog.deleteMany({ where: { OR: [{ memberId: { in: [OWNER, OFFICER] } }, { actorMemberId: OFFICER }, { targetId: REQUEST }, ...(bookingId ? [{ targetId: bookingId }] : [])] } });
  if (bookingId) await prisma.booking.deleteMany({ where: { id: bookingId } });
  bookingId = null;
  const errors = settled.filter((r) => r.status === "rejected");
  expect(errors, "All post-commit Xero work was drained before fixture deletion").toEqual([]);
}

async function approve(appliedCreditCents = 80_000, priceCents = 100_000) {
  if (appliedCreditCents > 0) await prisma.memberCredit.create({ data: { memberId: OWNER, amountCents: appliedCreditCents, type: "ADMIN_ADJUSTMENT", description: "synthetic opening balance" } });
  await prisma.bookingRequest.create({ data: {
    id: REQUEST, lodgeId: LODGE, type: "GENERAL", status: "VERIFIED", requestedByMemberId: OWNER,
    exclusivityRequested: true, applyAccountCredit: true, checkIn: CHECK_IN, checkOut: CHECK_OUT,
    contactFirstName: "Whole", contactLastName: "Lodge", contactEmail: "race-4019-owner@example.invalid",
    guests: [{ firstName: "Guest 1", lastName: "Proof", ageTier: "ADULT" }],
  } });
  const approved = await approval.approveMemberWholeLodgeRequest({ requestId: REQUEST, adminMemberId: OFFICER, override: { priceOverrideCents: priceCents, pricedHeadcount: 1 } });
  if (approved.type !== "approved") throw new Error("Synthetic approval unexpectedly exceeded capacity");
  bookingId = approved.bookingId;
  expect(approved.invoiceMode).toBe(appliedCreditCents === priceCents ? "paid" : "member");
  expect(await credit.deriveBookingAppliedCreditCents(bookingId)).toBe(appliedCreditCents);
  return bookingId;
}

async function startCard() {
  const current = await readBooking();
  const { bookingAmountOwedCents } = await import("@/lib/booking-payment-state");
  const amountCents = bookingAmountOwedCents({ finalPriceCents: current.finalPriceCents,
    changeFeeCents: current.payment?.changeFeeCents ?? 0,
    appliedCreditCents: await credit.deriveBookingAppliedCreditCents(bookingId!),
  });
  expect(await attach.attachMintedCardIntent({
    bookingId: bookingId!, paymentIntentId: `pi_${bookingId}`, payableStatuses: ["CONFIRMED"],
    paymentCreate: { amountCents, source: "STRIPE", stripePaymentIntentId: `pi_${bookingId}` },
    paymentUpdate: { stripePaymentIntentId: `pi_${bookingId}` },
    transaction: { amountCents, reason: "synthetic abandoned card entry", stripeCustomerId: "cus_race_4019" },
  })).toBe("attached");
}

function switchRequest() {
  return new NextRequest("http://localhost/api/payments/switch-to-internet-banking", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bookingId }),
  });
}

async function readBooking() {
  return prisma.booking.findUniqueOrThrow({ where: { id: bookingId! }, include: { payment: { include: { transactions: { orderBy: [...LEDGER_ROWS_OLDEST_FIRST] } } } } });
}

(RUN ? describe : describe.skip)("#4019 whole-lodge payment review composed proofs", () => {
  beforeAll(async () => {
    assertSafeRaceDbUrl(URL, "Whole-lodge payment review");
    process.env.DATABASE_URL = URL;
    const { declareEnvironmentRoleForSuite } = await import("./helpers/environment-role");
    role = declareEnvironmentRoleForSuite("non-production");
    ({ prisma } = await import("@/lib/prisma"));
    const { createPrismaPgAdapter } = await import("@/lib/prisma-adapter");
    observer = new PrismaClient({ adapter: createPrismaPgAdapter(URL) });
    holder = new PrismaClient({ adapter: createPrismaPgAdapter(URL) });
    approval = await import("@/lib/school-booking-request");
    attach = await import("@/lib/card-intent-attach");
    batch = await import("@/lib/booking-batch-modification-service");
    dates = await import("@/lib/booking-date-modification-service");
    credit = await import("@/lib/member-credit");
    flow = await import("@/lib/booking-payment-flow");
    queue = await import("@/lib/unpaid-finished-stays");
    switchRoute = await import("@/app/api/payments/switch-to-internet-banking/route");
    receipt = await import("@/lib/xero-inbound/invoice-paid-effects");
    clubTime = await import("@/lib/club-time/server");
    raceSession.current = { user: { id: OWNER, role: "USER", accessRoles: [], canLogin: true } };
    const modules = await import("@/lib/module-settings");
    const enabledModules = await import("@/lib/admin-modules");
    const realFlag = enabledModules.isEffectiveModuleEnabled;
    const flagSpy = vi.spyOn(enabledModules, "isEffectiveModuleEnabled").mockImplementation((key) => key === "xeroIntegration" || key === "internetBankingPayments" ? Promise.resolve(true) : realFlag(key));
    restore.push(() => flagSpy.mockRestore());
    const realFlags = modules.loadEffectiveModuleFlags;
    const flagsSpy = vi.spyOn(modules, "loadEffectiveModuleFlags").mockImplementation(async () => ({ ...await realFlags(), xeroIntegration: true, internetBankingPayments: true }));
    restore.push(() => flagsSpy.mockRestore());
    const xero = await import("@/lib/xero");
    const connected = vi.spyOn(xero, "isXeroConnected").mockResolvedValue(false);
    restore.push(() => connected.mockRestore());
    const outbox = await import("@/lib/xero-operation-outbox");
    // The transport drain never runs: enqueues and financial writers stay real.
    const kick = vi.spyOn(outbox, "kickQueuedXeroOutboxOperationsIfConnected").mockResolvedValue(undefined as never);
    restore.push(() => kick.mockRestore());
    const editXero = await import("@/lib/xero-booking-edit-settlement");
    const realQueue = editXero.queueXeroBookingEditSettlement;
    const queueSpy = vi.spyOn(editXero, "queueXeroBookingEditSettlement").mockImplementation((input) => {
      const pending = realQueue(input);
      if (input.bookingId === bookingId) pendingXero.push(pending);
      return pending;
    });
    restore.push(() => queueSpy.mockRestore());
    const stripe = await import("@/lib/stripe");
    const cancel = vi.spyOn(stripe, "cancelPaymentIntentIfCancellableWithResult").mockImplementation(async (id) => ({ canceled: true, paymentIntent: { id, status: "canceled" } as never }));
    restore.push(() => cancel.mockRestore());
    await prisma.member.createMany({ data: [
      { id: OWNER, email: `${OWNER}@example.invalid`, passwordHash: "synthetic", firstName: "Whole", lastName: "Lodge", ageTier: "ADULT", role: "USER", canLogin: true },
      { id: OFFICER, email: `${OFFICER}@example.invalid`, passwordHash: "synthetic", firstName: "Officer", lastName: "Proof", ageTier: "ADULT", role: "ADMIN", canLogin: true },
    ] });
    await prisma.memberAccessRole.create({ data: { memberId: OFFICER, role: "ADMIN" } });
    await prisma.lodge.create({ data: { id: LODGE, name: "4019 synthetic lodge", slug: LODGE } });
    await prisma.lodgeSettings.create({ data: { id: LODGE, lodgeId: LODGE, capacity: 10 } });
    const nonMember = await prisma.membershipType.findUniqueOrThrow({ where: { key: "NON_MEMBER" } });
    const fullMember = await prisma.membershipType.findUniqueOrThrow({ where: { key: "FULL" } });
    await prisma.seasonalMembershipAssignment.create({ data: { memberId: OWNER, seasonYear: 2027, membershipTypeId: fullMember.id } });
    await prisma.memberSubscription.create({ data: { memberId: OWNER, seasonYear: 2027, status: "PAID", paidAt: new Date("2026-06-01T00:00:00.000Z") } });
    await prisma.season.create({ data: { id: SEASON, name: "4019 synthetic season", lodgeId: LODGE, type: "WINTER", active: true,
      startDate: CHECK_IN, endDate: new Date("2027-09-30T00:00:00.000Z"),
      membershipTypeRates: { create: [
        { membershipTypeId: nonMember.id, ageTier: "ADULT", pricePerNightCents: 20_000 },
        { membershipTypeId: nonMember.id, ageTier: null, pricePerNightCents: 20_000 },
        { membershipTypeId: fullMember.id, ageTier: "ADULT", pricePerNightCents: 12_000 },
        { membershipTypeId: fullMember.id, ageTier: null, pricePerNightCents: 12_000 },
      ] },
    } });
  }, 120_000);
  beforeEach(clean);
  afterAll(async () => {
    try {
      if (prisma) {
        await clean();
        await prisma.membershipTypeSeasonRate.deleteMany({ where: { seasonId: SEASON } });
        await prisma.season.deleteMany({ where: { id: SEASON } });
        await prisma.lodgeSettings.deleteMany({ where: { lodgeId: LODGE } });
        await prisma.lodge.deleteMany({ where: { id: LODGE } });
        await prisma.memberSubscription.deleteMany({ where: { memberId: OWNER } });
        await prisma.seasonalMembershipAssignment.deleteMany({ where: { memberId: OWNER } });
        await prisma.memberAccessRole.deleteMany({ where: { memberId: OFFICER } });
        await prisma.member.deleteMany({ where: { id: { in: [OWNER, OFFICER] } } });
      }
    } finally {
      raceSession.current = null;
      for (const undo of restore.reverse()) undo();
      restore = [];
      await observer?.$disconnect();
      await holder?.$disconnect();
      role?.restore();
    }
  });

  it.each([{ creditCents: 100_000, priceCents: 100_000 }, { creditCents: 0, priceCents: 0 }])("approval posts its charge and credit once at zero cash ($creditCents credit/$priceCents price)", async ({ creditCents, priceCents }) => {
    await approve(creditCents, priceCents);
    const paid = await readBooking();
    expect(paid).toMatchObject({ status: "PAID", finalPriceCents: priceCents });
    expect(paid.payment).toMatchObject({ amountCents: 0, creditAppliedCents: creditCents, status: "SUCCEEDED" });
    expect(await credit.getMemberCreditBalance(OWNER)).toBe(0);
    const { bookingLedgerBalance } = await import("@/lib/booking-ledger-balance");
    const lines = await prisma.bookingLedgerLine.findMany({ where: { bookingId: bookingId! } });
    expect(bookingLedgerBalance(lines)).toEqual({ chargedCents: priceCents, settledCents: creditCents, adjustedCents: 0, owedCents: 0 });
    expect(lines.filter((line) => line.kind === "CARD_CAPTURE" || line.kind === "BANK_RECEIPT" || line.kind === "CASH_RECORDED")).toEqual([]);
    // Same existing confirmation fence as a cash settlement: a replay cannot
    // post fresh guest/night charge keys beside an earlier confirmation.
    const poster = await import("@/lib/booking-ledger-confirmation-sync");
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      const { acquireLodgeCapacityLock } = await import("@/lib/lodge-capacity-lock");
      await acquireLodgeCapacityLock(tx, LODGE);
      await poster.postStoredBookingConfirmationLedgerLines(tx, bookingId!);
    });
    expect(await prisma.bookingLedgerLine.count({ where: { bookingId: bookingId! } })).toBe(lines.length);
  }, 60_000);

  it.each([0, 5_000])("a sanctioned placeholder link returns excess credit after actual approval/card attachment (recorded fee=%s)", async (fee) => {
    await approve();
    await startCard();
    if (fee) {
      await prisma.payment.update({ where: { bookingId: bookingId! }, data: { changeFeeCents: fee } });
      // A recorded, still-unpaid fee has a modification provenance row, but
      // no confirmation charge yet; the existing PAID poster collects it.
      await prisma.bookingModification.create({ data: {
        bookingId: bookingId!, memberId: OFFICER, modificationType: "DATE_CHANGE",
        previousData: {}, newData: { finishedStayCorrection: { feeAddedToAmountOwed: true } },
        changeFeeCents: fee, priceDiffCents: 0,
      } });
    }
    const placeholder = await prisma.bookingGuest.findFirstOrThrow({ where: { bookingId: bookingId! } });
    await batch.modifyBookingBatch({
      bookingId: bookingId!, actor: { id: OFFICER, role: Role.ADMIN },
      input: { linkGuestToMember: [{ guestId: placeholder.id, memberId: OWNER }] },
      ipAddress: "127.0.0.1", todayAtClub: (await clubTime.clubTime()).today(), format: CLUB_FORMAT_TEST,
    });
    // Run any still-pending owned retirement through the real recovery worker.
    const recovery = await import("@/lib/payment-recovery");
    const retirements = await prisma.paymentRecoveryOperation.findMany({ where: { bookingId: bookingId!, status: "PENDING" } });
    for (const operation of retirements) expect(await recovery.runPaymentRecoveryOperationNow(operation.id, CLUB_FORMAT_TEST)).toBe("succeeded");
    const current = await readBooking();
    expect(current).toMatchObject({ finalPriceCents: 60_000, status: "PAID" });
    expect(await credit.deriveBookingAppliedCreditCents(bookingId!)).toBe(60_000 + fee);
    expect(await credit.getMemberCreditBalance(OWNER)).toBe(20_000 - fee);
    expect(current.payment).toMatchObject({ amountCents: 0, creditAppliedCents: 60_000 + fee, changeFeeCents: fee, status: "SUCCEEDED", stripePaymentIntentId: null });
    expect(current.payment?.transactions.every((row) => row.status === "FAILED")).toBe(true);
    const { bookingLedgerBalance } = await import("@/lib/booking-ledger-balance");
    const lines = await prisma.bookingLedgerLine.findMany({ where: { bookingId: bookingId! }, orderBy: { postedAt: "asc" } });
    expect(lines.filter((line) => line.kind === "CARD_CAPTURE" || line.kind === "BANK_RECEIPT" || line.kind === "CASH_RECORDED"), "No cash was captured by an abandoned card attempt").toEqual([]);
    expect(bookingLedgerBalance(lines).owedCents, JSON.stringify(lines.map(({ side, kind, amountCents, anchorKind, anchorId }) => ({ side, kind, amountCents, anchorKind, anchorId })))).toBe(0);
  }, 60_000);

  it.each(["batch", "dates"])("%s preserves the negotiated-price guard for structural edits after card entry", async (door) => {
    await approve();
    await startCard();
    const before = await readBooking();
    const { QUOTE_PRICED_EDIT_BLOCK_MESSAGE } = await import("@/lib/booking-modify-validation");
    const edit = door === "batch"
      ? batch.modifyBookingBatch({ bookingId: bookingId!, actor: { id: OFFICER, role: Role.ADMIN }, input: { checkOut: "2027-09-04" }, ipAddress: "127.0.0.1", todayAtClub: (await clubTime.clubTime()).today(), format: CLUB_FORMAT_TEST })
      : dates.modifyBookingDates({ bookingId: bookingId!, actor: { id: OFFICER, role: Role.ADMIN }, input: { checkOut: "2027-09-04" }, ipAddress: "127.0.0.1" });
    await expect(edit).rejects.toThrow(QUOTE_PRICED_EDIT_BLOCK_MESSAGE);
    expect(await readBooking()).toEqual(before);
    expect(await credit.deriveBookingAppliedCreditCents(bookingId!)).toBe(80_000);
    expect(await credit.getMemberCreditBalance(OWNER)).toBe(0);
  }, 60_000);

  it("the SQL queue includes abandoned zero-credit card entry and excludes a capture even with a stale mirror", async () => {
    await approve(0);
    await startCard();
    const where = { id: bookingId!, ...queue.buildUnpaidFinishedStaysWhere(CHECK_OUT) };
    expect(await prisma.booking.count({ where })).toBe(1);
    const current = await readBooking();
    await prisma.paymentTransaction.update({ where: { id: current.payment!.transactions[0]!.id }, data: { status: "SUCCEEDED" } });
    expect(flow.isUnpaidConfirmedWholeLodge(await readBooking())).toBe(false);
    expect(await prisma.booking.count({ where })).toBe(0);
  }, 60_000);

  it.each(["captured", "refunded", "internet-banking", "invoiced", "unknown"])("the real collection query excludes %s evidence", async (evidence) => {
    await approve(0);
    await startCard();
    const current = await readBooking();
    const paymentId = current.payment!.id;
    const rowId = current.payment!.transactions[0]!.id;
    if (evidence === "captured" || evidence === "refunded") {
      // Deliberately leave the scalar mirror stale: ledger evidence wins.
      await prisma.paymentTransaction.update({ where: { id: rowId }, data: { status: evidence === "captured" ? "SUCCEEDED" : "REFUNDED" } });
    } else if (evidence === "internet-banking") {
      await prisma.payment.update({ where: { id: paymentId }, data: { source: "INTERNET_BANKING" } });
    } else if (evidence === "invoiced") {
      await prisma.payment.update({ where: { id: paymentId }, data: { xeroInvoiceId: "race-4019-issued" } });
    } else {
      await prisma.paymentTransaction.deleteMany({ where: { paymentId } });
    }
    const booking = await readBooking();
    expect(flow.isUnpaidConfirmedWholeLodge(booking)).toBe(false);
    expect(await prisma.booking.count({ where: { id: bookingId!, ...queue.buildUnpaidFinishedStaysWhere(CHECK_OUT) } })).toBe(0);
  }, 60_000);

  it("a cancel winning after the initial switch snapshot retains the stopped lifecycle", async () => {
    await approve(0);
    const snapshot = deferred();
    const held = deferred();
    const release = deferred();
    const cancelling = holder.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      held.resolve();
      await release.promise;
      await tx.booking.updateMany({ where: { id: bookingId!, status: "CONFIRMED" }, data: { status: "CANCELLED" } });
    }, { timeout: 15_000 });
    const realFind = prisma.booking.findUnique.bind(prisma.booking);
    const spy = vi.spyOn(prisma.booking, "findUnique").mockImplementation((async (args: Parameters<typeof realFind>[0]) => {
      const row = await realFind(args);
      if (args.where.id === bookingId && args.include?.payment === true) snapshot.resolve();
      return row;
    }) as unknown as typeof prisma.booking.findUnique);
    let switching: Promise<Response> | undefined;
    let response: Response | undefined;
    try {
      await held.promise;
      switching = switchRoute.POST(switchRequest());
      const start = process.hrtime.bigint();
      let reached = false;
      void snapshot.promise.then(() => { reached = true; });
      while (!reached && realElapsedMs(start) < 5_000) await new Promise((done) => setTimeout(done, 10));
      expect(reached, "Switch read the old payable snapshot before cancellation committed").toBe(true);
    } finally {
      release.resolve();
      await cancelling;
      if (switching) response = await switching;
      spy.mockRestore();
    }
    expect(response!.status).toBe(409);
    expect((await readBooking()).status).toBe("CANCELLED");
    expect(await prisma.payment.count({ where: { bookingId: bookingId! } })).toBe(0);
    expect(await credit.deriveBookingAppliedCreditCents(bookingId!)).toBe(0);
  }, 60_000);

  it.each([true, false])("two pre-read switch requests create one receivable and one receipt posting (whole lodge=%s)", async (wholeLodge) => {
    await approve(0);
    if (!wholeLodge) await prisma.booking.update({ where: { id: bookingId! }, data: { status: "PAYMENT_PENDING", wholeLodgeHold: false } });
    const banking = await import("@/lib/internet-banking-settings");
    const originalSettings = banking.loadInternetBankingPaymentSettings;
    const settings = vi.spyOn(banking, "loadInternetBankingPaymentSettings").mockImplementation(async () => ({ ...await originalSettings(), holdBedSlots: false }));
    const locked = deferred();
    const release = deferred();
    const holding = holder.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      const rows = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`;
      locked.resolve();
      await release.promise;
      return rows[0]!.pid;
    }, { timeout: 15_000 });
    let requests: Promise<Response>[] = [];
    let result: PromiseSettledResult<Response>[] = [];
    let snapshots = 0;
    const realFind = prisma.booking.findUnique.bind(prisma.booking);
    const snapshotSpy = vi.spyOn(prisma.booking, "findUnique").mockImplementation((async (args: Parameters<typeof realFind>[0]) => {
      const row = await realFind(args);
      if (args.where.id === bookingId && args.include?.payment === true) snapshots += 1;
      return row;
    }) as unknown as typeof prisma.booking.findUnique);
    try {
      await locked.promise;
      requests = [switchRoute.POST(switchRequest()), switchRoute.POST(switchRequest())];
      const start = process.hrtime.bigint();
      let waiting = 0;
      while (realElapsedMs(start) < 5_000) {
        const rows = await observer.$queryRaw<Array<{ count: number }>>`SELECT COUNT(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND wait_event = 'advisory'`;
        waiting = rows[0]!.count;
        if (snapshots === 2 && waiting >= 2) break;
        await new Promise((done) => setTimeout(done, 10));
      }
      expect(snapshots, "Both requests read the initial no-Payment snapshot").toBe(2);
      expect(waiting, "Both requests reached the real global lock").toBeGreaterThanOrEqual(2);
    } finally {
      release.resolve();
      await holding;
      result = await Promise.allSettled(requests);
      snapshotSpy.mockRestore();
      settings.mockRestore();
    }
    const responses = result.map((entry) => {
      if (entry.status === "rejected") throw entry.reason;
      return entry.value;
    });
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    const bodies = await Promise.all(responses.map((r) => r.json()));
    expect(bodies[0].holdUntil).toBeNull();
    expect(bodies[1].holdUntil).toBeNull();
    const current = await readBooking();
    expect(current.payment!.transactions).toHaveLength(1);
    await prisma.payment.update({ where: { id: current.payment!.id }, data: { xeroInvoiceId: "race-4019-invoice" } });
    const invoice = { invoiceID: "race-4019-invoice", invoiceNumber: "INV-4019", status: "PAID", amountPaid: 1000, payments: [{ paymentID: "race-4019-receipt", amount: 1000 }] } as unknown as Invoice;
    await receipt.syncInternetBankingPaymentsForPaidInvoice(invoice, [current.payment!.id], CLUB_FORMAT_TEST);
    const paid = await readBooking();
    expect(paid.status).toBe("PAID");
    expect(paid.payment).toMatchObject({ amountCents: 100_000, status: "SUCCEEDED" });
    expect(paid.payment!.transactions).toHaveLength(1);
    const cash = await prisma.bookingLedgerLine.findMany({ where: { bookingId: bookingId!, side: "SETTLEMENT", settlementMethod: "INTERNET_BANKING" } });
    expect(cash).toHaveLength(1);
    expect(cash[0]!.amountCents).toBe(100_000);
  }, 60_000);
});

describe("#4019 realdb environment role restored", () => {
  it("returns the role to its incoming value", () => {
    if (role) expect(process.env.APP_ENVIRONMENT_ROLE).toBe(role.before);
  });
});
