import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { formatDateOnly, formatDateOnlyForTimeZone } from "@/lib/date-only";
import { frozenTestNow } from "@/lib/__tests__/helpers/clock";
import { expectClubTimeZonePremise } from "@/lib/__tests__/helpers/club-time-zone";
import { requireClubTimeZone } from "@/lib/club-time";
import { xeroDocumentDateForClubToday } from "@/lib/xero-provider-dates";

/**
 * Every Xero document date derived from an INSTANT is the club's calendar day
 * (#2834, INV-DATE-019).
 *
 * New Zealand runs 12-13 hours ahead of UTC, so for roughly the first half of
 * every club day the UTC calendar date is still yesterday. Truncating an instant
 * to its UTC day therefore dated a whole morning's invoices, credit notes,
 * payments and allocations one day early — and a document's issue date decides
 * which GST period and financial year it falls in, so at a month or 1 April
 * boundary the document moved period.
 *
 * #2697 closed the two `Booking.createdAt` consumers. This suite covers the rest
 * of the family, which reached the same forbidden pattern one indirection away
 * from the spelling: through the `formatDate()` wrapper that used to live in
 * `xero-invoice-helpers.ts` and WAS `toISOString().split("T")[0]`, and through a
 * private clone of it in `membership-cancellation-xero.ts`. #2684 retired both,
 * so the date-only encoding is now spelled once, as `formatDateOnly`.
 *
 * **The instants are chosen so a wrong zone FAILS them.** A merely "divergent"
 * instant is not enough: 21:30Z sits ~9.5h into a 12h window and passes under any
 * zone from about UTC+10 upwards, daylight saving or not. Each case below is
 * either the first instant of a club day (which a shallower zone gets wrong) or
 * 00:30 NZDT (which a fixed +12 zone with no daylight saving gets wrong).
 *
 * Three surfaces need scaffolding too heavy to rebuild here, so their coverage
 * lives in their own suites: `xero-booking-invoice.test.ts` (the Stripe payment
 * recorded against a freshly raised booking invoice),
 * `xero-applied-credit-deallocation.test.ts` (the recreated allocation) and
 * `membership-cancellation-xero.test.ts` (the cancellation credit note and its
 * allocation). Everything else is here — including the group-settlement invoice
 * (below, "a group-settlement invoice") and the applied-credit remainder note
 * (below, "the remainder note minted for applied credit"), whose own suites
 * carry no #2834 coverage.
 */

const mocks = vi.hoisted(() => ({
  paymentFindUnique: vi.fn(),
  paymentUpdate: vi.fn(),
  bookingFindUnique: vi.fn(),
  bookingModificationFindUnique: vi.fn(),
  memberFindUnique: vi.fn(),
  bookingFindMany: vi.fn(),
  seasonFindFirst: vi.fn(),
  settlementFindUnique: vi.fn(),
  settlementUpdate: vi.fn(),
  getHutFeeItemCodeMap: vi.fn(),
  enqueueSettlementVoid: vi.fn(),
  memberCreditAggregate: vi.fn(),
  memberCreditFindMany: vi.fn(),
  memberCreditUpdateMany: vi.fn(),
  creditNoteAllocationGroupBy: vi.fn(),
  creditNoteAllocationUpsert: vi.fn(),
  creditNoteAllocationFindUnique: vi.fn(),
  lockMemberCreditLedger: vi.fn(),
  assertNoAppliedCreditDeallocationFence: vi.fn(),
  xeroObjectLinkFindFirst: vi.fn(),
  xeroObjectLinkFindMany: vi.fn(),
  xeroSyncOperationUpdate: vi.fn(),
  chargeFindUnique: vi.fn(),
  chargeUpdate: vi.fn(),
  transaction: vi.fn(),
  startXeroSyncOperation: vi.fn(),
  completeXeroSyncOperation: vi.fn(),
  failXeroSyncOperation: vi.fn(),
  upsertXeroObjectLink: vi.fn(),
  findCanonicalPaymentRefundCreditNote: vi.fn(),
  sumCoveredRefundCreditNoteCents: vi.fn(),
  getAuthenticatedXeroClient: vi.fn(),
  callXeroApi: vi.fn(),
  getResolvedAccountMapping: vi.fn(),
  getAccountMapping: vi.fn(),
  getEntranceFeeContext: vi.fn(),
  findOrCreateXeroContact: vi.fn(),
  retryXeroWriteWithContactRepair: vi.fn(),
  notifyXeroSyncError: vi.fn(),
  accountingApi: {
    createInvoices: vi.fn(),
    getInvoices: vi.fn(),
    createPayments: vi.fn(),
    createCreditNoteAllocation: vi.fn(),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: mocks.transaction,
    payment: { findUnique: mocks.paymentFindUnique, update: mocks.paymentUpdate },
    booking: {
      findUnique: mocks.bookingFindUnique,
      findMany: mocks.bookingFindMany,
    },
    bookingModification: { findUnique: mocks.bookingModificationFindUnique },
    member: { findUnique: mocks.memberFindUnique },
    season: { findFirst: mocks.seasonFindFirst },
    groupBookingSettlement: {
      findUnique: mocks.settlementFindUnique,
      update: mocks.settlementUpdate,
    },
    xeroObjectLink: {
      findFirst: mocks.xeroObjectLinkFindFirst,
      findMany: mocks.xeroObjectLinkFindMany,
    },
    memberCredit: {
      aggregate: mocks.memberCreditAggregate,
      findMany: mocks.memberCreditFindMany,
      updateMany: mocks.memberCreditUpdateMany,
    },
    memberCreditNoteAllocation: {
      groupBy: mocks.creditNoteAllocationGroupBy,
      upsert: mocks.creditNoteAllocationUpsert,
      findUnique: mocks.creditNoteAllocationFindUnique,
    },
    xeroSyncOperation: { update: mocks.xeroSyncOperationUpdate },
    membershipSubscriptionCharge: {
      findUnique: mocks.chargeFindUnique,
      update: mocks.chargeUpdate,
    },
  },
}));

vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/xero-links", () => ({
  buildXeroInvoiceUrl: (id: string) => `https://xero.test/invoice/${id}`,
  buildXeroCreditNoteUrl: (id: string) => `https://xero.test/credit-note/${id}`,
  stripXeroOrgShortCode: (url: string) => url,
}));

vi.mock("@/lib/xero-error-alert", () => ({
  notifyXeroSyncError: mocks.notifyXeroSyncError,
}));

// `buildXeroIdempotencyKey` and `sanitizeForJson` stay real, so the recorded
// operation carries the key production would carry — which is what the
// idempotency analysis on #2834 turns on.
vi.mock("@/lib/xero-sync", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/xero-sync")>();
  return {
    ...actual,
    startXeroSyncOperation: mocks.startXeroSyncOperation,
    completeXeroSyncOperation: mocks.completeXeroSyncOperation,
    failXeroSyncOperation: mocks.failXeroSyncOperation,
    upsertXeroObjectLink: mocks.upsertXeroObjectLink,
    findCanonicalPaymentRefundCreditNote: mocks.findCanonicalPaymentRefundCreditNote,
    sumCoveredRefundCreditNoteCents: mocks.sumCoveredRefundCreditNoteCents,
  };
});

vi.mock("@/lib/xero-api-client", () => ({
  getAuthenticatedXeroClient: mocks.getAuthenticatedXeroClient,
  callXeroApi: mocks.callXeroApi,
}));

vi.mock("@/lib/xero-mappings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/xero-mappings")>();
  return {
    ...actual,
    getResolvedAccountMapping: mocks.getResolvedAccountMapping,
    getAccountMapping: mocks.getAccountMapping,
    getEntranceFeeContext: mocks.getEntranceFeeContext,
    getHutFeeItemCodeMap: mocks.getHutFeeItemCodeMap,
  };
});

vi.mock("@/lib/xero-group-settlement-void-outbox", () => ({
  enqueueXeroGroupSettlementInvoiceVoidOperation: mocks.enqueueSettlementVoid,
}));

vi.mock("@/lib/member-credit", () => ({
  lockMemberCreditLedger: mocks.lockMemberCreditLedger,
  deriveBookingAppliedCreditCents: vi.fn(),
}));

vi.mock("@/lib/xero-applied-credit-operation-serialization", () => ({
  assertNoAppliedCreditDeallocationFence: mocks.assertNoAppliedCreditDeallocationFence,
}));

vi.mock("@/lib/xero-contacts", () => ({
  findOrCreateXeroContact: mocks.findOrCreateXeroContact,
  retryXeroWriteWithContactRepair: mocks.retryXeroWriteWithContactRepair,
}));

import {
  allocateCreditNoteToInvoice,
  createUnappliedXeroCreditNote,
  createXeroCreditNote,
} from "@/lib/xero-credit-notes";
import { allocateAppliedCreditForBooking } from "@/lib/xero-applied-credit-allocation";
import { createXeroEntranceFeeInvoice } from "@/lib/xero-entrance-fee-invoices";
import { createXeroInvoiceForGroupSettlement } from "@/lib/xero-group-settlement-invoices";
import {
  buildRefundCreditNotePayment,
  createXeroPaymentForInvoice,
} from "@/lib/xero-invoice-payments";
import { createXeroCreditNoteForModification } from "@/lib/xero-modification-credit-notes";
import { createXeroMembershipSubscriptionInvoice } from "@/lib/xero-subscription-invoices";
import { createXeroSupplementaryInvoice } from "@/lib/xero-supplementary-invoices";

/**
 * Each case is an instant whose UTC calendar day is the day BEFORE the club's,
 * chosen so that reading it in the wrong zone produces the wrong answer:
 *
 * - `NZST_CLUB_DAY_START` is 00:00 in Pacific/Auckland at UTC+12. Any zone
 *   shallower than +12 (Australia/Brisbane at +10, say) returns the previous day.
 * - `NZDT_JUST_AFTER_MIDNIGHT` is 00:30 in Pacific/Auckland at UTC+13. A fixed
 *   +12 zone with no daylight saving returns the previous day, so this pins the
 *   daylight-saving offset rather than merely "somewhere east of UTC".
 *
 * `clubDayPlus30` is the thirtieth calendar day after `clubDay`, written out
 * rather than computed: a helper here would re-run production's own day-stepping
 * algorithm, so a shared error would pass on both sides.
 */
const CLUB_DAY_CASES = [
  {
    label: "NZST (UTC+12), the first instant of a club day",
    instant: new Date("2026-06-14T12:00:00.000Z"),
    utcDay: "2026-06-14",
    clubDay: "2026-06-15",
    clubDayPlus30: "2026-07-15",
    // Reading this instant in a zone shallower than UTC+12 returns the UTC day.
    wrongZone: "Australia/Brisbane", // UTC+10, no daylight saving
  },
  {
    label: "NZDT (UTC+13), 00:30 on a club day",
    instant: new Date("2026-01-14T11:30:00.000Z"),
    utcDay: "2026-01-14",
    clubDay: "2026-01-15",
    clubDayPlus30: "2026-02-14",
    // A fixed +12 with no daylight saving is 30 minutes short of the club day.
    wrongZone: "Etc/GMT-12", // UTC+12 year-round; POSIX sign, so -12 means +12
  },
] as const;

/**
 * The club's zone, named rather than left to the legacy helpers'
 * `APP_TIME_ZONE` default, which #3123 deletes. It is New Zealand because that
 * is the premise this whole file rests on, and `expectClubTimeZonePremise()`
 * above asserts the environment still agrees — so this constant cannot drift
 * out of step and leave the divergence cases measuring nothing.
 */
const CLUB_ZONE = "Pacific/Auckland";

const SENTINEL = "sentinel-stop";

function pinClubMorning(instant: Date) {
  // The root freeze pins midday NZ (2026-07-01T00:00:00.000Z), where the UTC day
  // and the club day agree — exactly the window this defect does NOT live in. So
  // set the divergent instant per test.
  //
  // The pin must be undone by hand: the root `beforeEach` re-freezes only when
  // the clock has been handed back to the real calendar, so it never overwrites
  // a deliberate pin — and never restores one either (docs/TESTING.md rule 4).
  // The file-level `afterEach` below hands it back after every test, and the
  // last test in the file proves that actually happens.
  vi.setSystemTime(instant);
}

function enqueuedOperation(index = 0) {
  return mocks.startXeroSyncOperation.mock.calls[index][0];
}

describe("#2834 the premise: the club zone is New Zealand and each instant really is divergent", () => {
  it("runs with the club time zone actually set to New Zealand", () => {
    expectClubTimeZonePremise();
  });

  it.each(CLUB_DAY_CASES)(
    "$label: the UTC day is the day before the club day",
    ({ instant, utcDay, clubDay }) => {
      // Both readings are executed, not asserted against each other as literals:
      // `expect(utcDay).not.toBe(clubDay)` compares two hard-coded strings and
      // can never fail, so it would keep passing while the fixture drifted out
      // of the divergence window and quietly stopped testing anything.
      expect(instant.toISOString().slice(0, 10)).toBe(utcDay);
      expect(formatDateOnlyForTimeZone(instant, CLUB_ZONE)).toBe(clubDay);
    },
  );

  it.each(CLUB_DAY_CASES)(
    "$label: reading the same instant in the wrong zone gives the UTC day, so a wrong zone FAILS this suite",
    ({ instant, utcDay, wrongZone }) => {
      // This is the load-bearing claim of the docblock above, made executable.
      // 21:30Z sits about 9.5h into a 12h window and reads as the club day under
      // any zone from roughly UTC+10 upwards; drifting a fixture back to
      // something like that would leave every test in this file green while the
      // discrimination silently vanished. Brisbane (+10, no DST) catches the
      // NZST case; Etc/GMT-12 (a fixed +12, no DST) catches the NZDT one.
      expect(formatDateOnlyForTimeZone(instant, wrongZone)).toBe(utcDay);
    },
  );
});

describe("#2834 the other half of the premise: a `@db.Date` receiver is read by TRUNCATION, which is a different operation", () => {
  // Several tests below assert that a `@db.Date` value — a lodge night, an
  // organiser booking's check-in — reaches Xero unshifted, and cite INV-DATE-010
  // for it. Those assertions are honest as positive statements, but on their own
  // they cannot fail the mutation they look like they guard: a `@db.Date` is UTC
  // midnight, and in Auckland (as in every zone ahead of UTC) UTC midnight still
  // falls on the same calendar day, so converting one of those receivers to
  // `formatDateOnlyForTimeZone` would leave every one of them green.
  //
  // So the contrast is made decidable here instead, in a zone where the two
  // operations disagree. Read those tests as "the value is preserved", and this
  // block as "and these really are two different derivations".
  const lodgeNight = new Date("2026-08-03T00:00:00.000Z");

  it("truncation reads back the calendar day the value encodes", () => {
    expect(formatDateOnly(lodgeNight)).toBe("2026-08-03");
  });

  it("zone conversion returns a DIFFERENT day for the same value, west of UTC", () => {
    // 19:00 on 2 August in Chicago. Swapping a `@db.Date` receiver onto the
    // zone-aware helper would move a lodge night by a day for that reader.
    expect(formatDateOnlyForTimeZone(lodgeNight, "America/Chicago")).toBe(
      "2026-08-02",
    );
  });

  it("but the two agree in the club's own zone, which is exactly why the assertions below cannot decide it alone", () => {
    expect(formatDateOnlyForTimeZone(lodgeNight, CLUB_ZONE)).toBe("2026-08-03");
    expect(formatDateOnly(lodgeNight)).toBe("2026-08-03");
  });
});

beforeEach(() => {
  vi.resetAllMocks();

  mocks.getAuthenticatedXeroClient.mockResolvedValue({
    xero: { accountingApi: mocks.accountingApi },
    tenantId: "tenant_1",
  });
  mocks.findOrCreateXeroContact.mockResolvedValue("contact_1");
  mocks.getResolvedAccountMapping.mockResolvedValue({
    code: "200",
    itemCode: undefined,
    codeExplicitlyConfigured: false,
  });
  mocks.getAccountMapping.mockResolvedValue("606");
  mocks.startXeroSyncOperation.mockResolvedValue({ id: "op_1" });
  mocks.completeXeroSyncOperation.mockResolvedValue(undefined);
  mocks.failXeroSyncOperation.mockResolvedValue(undefined);
  mocks.upsertXeroObjectLink.mockResolvedValue(undefined);
  mocks.findCanonicalPaymentRefundCreditNote.mockResolvedValue(null);
  mocks.sumCoveredRefundCreditNoteCents.mockResolvedValue(0);
  mocks.xeroObjectLinkFindFirst.mockResolvedValue(null);
  mocks.xeroObjectLinkFindMany.mockResolvedValue([]);
  mocks.seasonFindFirst.mockResolvedValue(null);
  mocks.getHutFeeItemCodeMap.mockResolvedValue(new Map());
  mocks.callXeroApi.mockImplementation((run: () => unknown) => run());
  mocks.accountingApi.createPayments.mockResolvedValue({
    body: { payments: [{ paymentID: "pay_1" }] },
  });
  mocks.accountingApi.createCreditNoteAllocation.mockResolvedValue({ body: {} });
  mocks.accountingApi.getInvoices.mockResolvedValue({ body: { invoices: [] } });
  mocks.accountingApi.createInvoices.mockResolvedValue({
    body: { invoices: [{ invoiceID: "inv_new", invoiceNumber: "INV-9" }] },
  });
});

afterEach(() => {
  // Hand the clock back so the root `beforeEach` re-freezes the DEFAULT instant
  // before the next test. `ensureFrozenTestClock()` returns early whenever
  // anything is already mocking `Date`, so a bare `vi.setSystemTime` in a test
  // body is never restored on its own and leaks into every test after it
  // (docs/TESTING.md rule 4). The last test in this file proves this works.
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Payments — bank-reconciliation input, and the date decides the GST period the
// cash falls in.
// ---------------------------------------------------------------------------

describe.each(CLUB_DAY_CASES)(
  "a Xero payment against an invoice — $label",
  ({ instant, utcDay, clubDay }) => {
    it("is dated on the club's calendar day", async () => {
      pinClubMorning(instant);

      await createXeroPaymentForInvoice({
        localModel: "Payment",
        localId: "pay_local",
        invoiceId: "inv_1",
        amountCents: 12500,
        idempotencyKey: "payment:pay_local:invoice-payment:v1",
        reference: "Stripe pi_1",
        role: "INVOICE_PAYMENT",
      });

      const sent = mocks.accountingApi.createPayments.mock.calls[0][1];
      expect(sent.payments[0].date).toBe(clubDay);
      expect(sent.payments[0].date).not.toBe(utcDay);
      // No assertion about the idempotency key belongs here. On this path the
      // key is a caller-supplied parameter passed straight through, so any
      // assertion about it holds under every possible implementation of the
      // date derivation, including the pre-#2834 one — it would read as
      // evidence for the cross-version dedupe claim while proving nothing. The
      // falsifiable version of that claim is on a key production builds itself:
      // `xero-applied-credit-deallocation.test.ts` asserts the recreate key
      // contains no `yyyy-mm-dd` substring.
    });
  },
);

describe.each(CLUB_DAY_CASES)(
  "a Stripe-refund credit-note payment — $label",
  ({ instant, utcDay, clubDay }) => {
    it("is dated on the club's calendar day", () => {
      pinClubMorning(instant);

      // CT-5 (#2869) made the builder a pure function of its inputs, so the
      // clock read moved to the caller. What is asserted here is therefore the
      // caller's DERIVATION — `xeroDocumentDateForClubToday(<the club zone>)`,
      // character-for-character what `createXeroRefundPaymentForInvoice` and
      // `createXeroRefundCreditNote` pass — plus the pass-through itself.
      const payment = buildRefundCreditNotePayment({
        paymentId: "pay_local",
        creditNoteId: "cn_1",
        refundAmountCents: 5000,
        bankCode: "606",
        paymentDate: xeroDocumentDateForClubToday(
          requireClubTimeZone(CLUB_ZONE),
        ),
      });

      expect(payment.date).toBe(clubDay);
      expect(payment.date).not.toBe(utcDay);
    });
  },
);

// ---------------------------------------------------------------------------
// Credit notes — the half the issue calls more serious, because the date decides
// the GST period and, at 1 April, the financial year.
// ---------------------------------------------------------------------------

describe.each(CLUB_DAY_CASES)(
  "a refund credit note — $label",
  ({ instant, utcDay, clubDay }) => {
    it("is dated on the club's calendar day, while the stay dates stay date-only", async () => {
      pinClubMorning(instant);
      mocks.paymentFindUnique.mockResolvedValue({
        id: "pay_local",
        xeroInvoiceId: "inv_1",
        xeroRefundCreditNoteId: null,
        refundedAmountCents: 5000,
        booking: {
          id: "booking_1234abcd",
          memberId: "mem_1",
          // `@db.Date` lodge nights: UTC midnight is the ENCODING of a calendar
          // day, so these must read back unshifted (INV-DATE-010). The
          // assertion below states that they do; what makes truncation and zone
          // conversion decidably different is the premise block near the top of
          // this file, because in a zone ahead of UTC they agree here.
          checkIn: new Date("2026-08-03T00:00:00.000Z"),
          checkOut: new Date("2026-08-05T00:00:00.000Z"),
          member: { id: "mem_1" },
          guests: [],
        },
      });
      mocks.retryXeroWriteWithContactRepair.mockRejectedValue(new Error(SENTINEL));

      await expect(createXeroCreditNote("pay_local", 5000)).rejects.toThrow(SENTINEL);

      const creditNote = enqueuedOperation().requestPayload.creditNotes[0];
      expect(creditNote.date).toBe(clubDay);
      expect(creditNote.date).not.toBe(utcDay);
      expect(creditNote.lineItems[0].description).toContain("2026-08-03 - 2026-08-05");
    });
  },
);

describe.each(CLUB_DAY_CASES)(
  "an account-credit (unapplied) credit note — $label",
  ({ instant, utcDay, clubDay }) => {
    it("is dated on the club's calendar day", async () => {
      pinClubMorning(instant);
      mocks.paymentFindUnique.mockResolvedValue({
        id: "pay_local",
        booking: {
          id: "booking_1234abcd",
          memberId: "mem_1",
          checkIn: new Date("2026-08-03T00:00:00.000Z"),
          checkOut: new Date("2026-08-05T00:00:00.000Z"),
          member: { id: "mem_1" },
        },
      });
      mocks.retryXeroWriteWithContactRepair.mockRejectedValue(new Error(SENTINEL));

      await expect(
        createUnappliedXeroCreditNote("pay_local", 5000),
      ).rejects.toThrow(SENTINEL);

      const creditNote = enqueuedOperation().requestPayload.creditNotes[0];
      expect(creditNote.date).toBe(clubDay);
      expect(creditNote.date).not.toBe(utcDay);
    });
  },
);

describe.each(CLUB_DAY_CASES)(
  "a credit-note allocation against an invoice — $label",
  ({ instant, utcDay, clubDay }) => {
    it("is dated on the club's calendar day", async () => {
      pinClubMorning(instant);

      await allocateCreditNoteToInvoice("cn_1", "inv_1", 5000);

      const [, , body] = mocks.accountingApi.createCreditNoteAllocation.mock.calls[0];
      expect(body.allocations[0].date).toBe(clubDay);
      expect(body.allocations[0].date).not.toBe(utcDay);
    });
  },
);

describe.each(CLUB_DAY_CASES)(
  "a booking-modification credit note and the allocation that settles it — $label",
  ({ instant, utcDay, clubDay }) => {
    it("are both dated on the club's calendar day", async () => {
      pinClubMorning(instant);
      mocks.bookingFindUnique.mockResolvedValue({
        id: "booking_1234abcd",
        memberId: "mem_1",
        payment: { xeroInvoiceId: "inv_1" },
      });
      mocks.retryXeroWriteWithContactRepair.mockResolvedValue({
        body: { creditNotes: [{ creditNoteID: "cn_1", creditNoteNumber: "CN-1" }] },
      });

      await createXeroCreditNoteForModification({
        bookingId: "booking_1234abcd",
        refundAmountCents: 5000,
        bookingModificationId: "mod_1",
      });

      const creditNote = enqueuedOperation().requestPayload.creditNotes[0];
      expect(creditNote.date).toBe(clubDay);
      expect(creditNote.date).not.toBe(utcDay);

      const [, , body] = mocks.accountingApi.createCreditNoteAllocation.mock.calls[0];
      expect(body.allocations[0].date).toBe(clubDay);
      expect(body.allocations[0].date).not.toBe(utcDay);
    });
  },
);

// ---------------------------------------------------------------------------
// Invoices — the issue date decides the GST period and the financial year.
// ---------------------------------------------------------------------------

describe.each(CLUB_DAY_CASES)(
  "a supplementary invoice for a positive booking modification — $label",
  ({ instant, utcDay, clubDay }) => {
    it("dates the invoice and its payment on the club's calendar day", async () => {
      pinClubMorning(instant);
      mocks.bookingFindUnique.mockResolvedValue({
        id: "booking_1234abcd",
        memberId: "mem_1",
        payment: { xeroInvoiceId: "inv_1" },
        member: { id: "mem_1" },
      });
      mocks.bookingModificationFindUnique.mockResolvedValue({ createdAt: instant });
      mocks.retryXeroWriteWithContactRepair.mockResolvedValue({
        body: { invoices: [{ invoiceID: "inv_supp", invoiceNumber: "INV-42" }] },
      });

      await createXeroSupplementaryInvoice({
        bookingId: "booking_1234abcd",
        priceDiffCents: 5000,
        changeFeeCents: 0,
        bookingModificationId: "mod_1",
      });

      const invoice = enqueuedOperation().requestPayload.invoices[0];
      expect(invoice.date).toBe(clubDay);
      expect(invoice.date).not.toBe(utcDay);

      const sentPayment = mocks.accountingApi.createPayments.mock.calls[0][1];
      expect(sentPayment.payments[0].date).toBe(clubDay);
      expect(sentPayment.payments[0].date).not.toBe(utcDay);
    });

    it("dates the due date from the modification's stored instant, on the club's calendar", async () => {
      // `BookingModification.createdAt` is a `DateTime @default(now())` — a real
      // instant, like `Booking.createdAt` on #2697, not a `@db.Date`. Pin the
      // clock somewhere the two calendars AGREE so this can only be reading the
      // stored instant, never today.
      vi.setSystemTime(new Date("2026-07-01T00:00:00.000Z"));
      mocks.bookingFindUnique.mockResolvedValue({
        id: "booking_1234abcd",
        memberId: "mem_1",
        payment: { xeroInvoiceId: "inv_1" },
        member: { id: "mem_1" },
      });
      mocks.bookingModificationFindUnique.mockResolvedValue({ createdAt: instant });
      mocks.retryXeroWriteWithContactRepair.mockResolvedValue({
        body: { invoices: [{ invoiceID: "inv_supp", invoiceNumber: "INV-42" }] },
      });

      await createXeroSupplementaryInvoice({
        bookingId: "booking_1234abcd",
        priceDiffCents: 5000,
        changeFeeCents: 0,
        bookingModificationId: "mod_1",
      });

      const invoice = enqueuedOperation().requestPayload.invoices[0];
      expect(invoice.dueDate).toBe(clubDay);
      expect(invoice.dueDate).not.toBe(utcDay);
      expect(invoice.date).toBe("2026-07-01");
    });
  },
);

describe.each(CLUB_DAY_CASES)(
  "the remainder note minted for applied credit with no floating note — $label",
  ({ instant, utcDay, clubDay }) => {
    it("is dated on the club's calendar day", async () => {
      pinClubMorning(instant);
      mocks.bookingFindUnique.mockResolvedValue({
        id: "booking_1234abcd",
        memberId: "mem_1",
        payment: { id: "pay_1", xeroInvoiceId: "inv_1" },
      });
      // 3000c of BOOKING_APPLIED credit, all of it from a noteless (admin
      // adjustment) lot, so the whole amount goes down the mint path.
      mocks.memberCreditAggregate.mockResolvedValue({
        _sum: { amountCents: -3000 },
      });
      mocks.memberCreditFindMany.mockResolvedValue([
        { id: "lot_1", amountCents: 5000, xeroCreditNoteId: null },
      ]);
      mocks.creditNoteAllocationGroupBy.mockResolvedValue([]);
      mocks.transaction.mockImplementation(async (run: (tx: unknown) => unknown) =>
        run({
          memberCredit: {
            aggregate: mocks.memberCreditAggregate,
            findMany: mocks.memberCreditFindMany,
            updateMany: mocks.memberCreditUpdateMany,
          },
          memberCreditNoteAllocation: {
            groupBy: mocks.creditNoteAllocationGroupBy,
            upsert: mocks.creditNoteAllocationUpsert,
            findUnique: mocks.creditNoteAllocationFindUnique,
          },
        }),
      );
      mocks.retryXeroWriteWithContactRepair.mockRejectedValue(new Error(SENTINEL));

      await expect(
        allocateAppliedCreditForBooking("booking_1234abcd"),
      ).rejects.toThrow(SENTINEL);

      const creditNote = enqueuedOperation().requestPayload.creditNotes[0];
      expect(creditNote.date).toBe(clubDay);
      expect(creditNote.date).not.toBe(utcDay);
    });
  },
);

describe.each(CLUB_DAY_CASES)(
  "a group-settlement invoice — $label",
  ({ instant, utcDay, clubDay }) => {
    it("takes its due date from the settlement's stored instant on the club calendar, and leaves the issue date on the lodge night", async () => {
      // The two dates on this one invoice are the clearest illustration of the
      // distinction #2834 turns on. The ISSUE date is the organiser booking's
      // check-in, a `@db.Date` lodge night that must read back unshifted
      // (INV-DATE-010). The DUE date is `GroupBookingSettlement.createdAt`, a
      // `DateTime @default(now())` — a real instant (INV-DATE-019).
      //
      // The issue-date assertion states the value is preserved; it cannot on its
      // own tell truncation from zone conversion, because they agree for a
      // UTC-midnight value in a zone ahead of UTC. The premise block near the
      // top of this file is what separates them.
      //
      // The clock is pinned somewhere the calendars agree, so the due date can
      // only be coming from the stored instant.
      vi.setSystemTime(new Date("2026-07-01T00:00:00.000Z"));
      mocks.transaction.mockImplementation(async (run: (tx: unknown) => unknown) =>
        run({
          $executeRaw: vi.fn().mockResolvedValue(undefined),
          groupBookingSettlement: { findUnique: mocks.settlementFindUnique },
        }),
      );
      mocks.settlementFindUnique.mockResolvedValue({
        id: "settle_1",
        createdAt: instant,
        xeroInvoiceId: null,
        xeroInvoiceNumber: null,
        groupBooking: {
          id: "group_1",
          status: "OPEN",
          organiserMemberId: "mem_1",
          organiserBookingId: "booking_organiser",
          organiserBooking: { checkIn: new Date("2026-08-03T00:00:00.000Z") },
        },
      });
      mocks.bookingFindMany.mockResolvedValue([
        {
          id: "child_1",
          status: "CONFIRMED",
          checkIn: new Date("2026-08-03T00:00:00.000Z"),
          checkOut: new Date("2026-08-05T00:00:00.000Z"),
          guests: [],
        },
      ]);
      mocks.retryXeroWriteWithContactRepair.mockRejectedValue(new Error(SENTINEL));

      await expect(
        createXeroInvoiceForGroupSettlement("settle_1"),
      ).rejects.toThrow(SENTINEL);

      const invoice = enqueuedOperation().requestPayload.invoices[0];
      expect(invoice.dueDate).toBe(clubDay);
      expect(invoice.dueDate).not.toBe(utcDay);
      expect(invoice.date).toBe("2026-08-03");
    });
  },
);

describe.each(CLUB_DAY_CASES)(
  "an entrance-fee invoice — $label",
  ({ instant, utcDay, clubDay, clubDayPlus30 }) => {
    it("dates the invoice on the club's calendar day and its due date thirty club days later", async () => {
      pinClubMorning(instant);
      mocks.getEntranceFeeContext.mockResolvedValue({
        exempt: false,
        category: "ADULT",
        feeMapping: {
          amountCents: 15000,
          code: "200",
          itemCode: null,
          codeExplicitlyConfigured: false,
        },
        description: null,
      });
      mocks.memberFindUnique.mockResolvedValue({ ageTier: "ADULT" });
      // Stop right after the operation records the payload, before the
      // adopt-by-reference lookups.
      mocks.callXeroApi.mockRejectedValue(new Error(SENTINEL));

      await expect(createXeroEntranceFeeInvoice("mem_1")).rejects.toThrow(SENTINEL);

      const invoice = enqueuedOperation().requestPayload.invoices[0];
      expect(invoice.date).toBe(clubDay);
      expect(invoice.date).not.toBe(utcDay);
      expect(invoice.dueDate).toBe(clubDayPlus30);
    });
  },
);

describe.each(CLUB_DAY_CASES)(
  "a membership subscription invoice — $label",
  ({ instant, utcDay, clubDay, clubDayPlus30 }) => {
    it("dates the invoice on the club's calendar day and its due date dueDays club days later", async () => {
      pinClubMorning(instant);
      mocks.chargeFindUnique.mockResolvedValue(subscriptionCharge());
      // The transaction that persists the identifier is past the point of
      // interest; stop there rather than mocking the whole write.
      mocks.transaction.mockRejectedValue(new Error(SENTINEL));

      await expect(
        createXeroMembershipSubscriptionInvoice({
          chargeId: "charge_1",
          syncOperationId: "op_1",
        }),
      ).rejects.toThrow(SENTINEL);

      const built = mocks.accountingApi.createInvoices.mock.calls[0][1].invoices[0];
      expect(built.date).toBe(clubDay);
      expect(built.date).not.toBe(utcDay);
      // `dueDays` on the fixture charge is 30, so the expected due date is the
      // literal thirtieth calendar day after the club day. Recomputing it here
      // would re-run production's own day-stepping algorithm, and a shared error
      // would then pass on both sides.
      expect(built.dueDate).toBe(clubDayPlus30);
    });
  },
);

// ---------------------------------------------------------------------------
// Day arithmetic across the daylight-saving change.
// ---------------------------------------------------------------------------

describe("a due date counted in days is counted in CLUB days, not 24-hour blocks", () => {
  // New Zealand leaves daylight saving at 03:00 on Sunday 5 April 2026, when the
  // clocks go BACK to 02:00 — so that local day is 25 hours long, and the span
  // from 15 March to 14 April is one hour longer than thirty 24-hour blocks.
  // (The 23-hour day is the September transition, which this suite never
  // exercises.)
  //
  // That extra hour is the whole point. The issue instant is 00:30 on 15 March
  // in club time, so it sits within an hour of club midnight: add thirty
  // 24-hour blocks to it and the result lands at 23:30 on 13 April club time,
  // one day short. The correct answer — thirty CALENDAR days after 15 March —
  // is the 14th, and only date-only arithmetic gets there.
  const issuedAt = new Date("2026-03-14T11:30:00.000Z"); // 00:30 on 15 Mar, NZDT

  it("the premise: 30 x 24h from this instant is the day BEFORE 30 calendar days, read on the club's calendar", () => {
    // Read in club time, because that is the reading the claim is about. The
    // UTC reading happens to give the same answer here, so verifying the
    // premise with `toISOString()` would test the wrong calendar and still pass.
    expect(formatDateOnlyForTimeZone(issuedAt, CLUB_ZONE)).toBe("2026-03-15");
    expect(
      formatDateOnlyForTimeZone(
        new Date(issuedAt.getTime() + 30 * 24 * 60 * 60 * 1000),
        CLUB_ZONE,
      ),
    ).toBe("2026-04-13");
  });

  it("dates an entrance-fee invoice's due date thirty calendar days out", async () => {
    pinClubMorning(issuedAt);
    mocks.getEntranceFeeContext.mockResolvedValue({
      exempt: false,
      category: "ADULT",
      feeMapping: {
        amountCents: 15000,
        code: "200",
        itemCode: null,
        codeExplicitlyConfigured: false,
      },
      description: null,
    });
    mocks.memberFindUnique.mockResolvedValue({ ageTier: "ADULT" });
    mocks.callXeroApi.mockRejectedValue(new Error(SENTINEL));

    await expect(createXeroEntranceFeeInvoice("mem_1")).rejects.toThrow(SENTINEL);

    const invoice = enqueuedOperation().requestPayload.invoices[0];
    expect(invoice.date).toBe("2026-03-15");
    expect(invoice.dueDate).toBe("2026-04-14");
  });

  it("dates a subscription invoice's due date dueDays calendar days out, so the adoption interval stays exact", async () => {
    pinClubMorning(issuedAt);
    mocks.chargeFindUnique.mockResolvedValue(subscriptionCharge());
    mocks.transaction.mockRejectedValue(new Error(SENTINEL));

    await expect(
      createXeroMembershipSubscriptionInvoice({
        chargeId: "charge_1",
        syncOperationId: "op_1",
      }),
    ).rejects.toThrow(SENTINEL);

    // Why the 14th and not the 13th matters beyond the date itself:
    // `subscriptionInvoiceMatchesSnapshot` adopts a pre-existing Xero invoice
    // only when `invoiceDueIntervalDays` equals the charge's frozen `dueDays`
    // (30 here), and it measures that interval between these two date-only
    // values. The 13th would make it 29 and the charge would stop adopting its
    // own invoice. These two literals are what pins that; recomputing the
    // interval from them would only restate their own difference and would pass
    // against the pre-#2834 code too, so it is not asserted.
    const built = mocks.accountingApi.createInvoices.mock.calls[0][1].invoices[0];
    expect(built.date).toBe("2026-03-15");
    expect(built.dueDate).toBe("2026-04-14");
  });
});

// ---------------------------------------------------------------------------
// The pins above are undone, which is what keeps them from leaking.
// ---------------------------------------------------------------------------

describe("the clock pins in this file do not survive their own tests", () => {
  // Declared last, so it runs last. It fails the moment the file-level
  // `afterEach` stops handing the clock back — the only thing that stops a bare
  // `vi.setSystemTime` in a test body from silently re-dating every test after
  // it, here and (with the same fix) in the three sibling suites. Compared
  // against `frozenTestNow()` rather than the literal so the rollover canary's
  // `TEST_CLOCK_ISO` / `TEST_CLOCK_OFFSET_DAYS` runs still agree with it.
  it("hands the default frozen instant back to whatever runs next", () => {
    expect(new Date().toISOString()).toBe(frozenTestNow().toISOString());
  });
});

function subscriptionCharge() {
  return {
    id: "charge_1",
    billingBasis: "ANNUAL",
    status: "QUEUED",
    xeroInvoiceId: null,
    xeroInvoiceNumber: null,
    xeroInvoiceAdopted: false,
    invoicePersistedAt: null,
    recipientMemberId: "mem_1",
    xeroAccountCode: "203",
    xeroItemCode: null,
    chargedAmountCents: 20000,
    coveredMonths: 12,
    membershipTypeName: "Ordinary",
    seasonYear: 2026,
    dueDays: 30,
    invoiceReference: "SUBS-2026-mem_1",
    coverage: [],
    components: [],
  };
}
