/**
 * Real-PostgreSQL proof that the late internet-banking capacity cancel gives
 * back the booking's applied account credit (#3792).
 *
 * The unit suite (`xero-inbound-reconciliation.test.ts`) pins the call. What a
 * mock cannot show is the money end to end through the REAL inbound reconcile
 * (`syncInternetBankingPaymentsForPaidInvoice`) against a lodge with no room:
 * the issue's worked example — $80 of credit applied plus a $120 bank transfer
 * that lands after capacity has gone — leaves the member with $200 of credit,
 * the restore posts its ledger line so `owed(b)` is zero, a replay of the same
 * invoice restores and mints nothing more, and the nightly orphan-credit heal
 * neither reports the booking nor can restore it a second time. A cash-only
 * booking is unchanged: the cash comes back and nothing else is written.
 *
 * Where the applied credit was itself a Xero credit note allocated to the
 * booking's invoice, the REAL inbound credit-note sync
 * (`repairAccountCreditAllocationBusinessState`) runs after the cancel: an
 * unchanged allocation changes nothing, and an allocation removed in Xero is
 * not credited a second time on top of the restore — the operator is alerted
 * instead (INV-PAY-019).
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so CI reaches it; it cleans its own
 * uniquely-namespaced `race-3792-` fixtures.
 */
import type { PrismaClient } from "@prisma/client";
import type { Invoice } from "xero-node";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { bookingLedgerBalance } from "@/lib/booking-ledger-balance";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const MEMBER_ID = "race-3792-member";
// A lodge with no beds and no configured capacity resolves to zero (#1982), so
// any guest is over capacity: the late payment always takes the capacity cancel.
const LODGE_ID = "race-3792-lodge";
const BOOKING_ID = "race-3792-booking";
const PAYMENT_ID = "race-3792-payment";
const INVOICE_ID = "race-3792-invoice";
const GUEST_ID = "race-3792-guest";
// The Xero credit note behind the applied credit, allocated to the invoice.
const CREDIT_NOTE_ID = "race-3792-note";
const CHECK_IN = new Date("2027-09-01T00:00:00.000Z");
const CHECK_OUT = new Date("2027-09-02T00:00:00.000Z");

/** Standalone fail-closed copy: importing this file must not register another suite. */
export function assertSafeIbCapacityRestoreRaceDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("IB capacity-restore proofs need a valid CONCURRENCY_RACE_DATABASE_URL.");
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(
      `Refusing to run IB capacity-restore proofs against port ${parsed.port || "(none)"}: use a throwaway PostgreSQL on 55442+ (never 5432).`,
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error("IB capacity-restore proof DB must be loopback-only.");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName.includes("concurrency_race_1881")) {
    throw new Error("IB capacity-restore proof DB name must contain 'concurrency_race_1881'.");
  }
}

// The inbound sync's operator alert, observed rather than mailed.
const xeroSyncAlert = vi.hoisted(() => vi.fn());
vi.mock("@/lib/xero-error-alert", () => ({ notifyXeroSyncError: xeroSyncAlert }));

let prisma: PrismaClient;
let memberCredit: typeof import("@/lib/member-credit");
let paidEffects: typeof import("@/lib/xero-inbound/invoice-paid-effects");
let orphanHeal: typeof import("@/lib/orphaned-applied-credit-backfill");
let creditNoteRepairs: typeof import("@/lib/xero-inbound/credit-note-repairs");

/** A PAID invoice carrying `cashCents` of bank cash, as a fresh getInvoice reads it. */
function paidInvoice(cashCents: number, allocatedNoteCents = 0): Invoice {
  return {
    invoiceID: INVOICE_ID,
    invoiceNumber: "INV-3792",
    status: "PAID",
    amountPaid: cashCents / 100,
    payments: [{ paymentID: "race-3792-xpay", amount: cashCents / 100 }],
    ...(allocatedNoteCents > 0
      ? { creditNotes: [{ creditNoteID: CREDIT_NOTE_ID, appliedAmount: allocatedNoteCents / 100 }] }
      : {}),
  } as unknown as Invoice;
}

async function clean(): Promise<void> {
  const slices = await prisma.memberCreditNoteAllocation.findMany({ where: { appliedToBookingId: BOOKING_ID }, select: { id: true } });
  await prisma.xeroObjectLink.deleteMany({ where: { localModel: "MemberCreditNoteAllocation", localId: { in: slices.map((slice) => slice.id) } } });
  await prisma.memberCreditNoteAllocation.deleteMany({ where: { appliedToBookingId: BOOKING_ID } });
  await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: [PAYMENT_ID, BOOKING_ID] } } });
  await prisma.memberCredit.deleteMany({ where: { memberId: MEMBER_ID } });
  await prisma.bedAllocation.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
  await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
  await prisma.bookingGuest.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
}

/** A PAYMENT_PENDING booking, `appliedCents` of credit applied through the real writer, the rest owed by bank transfer. */
async function seedBooking(appliedCents: number, cashCents: number): Promise<void> {
  const priceCents = appliedCents + cashCents;
  await prisma.booking.create({
    data: {
      id: BOOKING_ID,
      memberId: MEMBER_ID,
      lodgeId: LODGE_ID,
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      status: "PAYMENT_PENDING",
      totalPriceCents: priceCents,
      finalPriceCents: priceCents,
    },
  });
  await prisma.bookingGuest.create({
    data: {
      id: GUEST_ID,
      bookingId: BOOKING_ID,
      firstName: "Restore",
      lastName: "Proof",
      ageTier: "ADULT",
      isMember: true,
      stayStart: CHECK_IN,
      stayEnd: CHECK_OUT,
      priceCents,
      nights: { create: [{ stayDate: CHECK_IN, priceCents, priceSource: "SOLD" }] },
    },
  });
  await prisma.payment.create({
    data: {
      id: PAYMENT_ID,
      bookingId: BOOKING_ID,
      amountCents: cashCents,
      creditAppliedCents: appliedCents,
      source: "INTERNET_BANKING",
      status: "PENDING",
      reference: "BOOKING-RACE3792",
      xeroInvoiceId: INVOICE_ID,
      xeroInvoiceNumber: "INV-3792",
    },
  });
  if (appliedCents > 0) {
    await prisma.memberCredit.create({
      data: { memberId: MEMBER_ID, amountCents: appliedCents, type: "ADMIN_ADJUSTMENT", description: "race 3792 opening balance" },
    });
    await prisma.$transaction((tx) =>
      memberCredit.applyCreditToBooking(MEMBER_ID, appliedCents, BOOKING_ID, tx, CLUB_FORMAT_TEST),
    );
  }
}

/**
 * The applied credit as the #1620 allocation engine leaves it once Xero holds
 * it: the funding lot carries its own credit note, that note is allocated to
 * the booking's invoice (a precise slice plus an active allocation link), and
 * the applied row is stamped with the note.
 */
async function allocateAppliedCreditInXero(appliedCents: number): Promise<void> {
  const lot = await prisma.memberCredit.findFirstOrThrow({ where: { memberId: MEMBER_ID, type: "ADMIN_ADJUSTMENT" } });
  await prisma.memberCredit.update({ where: { id: lot.id }, data: { xeroCreditNoteId: CREDIT_NOTE_ID } });
  await prisma.memberCredit.updateMany({ where: { memberId: MEMBER_ID, type: "BOOKING_APPLIED" }, data: { xeroCreditNoteId: CREDIT_NOTE_ID } });
  const slice = await prisma.memberCreditNoteAllocation.create({
    data: { memberCreditId: lot.id, xeroCreditNoteId: CREDIT_NOTE_ID, appliedToBookingId: BOOKING_ID, amountCents: appliedCents },
  });
  await prisma.xeroObjectLink.create({
    data: {
      localModel: "MemberCreditNoteAllocation",
      localId: slice.id,
      xeroObjectType: "ALLOCATION",
      xeroObjectId: `${CREDIT_NOTE_ID}:${INVOICE_ID}`,
      role: "APPLIED_CREDIT_ALLOCATION",
      active: true,
      metadata: { creditNoteId: CREDIT_NOTE_ID, invoiceId: INVOICE_ID, amountCents: appliedCents },
    },
  });
}

async function ledgerLines() {
  return prisma.bookingLedgerLine.findMany({
    where: { bookingId: BOOKING_ID },
    select: { side: true, kind: true, amountCents: true, anchorKind: true, anchorId: true },
  });
}

async function reconcile(cashCents: number) {
  return paidEffects.syncInternetBankingPaymentsForPaidInvoice(paidInvoice(cashCents), [PAYMENT_ID], CLUB_FORMAT_TEST);
}

(RUN ? describe : describe.skip)("the late internet-banking capacity cancel restores applied credit, against PostgreSQL (#3792)", () => {
  beforeAll(async () => {
    assertSafeIbCapacityRestoreRaceDbUrl(RACE_DB_URL);
    process.env.DATABASE_URL = RACE_DB_URL;
    ({ prisma } = await import("@/lib/prisma"));
    memberCredit = await import("@/lib/member-credit");
    paidEffects = await import("@/lib/xero-inbound/invoice-paid-effects");
    orphanHeal = await import("@/lib/orphaned-applied-credit-backfill");
    creditNoteRepairs = await import("@/lib/xero-inbound/credit-note-repairs");

    await clean();
    await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
    await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
    await prisma.member.create({
      data: { id: MEMBER_ID, email: `${MEMBER_ID}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Restore", lastName: "Proof", ageTier: "ADULT" },
    });
    await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 3792 Lodge", slug: "race-3792" } });
  });

  beforeEach(async () => {
    await clean();
    xeroSyncAlert.mockClear();
  });

  afterAll(async () => {
    if (!prisma) return;
    await clean();
    await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
    await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
  });

  it("THE WORKED EXAMPLE: $80 applied plus a late $120 transfer leaves the member $200 of credit, owed(b) zero, and a replay changes nothing", async () => {
    await seedBooking(8_000, 12_000);
    expect(await memberCredit.getMemberCreditBalance(MEMBER_ID)).toBe(0);

    await reconcile(12_000);

    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: BOOKING_ID }, select: { status: true } });
    expect(booking.status).toBe("CANCELLED");
    expect(await memberCredit.getMemberCreditBalance(MEMBER_ID)).toBe(20_000);
    const restore = await prisma.memberCredit.findMany({ where: { restoredFromBookingId: BOOKING_ID }, select: { amountCents: true } });
    expect(restore).toEqual([{ amountCents: 8_000 }]);

    // The restore posts its own line, anchored on the cancellation, beside the
    // applied credit, the bank receipt and the cash minted as credit.
    const lines = await ledgerLines();
    expect(lines).toContainEqual(expect.objectContaining({ kind: "CREDIT_ISSUED", anchorKind: "CANCELLATION", anchorId: BOOKING_ID, amountCents: -8_000 }));
    expect(bookingLedgerBalance(lines).owedCents).toBe(0);

    // A replay of the same PAID invoice meets a CANCELLED booking: nothing more.
    await reconcile(12_000);
    expect(await memberCredit.getMemberCreditBalance(MEMBER_ID)).toBe(20_000);
    expect(bookingLedgerBalance(await ledgerLines()).owedCents).toBe(0);

    // The nightly orphan heal does not report it, and its restore cannot land twice.
    const { findings } = await orphanHeal.findOrphanedAppliedCredits();
    expect(findings.map((finding) => finding.bookingId)).not.toContain(BOOKING_ID);
    expect(await memberCredit.restoreCreditFromBooking(MEMBER_ID, BOOKING_ID)).toBe(0);
    expect(await memberCredit.getMemberCreditBalance(MEMBER_ID)).toBe(20_000);
  });

  it("A CASH-ONLY booking is unchanged: the $120 comes back as credit and no restore row is written", async () => {
    await seedBooking(0, 12_000);

    await reconcile(12_000);

    expect(await memberCredit.getMemberCreditBalance(MEMBER_ID)).toBe(12_000);
    expect(await prisma.memberCredit.count({ where: { restoredFromBookingId: BOOKING_ID } })).toBe(0);
    expect(bookingLedgerBalance(await ledgerLines()).owedCents).toBe(0);
  });

  it("AFTER THE CANCEL, an UNCHANGED Xero allocation run through the real credit-note sync leaves the member $200", async () => {
    await seedBooking(8_000, 12_000);
    await allocateAppliedCreditInXero(8_000);

    await paidEffects.syncInternetBankingPaymentsForPaidInvoice(paidInvoice(12_000, 8_000), [PAYMENT_ID], CLUB_FORMAT_TEST);
    expect(await memberCredit.getMemberCreditBalance(MEMBER_ID)).toBe(20_000);

    await creditNoteRepairs.repairAccountCreditAllocationBusinessState(CREDIT_NOTE_ID, [{ invoiceId: INVOICE_ID, amountCents: 8_000 }]);

    expect(await memberCredit.getMemberCreditBalance(MEMBER_ID)).toBe(20_000);
    expect(xeroSyncAlert).not.toHaveBeenCalled();
  });

  it("AFTER THE CANCEL, an allocation REMOVED in Xero is not credited again on top of the restore: still $200, and the operator is alerted", async () => {
    await seedBooking(8_000, 12_000);
    await allocateAppliedCreditInXero(8_000);

    await paidEffects.syncInternetBankingPaymentsForPaidInvoice(paidInvoice(12_000, 8_000), [PAYMENT_ID], CLUB_FORMAT_TEST);
    expect(await memberCredit.getMemberCreditBalance(MEMBER_ID)).toBe(20_000);

    // The next credit-note sync finds no allocation of the note left in Xero.
    const repaired = await creditNoteRepairs.repairAccountCreditAllocationBusinessState(CREDIT_NOTE_ID, []);

    expect(await memberCredit.getMemberCreditBalance(MEMBER_ID)).toBe(20_000);
    expect(repaired.skippedAllocations).toBe(1);
    expect(await prisma.memberCredit.count({ where: { memberId: MEMBER_ID, description: { startsWith: "Xero allocation reconciliation" } } })).toBe(0);
    expect(xeroSyncAlert).toHaveBeenCalledTimes(1);
    expect(xeroSyncAlert).toHaveBeenCalledWith(expect.objectContaining({
      errorType: "applied-credit-restored-booking-deallocation",
      errorMessage: expect.stringContaining(`booking ${BOOKING_ID} is cancelled`),
    }));

    // A replay of the sync is no different.
    await creditNoteRepairs.repairAccountCreditAllocationBusinessState(CREDIT_NOTE_ID, []);
    expect(await memberCredit.getMemberCreditBalance(MEMBER_ID)).toBe(20_000);
  });

  it("ON A LIVE BOOKING, the same Xero removal still credits the member: no restore row, so the guard stays out of the way", async () => {
    await seedBooking(8_000, 12_000);
    await allocateAppliedCreditInXero(8_000);
    expect(await memberCredit.getMemberCreditBalance(MEMBER_ID)).toBe(0);

    await creditNoteRepairs.repairAccountCreditAllocationBusinessState(CREDIT_NOTE_ID, []);

    expect(await memberCredit.getMemberCreditBalance(MEMBER_ID)).toBe(8_000);
    expect(xeroSyncAlert).not.toHaveBeenCalled();
  });
});
