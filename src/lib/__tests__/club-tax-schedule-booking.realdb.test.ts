/**
 * The club's tax treatment as a dated schedule (#4632) against real PostgreSQL:
 * a booking keeps the treatment of the day it was made for its whole life, and
 * its journal and its Xero documents agree on it.
 *
 * A booking is made and settled by card under the baseline (GST registered,
 * 15%, OUTPUT2), then the one writer schedules an unregistered period from the
 * next club day. With the clock past the change, the booking's primary invoice
 * is raised, it is edited (a guest removed, a change fee charged) and then
 * cancelled, each through the real door and the real Xero sender. Xero itself
 * is a fake that records each payload; no provider is called.
 *
 * "Agree" is the issue's own definition: the same gross per document, the same
 * treatment, and the same per-line formula, round(line x r / (1 + r)). The
 * amounts are multiples of 115 cents, where splitting a component whole and
 * splitting it line by line give the same cents, so any difference here is a
 * treatment that disagrees, never rounding (the per-line residual is #4525's).
 *
 * The CHECK and the unique index on `ClubTaxSettings` are tried with raw SQL so
 * the database, not Prisma's types, is what refuses.
 *
 * Ordinary Vitest runs skip the file; CI's real-PostgreSQL job runs it against
 * the guarded loopback race database. It cleans its own namespaced rows, its
 * tax periods and the Xero operations its senders recorded.
 */
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { BookingJournalContext } from "@/lib/member-money/doors";
import type { MemberMoneyPostingContext } from "@/lib/member-money";

import {
  cleanHistories,
  createHistoryBooking,
  historyNames,
  postHistoryEdit,
  seedHistoryFixtures,
  settleHistoryByCard,
} from "./support/booking-ledger-history";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";
import { FROZEN_TEST_CLOCK_BASE_ISO } from "./helpers/clock";
import { assertSafeRaceDbUrl } from "./support/race-db-url";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const PREFIX = "race-4632-";
const names = historyNames(PREFIX);

/** Club today on the frozen clock is 2026-07-01, so the earliest change starts on 2026-07-02. */
const CHANGE_DATE = "2026-07-02";
/** A booking made on club day 2026-07-01 (midday in Auckland), under the baseline. */
const MADE_BEFORE = new Date("2026-07-01T00:00:00.000Z");
/** A booking made on club day 2026-07-02 (midday in Auckland), under the new period. */
const MADE_ON_CHANGE = new Date("2026-07-02T00:00:00.000Z");
/** The doors run on club day 2026-07-03: today's treatment is the unregistered one. */
const DOOR_DAY = new Date("2026-07-03T00:00:00.000Z");

/** 57.50 a night: two guests, two nights each. Every amount below is a multiple of 115 cents. */
const NIGHT = 5_750;
const PRICE = 4 * NIGHT; // 23_000, tax 3_000
const GUEST = 2 * NIGHT; // 11_500, tax 1_500
const CHANGE_FEE = 2_300; // tax 300
const KEPT = 4_600; // tax 600

const RATE = 1_500;
const TAX_CODE = "GST_INCLUSIVE_1500BP";
const REVENUE_ACCOUNTS = ["BOOKING_REVENUE", "FEE_REVENUE"] as const;

let prisma: PrismaClient;
let doors: typeof import("@/lib/member-money/doors");
let cancellationSync: typeof import("@/lib/booking-ledger-cancellation-sync");
let census: typeof import("@/lib/booking-ledger-projection-census-store");
let taxWrite: typeof import("@/lib/club-tax-settings-write");
let anchors: typeof import("@/lib/xero-tax-anchors");

/**
 * The issue's per-line formula, written here independently of the product's
 * splitter: round-half-up of |line| x r / (1 + r), carrying the line's sign.
 */
function perLineTaxCents(lineCents: number): number {
  const magnitude = Math.abs(lineCents);
  const tax = Math.floor((2 * magnitude * RATE + (10_000 + RATE)) / (2 * (10_000 + RATE)));
  return lineCents < 0 ? -tax : tax;
}

type XeroLine = { unitAmount?: number; quantity?: number; taxType?: string; description?: string };
type XeroDocument = { lineAmountTypes?: unknown; lineItems?: XeroLine[] };

/** A document as Xero adds it up: each line's amount, and the issue's formula over each line. */
function documentMoney(document: XeroDocument) {
  const lines = (document.lineItems ?? []).map((line) => Math.round((line.unitAmount ?? 0) * 100) * (line.quantity ?? 1));
  return {
    lineAmountTypes: String(document.lineAmountTypes),
    taxTypes: [...new Set((document.lineItems ?? []).map((line) => line.taxType ?? null))],
    grossCents: lines.reduce((sum, cents) => sum + cents, 0),
    perLineTaxCents: lines.reduce((sum, cents) => sum + perLineTaxCents(cents), 0),
  };
}

/**
 * One journal event's revenue as the journal posted it: its gross and its GST,
 * each signed credit-positive, and the tax codes on its revenue legs. Every
 * taxed leg is held to the same formula as the Xero line.
 */
async function eventMoney(eventKey: string) {
  const legs = await prisma.memberMoneyLine.findMany({
    where: { journal: { event: { eventKey } } },
    select: { account: true, side: true, amountCents: true, grossCents: true, netCents: true, taxCents: true, taxCode: true },
  });
  expect(legs.length, `no journal event ${eventKey}`).toBeGreaterThan(0);
  const credit = (side: string, cents: number) => (side === "CREDIT" ? cents : -cents);
  const revenue = legs.filter((leg) => (REVENUE_ACCOUNTS as readonly string[]).includes(leg.account));
  for (const leg of revenue) {
    if (leg.taxCents === null) continue;
    expect(leg.taxCents, `${eventKey}: a revenue leg's split is not the per-line formula`).toBe(perLineTaxCents(leg.grossCents!));
    expect(leg.netCents! + leg.taxCents).toBe(leg.grossCents);
  }
  return {
    revenueGrossCents: revenue.reduce((sum, leg) => sum + credit(leg.side, leg.grossCents ?? leg.amountCents), 0),
    gstCents: legs.filter((leg) => leg.account === "GST_PAYABLE").reduce((sum, leg) => sum + credit(leg.side, leg.amountCents), 0),
    taxCodes: [...new Set(revenue.map((leg) => leg.taxCode))],
  };
}

async function expectCensusAgrees(bookingId: string) {
  const row = await census.readBookingLedgerCensusRow(prisma, bookingId);
  const evaluation = census.evaluateWithJournal(row!);
  const journal = evaluation.identities.find((identity) => identity.identity === "JOURNAL")!;
  expect(journal.status, `JOURNAL on ${bookingId}: ${JSON.stringify(journal)}`).toBe("AGREE");
  expect(evaluation.integrity.filter((finding) => finding.kind === "UNBRIDGED_CHARGE_LINE")).toEqual([]);
}

/** The door's own context, resolved as a door resolves it: on the current clock, with the schedule read from the database. */
async function doorJournal(): Promise<MemberMoneyPostingContext> {
  const journal = await doors.resolveBookingMoneyPostingContext();
  if ("inactive" in journal) throw new Error(`The journal is inactive on the race database: ${journal.detail}`);
  return journal;
}

/** Xero's ids, unique across the file as Xero's own are. */
let documents = 0;

/** Every document the fake Xero was sent, in order. */
type Sent = { kind: "invoice" | "credit-note"; document: XeroDocument };

/**
 * The real senders against a fake Xero (the `xero-refund-request-note-void`
 * pattern): the client, the contact, the contact-repair wrapper and the refund
 * settlement are stood in for, and every create records the document it was
 * given. A call to anything else fails the test, so a sender that reaches
 * further than this proof expects says so.
 */
async function withFakeXero<T>(sent: Sent[], run: () => Promise<T>): Promise<T> {
  const apiClient = await import("@/lib/xero-api-client");
  const contacts = await import("@/lib/xero-contacts");
  const invoicedParty = await import("@/lib/organisation-xero-contacts");
  const invoicePayments = await import("@/lib/xero-invoice-payments");
  const handlers: Record<string, (...args: never[]) => unknown> = {
    createInvoices: async (_tenant: string, body: { invoices: XeroDocument[] }) => {
      const invoice = body.invoices[0]!;
      sent.push({ kind: "invoice", document: invoice });
      const total = documentMoney(invoice).grossCents / 100;
      const id = `${PREFIX}xero-invoice-${++documents}`;
      return { body: { invoices: [{ invoiceID: id, invoiceNumber: `INV-${id}`, status: "AUTHORISED", total, amountDue: total, amountPaid: 0 }] } };
    },
    createPayment: async () => ({ body: { payments: [{ paymentID: `${PREFIX}xero-payment-${++documents}` }] } }),
    createCreditNotes: async (_tenant: string, body: { creditNotes: XeroDocument[] }) => {
      const note = body.creditNotes[0]!;
      sent.push({ kind: "credit-note", document: note });
      const total = documentMoney(note).grossCents / 100;
      const id = `${PREFIX}xero-note-${++documents}`;
      return { body: { creditNotes: [{ creditNoteID: id, creditNoteNumber: `CN-${id}`, status: "AUTHORISED", total, remainingCredit: total, payments: [] }] } };
    },
    createCreditNoteAllocation: async () => ({ body: { allocations: [{ amount: 0 }] } }),
    getCreditNote: async () => ({ body: { creditNotes: [] } }),
  };
  const accountingApi = new Proxy(handlers, {
    get(target, name: string) {
      if (name in target) return target[name];
      if (name === "then") return undefined;
      return () => {
        throw new Error(`The fake Xero was asked for ${name}, which this proof does not stand in for`);
      };
    },
  });
  const spies = [
    vi.spyOn(apiClient, "getAuthenticatedXeroClient").mockResolvedValue({ xero: { accountingApi }, tenantId: "tenant-4632" } as never),
    vi.spyOn(apiClient, "callXeroApi").mockImplementation(((call: () => unknown) => call()) as never),
    vi.spyOn(invoicedParty, "findOrCreateXeroContactForInvoicedParty").mockResolvedValue("contact-4632"),
    vi.spyOn(contacts, "retryXeroWriteWithContactRepair").mockImplementation((async (options: { run: (input: { contactId: string }) => unknown; currentContactId: string }) =>
      options.run({ contactId: options.currentContactId })) as never),
    vi.spyOn(invoicePayments, "resolveRefundSettlement").mockResolvedValue({ kind: "unsettled", reason: "race-4632" }),
  ];
  try {
    return await run();
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}

/** One document, raised by the real sender `run` drives. */
async function sentBy(run: () => Promise<unknown>): Promise<XeroDocument> {
  const sent: Sent[] = [];
  await withFakeXero(sent, run);
  expect(sent, "the sender sent no document, or more than one").toHaveLength(1);
  return sent[0]!.document;
}

/** A cancel as every cancel path runs one: lock(1), a status-guarded claim, then the cancellation poster. */
async function cancelDoor(bookingId: string, keptCents: number, journal: BookingJournalContext): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    const claimed = await tx.booking.updateMany({ where: { id: bookingId, status: { not: "CANCELLED" } }, data: { status: "CANCELLED" } });
    expect(claimed.count).toBe(1);
    await cancellationSync.postCancellationLedgerLines({ store: tx, journal, bookingId, lodgeId: names.lodgeId, keptCents, site: "race-4632" });
  }, { maxWait: 30_000, timeout: 60_000 });
}

let sequence = 0;
/** Two guests, two nights each at 57.50, made on `createdAt`. */
async function newBooking(createdAt: Date): Promise<string> {
  const id = `${PREFIX}b${++sequence}`;
  const night = { priceCents: NIGHT, priceSource: "SOLD" } as const;
  await createHistoryBooking(prisma, names, id, {
    payment: { amountCents: PRICE, source: "STRIPE", intent: `pi_${id}` },
    guests: [[night, night], [night, night]],
  });
  // The tax anchor (decision A): set by hand, since the row's default is the engine's own clock, not the frozen one.
  await prisma.booking.update({ where: { id }, data: { createdAt } });
  return id;
}

function adminRequest(): Request {
  return new Request("http://localhost/api/admin/club-tax", { method: "PUT", headers: { "user-agent": "race-4632" } });
}

/** The unregistered period from CHANGE_DATE, scheduled once by the one writer while today is still before it. */
let scheduled = false;
async function scheduleUnregisteredChange(): Promise<void> {
  if (scheduled) return;
  vi.setSystemTime(new Date(FROZEN_TEST_CLOCK_BASE_ISO));
  expect(await taxWrite.earliestClubTaxChangeDate()).toBe(CHANGE_DATE);
  const outcome = await taxWrite.scheduleClubTaxChange({
    change: { gstRegistered: false, taxRateBasisPoints: 0, xeroTaxType: null, effectiveFrom: CHANGE_DATE as never },
    actingMemberId: names.officerId,
    request: adminRequest(),
  });
  expect(outcome).toEqual({ changed: true, period: { gstRegistered: false, taxRateBasisPoints: 0, xeroTaxType: null, effectiveFrom: CHANGE_DATE } });
  scheduled = true;
}

(RUN ? describe : describe.skip)("a club tax change keeps the old treatment on earlier bookings — real PostgreSQL (#4632)", { timeout: 180_000 }, () => {
  beforeAll(async () => {
    assertSafeRaceDbUrl(RACE_DB_URL, "Club tax schedule");
    process.env.DATABASE_URL = RACE_DB_URL;
    ({ prisma } = await import("@/lib/prisma"));
    doors = await import("@/lib/member-money/doors");
    cancellationSync = await import("@/lib/booking-ledger-cancellation-sync");
    census = await import("@/lib/booking-ledger-projection-census-store");
    taxWrite = await import("@/lib/club-tax-settings-write");
    anchors = await import("@/lib/xero-tax-anchors");
    await cleanup();
    // The proof reasons from the code baseline: no other suite's period may be standing.
    expect(await prisma.clubTaxSettings.count(), "ClubTaxSettings holds rows this suite did not write").toBe(0);
    await seedHistoryFixtures(prisma, PREFIX);
  }, 120_000);

  beforeEach(() => {
    vi.setSystemTime(new Date(FROZEN_TEST_CLOCK_BASE_ISO));
  });

  async function cleanup() {
    await prisma.xeroObjectLink.deleteMany({ where: { localId: { startsWith: PREFIX } } });
    await prisma.xeroSyncOperation.deleteMany({ where: { localId: { startsWith: PREFIX } } });
    await prisma.auditLog.deleteMany({ where: { actorMemberId: { in: [names.officerId, names.memberId] } } });
    await cleanHistories(prisma, PREFIX);
    await prisma.clubTaxSettings.deleteMany({ where: { OR: [{ updatedByMemberId: names.officerId }, { id: { startsWith: PREFIX } }] } });
    scheduled = false;
  }

  afterAll(async () => {
    vi.setSystemTime(new Date(FROZEN_TEST_CLOCK_BASE_ISO));
    if (prisma) await cleanup();
  }, 120_000);

  it("a booking made before the change keeps registered 15% OUTPUT2 Inclusive through its invoice, an edit and a cancel; journal and Xero agree", async () => {
    const id = await newBooking(MADE_BEFORE);
    await settleHistoryByCard(id, PRICE);
    const charge = await eventMoney(`booking-charge:${id}`);
    expect(charge).toEqual({ revenueGrossCents: PRICE, gstCents: perLineTaxCents(PRICE), taxCodes: [TAX_CODE] });

    // The one writer schedules an unregistered period from tomorrow, and audits it.
    await scheduleUnregisteredChange();
    const audit = await prisma.auditLog.findMany({ where: { actorMemberId: names.officerId, action: "CLUB_TAX_TREATMENT_SCHEDULED" }, select: { category: true } });
    expect(audit).toEqual([{ category: "admin" }]);

    // The doors now run after the change: today's treatment is unregistered, the booking's is not.
    vi.setSystemTime(DOOR_DAY);
    const journal = await doorJournal();
    expect(journal.effectiveDate).toBe("2026-07-03");
    expect(await anchors.resolveXeroTaxRendering({ kind: "instant", at: DOOR_DAY })).toEqual({ lineAmountTypes: "NoTax" });
    expect(await anchors.resolveXeroTaxRendering({ kind: "booking", bookingId: id })).toEqual({ lineAmountTypes: "Inclusive", taxType: "OUTPUT2" });

    // The primary invoice, raised after the change (a delayed outbox run), against R01.
    const { createXeroInvoiceForBooking } = await import("@/lib/xero-booking-invoices");
    const invoice = documentMoney(await sentBy(() => createXeroInvoiceForBooking(id)));
    expect(invoice).toEqual({ lineAmountTypes: "Inclusive", taxTypes: ["OUTPUT2"], grossCents: PRICE, perLineTaxCents: charge.gstCents });
    expect(invoice.grossCents).toBe(charge.revenueGrossCents);
    const invoiceId = (await prisma.payment.findUniqueOrThrow({ where: { id: `${id}-payment` }, select: { xeroInvoiceId: true } })).xeroInvoiceId;
    expect(invoiceId, "the invoice sender recorded no Xero invoice on the payment").toBeTruthy();

    // The edit: a guest removed and a change fee charged, through the edit chokepoint with the door's real context.
    const modificationId = `${id}-edit`;
    await postHistoryEdit(prisma, names, id, modificationId, { removeGuestId: `${id}-g2`, changeFeeCents: CHANGE_FEE, journal });
    const edit = await eventMoney(`modification:${modificationId}`);
    // Its fresh charges (the remaining guest, the fee) are split under the booking's treatment, not today's.
    expect(edit.taxCodes).toEqual([TAX_CODE]);
    expect(edit).toEqual({ revenueGrossCents: -(GUEST - CHANGE_FEE), gstCents: -(perLineTaxCents(GUEST) - perLineTaxCents(CHANGE_FEE)), taxCodes: [TAX_CODE] });
    await expectCensusAgrees(id);

    // The edit's credit note, raised by the real sender after the change: itemised, the old treatment on every line.
    const { createXeroCreditNoteForModification } = await import("@/lib/xero-modification-credit-notes");
    const editNote = documentMoney(await sentBy(() => createXeroCreditNoteForModification({
      bookingId: id, refundAmountCents: GUEST - CHANGE_FEE, bookingModificationId: modificationId, format: CLUB_FORMAT_TEST,
    })));
    expect(editNote).toEqual({ lineAmountTypes: "Inclusive", taxTypes: ["OUTPUT2"], grossCents: GUEST - CHANGE_FEE, perLineTaxCents: -edit.gstCents });
    expect(editNote.grossCents).toBe(-edit.revenueGrossCents);

    // The cancel, keeping 46.00, through the cancellation chokepoint with the door's real context.
    const cancelJournal = await doorJournal();
    expect(cancelJournal.effectiveDate > CHANGE_DATE).toBe(true);
    await cancelDoor(id, KEPT, cancelJournal);
    const cancel = await eventMoney(`cancellation:${id}:0`);
    const refundCents = GUEST + CHANGE_FEE - KEPT;
    expect(cancel).toEqual({ revenueGrossCents: -refundCents, gstCents: -perLineTaxCents(refundCents), taxCodes: [TAX_CODE] });
    await expectCensusAgrees(id);

    // The cancellation's refund credit note, raised by the real sender after the change.
    const { createXeroCreditNote } = await import("@/lib/xero-credit-notes");
    const refundNote = documentMoney(await sentBy(() => createXeroCreditNote(`${id}-payment`, refundCents)));
    expect(refundNote).toEqual({ lineAmountTypes: "Inclusive", taxTypes: ["OUTPUT2"], grossCents: refundCents, perLineTaxCents: -cancel.gstCents });
    expect(refundNote.grossCents).toBe(-cancel.revenueGrossCents);

    // Across the booking's life, the journal's GST is what its documents' lines carry.
    const gstPosted = await prisma.memberMoneyLine.findMany({ where: { bookingId: id, account: "GST_PAYABLE" }, select: { side: true, amountCents: true } });
    const gstNet = gstPosted.reduce((sum, leg) => sum + (leg.side === "CREDIT" ? leg.amountCents : -leg.amountCents), 0);
    expect(gstNet).toBe(invoice.perLineTaxCents - editNote.perLineTaxCents - refundNote.perLineTaxCents);
    expect(gstNet).toBe(perLineTaxCents(KEPT));
  });

  it("a booking made on the change date renders NoTax with no tax type, and posts no GST", async () => {
    await scheduleUnregisteredChange();
    const id = await newBooking(MADE_ON_CHANGE);
    vi.setSystemTime(DOOR_DAY);
    await settleHistoryByCard(id, PRICE);

    expect(await anchors.resolveXeroTaxRendering({ kind: "booking", bookingId: id })).toEqual({ lineAmountTypes: "NoTax" });
    const charge = await eventMoney(`booking-charge:${id}`);
    expect(charge).toEqual({ revenueGrossCents: PRICE, gstCents: 0, taxCodes: [null] });
    expect(await prisma.memberMoneyLine.count({ where: { bookingId: id, account: "GST_PAYABLE" } })).toBe(0);
    const revenue = await prisma.memberMoneyLine.findMany({ where: { bookingId: id, account: "BOOKING_REVENUE" }, select: { amountCents: true, grossCents: true, netCents: true, taxCents: true, taxCode: true } });
    expect(revenue).toEqual([{ amountCents: PRICE, grossCents: null, netCents: null, taxCents: null, taxCode: null }]);

    const { createXeroInvoiceForBooking } = await import("@/lib/xero-booking-invoices");
    const document = await sentBy(() => createXeroInvoiceForBooking(id));
    expect(document.lineItems!.length).toBeGreaterThan(0);
    expect(document.lineItems!.every((line) => !("taxType" in line))).toBe(true);
    expect(documentMoney(document)).toMatchObject({ lineAmountTypes: "NoTax", taxTypes: [null], grossCents: PRICE });
    await expectCensusAgrees(id);
  });

  it("the database refuses a registered period without a Xero code and an unregistered one with a code", async () => {
    const insert = (id: string, effectiveFrom: string, registered: boolean, code: string | null) =>
      prisma.$executeRaw`INSERT INTO "ClubTaxSettings" ("id", "gstRegistered", "taxRateBasisPoints", "xeroTaxType", "effectiveFrom", "updatedAt")
        VALUES (${id}, ${registered}, ${registered ? RATE : 0}, ${code}, ${effectiveFrom}::date, now())`;
    try {
      await expect(insert(`${PREFIX}null-code`, "2101-01-01", true, null)).rejects.toThrow(/club_tax_xero_tax_type/);
      await expect(insert(`${PREFIX}blank-code`, "2101-02-01", true, "   ")).rejects.toThrow(/club_tax_xero_tax_type/);
      await expect(insert(`${PREFIX}unregistered-code`, "2101-03-01", false, "OUTPUT2")).rejects.toThrow(/club_tax_xero_tax_type/);
      // The column's default is the baseline code, so an unregistered row that leaves it out is refused too.
      await expect(prisma.$executeRaw`INSERT INTO "ClubTaxSettings" ("id", "gstRegistered", "taxRateBasisPoints", "effectiveFrom", "updatedAt")
        VALUES (${`${PREFIX}unregistered-default`}, false, 0, '2101-04-01'::date, now())`).rejects.toThrow(/club_tax_xero_tax_type/);
      // The two well-formed shapes are accepted.
      expect(await insert(`${PREFIX}registered`, "2101-05-01", true, "OUTPUT2")).toBe(1);
      expect(await insert(`${PREFIX}unregistered`, "2101-06-01", false, null)).toBe(1);
      expect(await prisma.clubTaxSettings.count({ where: { id: { startsWith: PREFIX } } })).toBe(2);
    } finally {
      await prisma.clubTaxSettings.deleteMany({ where: { id: { startsWith: PREFIX } } });
    }
  });

  it("the database refuses a second period on the same start date", async () => {
    const insert = (id: string, registered: boolean, code: string | null) =>
      prisma.$executeRaw`INSERT INTO "ClubTaxSettings" ("id", "gstRegistered", "taxRateBasisPoints", "xeroTaxType", "effectiveFrom", "updatedAt")
        VALUES (${id}, ${registered}, ${registered ? RATE : 0}, ${code}, '2102-01-01'::date, now())`;
    try {
      expect(await insert(`${PREFIX}first`, false, null)).toBe(1);
      await expect(insert(`${PREFIX}second`, true, "OUTPUT2")).rejects.toThrow(/ClubTaxSettings_effectiveFrom_key/);
      expect(await prisma.clubTaxSettings.count({ where: { id: { startsWith: PREFIX } } })).toBe(1);
    } finally {
      await prisma.clubTaxSettings.deleteMany({ where: { id: { startsWith: PREFIX } } });
    }
  });
});
