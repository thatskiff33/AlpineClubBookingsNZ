import { beforeEach, describe, expect, it, vi } from "vitest";

// The checker injects db / readInvoiceCreditAllocation / sendAlert, so these
// module mocks exist only to satisfy imports without pulling the real Prisma
// client, email stack, or Xero HTTP client into the unit test.
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/email", () => ({ sendAdminCreditSyncDriftAlert: vi.fn() }));
vi.mock("@/lib/xero-api-client", () => ({
  callXeroApi: vi.fn(),
  getAuthenticatedXeroClient: vi.fn(),
}));
vi.mock("@/lib/xero-links", () => ({
  buildXeroInvoiceUrl: (invoiceId: string) => `https://xero.test/invoice/${invoiceId}`,
}));
vi.mock("@/lib/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  reconcileXeroCreditSync,
  type CreditSyncInvoiceRead,
} from "@/lib/xero-credit-sync-checker";
import {
  type CreditSyncDriftReportEmail,
} from "@/lib/email-templates/admin-xero-reports";
import type { ClubFormat } from "@/lib/club-format";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

interface FakeDbState {
  cronJobRun: unknown;
  /**
   * bookingId -> the Xero credit-note ids of its STAMPED BOOKING_APPLIED rows.
   * Defines the checker's population AND scopes the Xero-side comparison to the
   * member-account credit notes (a modification/reprice note on the same invoice
   * is deliberately absent here — see the Finding #2501-1 test).
   */
  stampedCreditNoteIdsByBooking: Record<string, string[]>;
  /** Net applied credit (positive cents) — the checker's PRE-LOOP bulk snapshot. */
  netCentsByBooking: Record<string, number>;
  /**
   * Optional FRESH per-booking net re-read (Finding #2501-2). When a concurrent
   * allocation/deallocation lands between the bulk snapshot and the Xero read,
   * this is what the checker's aligned re-read returns. Falls back to the
   * snapshot when unset.
   */
  netCentsByBookingFresh?: Record<string, number>;
  bookings: Array<{
    id: string;
    member: { firstName: string; lastName: string };
    payment: { id: string | null; xeroInvoiceId: string | null } | null;
  }>;
  inFlightOpBookingPaymentIds: Set<string>;
}

function makeDb(state: FakeDbState) {
  return {
    cronJobRun: {
      findFirst: vi.fn(async () => state.cronJobRun),
    },
    memberCredit: {
      // Population query: one row per (booking, stamped credit-note id). The
      // checker keeps the credit-note ids so it can restrict the Xero-side sum
      // to the member's own notes (Finding #2501-1).
      findMany: vi.fn(async () => {
        const rows: Array<{
          appliedToBookingId: string;
          xeroCreditNoteId: string;
        }> = [];
        for (const [bookingId, ids] of Object.entries(
          state.stampedCreditNoteIdsByBooking
        )) {
          for (const id of ids) {
            rows.push({ appliedToBookingId: bookingId, xeroCreditNoteId: id });
          }
        }
        return rows;
      }),
      // Pre-loop bulk-snapshot net metric over ALL BOOKING_APPLIED rows.
      groupBy: vi.fn(async () =>
        Object.entries(state.netCentsByBooking).map(([id, cents]) => ({
          appliedToBookingId: id,
          _sum: { amountCents: -cents },
        }))
      ),
      // Fresh per-booking net re-read, aligned with the Xero read (Finding #2501-2).
      aggregate: vi.fn(
        async ({ where }: { where: { appliedToBookingId: string } }) => {
          const fresh = state.netCentsByBookingFresh ?? state.netCentsByBooking;
          const cents = fresh[where.appliedToBookingId] ?? 0;
          return { _sum: { amountCents: -cents } };
        }
      ),
    },
    booking: {
      findMany: vi.fn(async () => state.bookings),
    },
    xeroSyncOperation: {
      findFirst: vi.fn(async ({ where }: { where: { localId: string } }) =>
        state.inFlightOpBookingPaymentIds.has(where.localId) ? { id: "op_1" } : null
      ),
    },
  } as unknown as typeof import("@/lib/prisma").prisma;
}

function bookingRow(
  id: string,
  xeroInvoiceId: string | null,
  first = "Ada",
  last = "Lovelace"
) {
  return {
    id,
    member: { firstName: first, lastName: last },
    payment: { id: `pay_${id}`, xeroInvoiceId },
  };
}

/** A stamped member credit-note allocation line on the invoice. */
function stampedNote(
  appliedCents: number,
  creditNoteId = "cn_1",
  creditNoteNumber = "CN-9"
): CreditSyncInvoiceRead["notes"][number] {
  return { creditNoteId, creditNoteNumber, appliedCents };
}

function invoiceRead(
  amountCreditedCents: number | null,
  notes: CreditSyncInvoiceRead["notes"] = []
): CreditSyncInvoiceRead {
  return {
    found: amountCreditedCents !== null,
    amountCreditedCents,
    invoiceNumber: "INV-001",
    notes,
  };
}

describe("reconcileXeroCreditSync", () => {
  let sendAlert: ReturnType<
    typeof vi.fn<(report: CreditSyncDriftReportEmail, format: ClubFormat) => Promise<void>>
  >;

  beforeEach(() => {
    sendAlert = vi.fn<(report: CreditSyncDriftReportEmail, format: ClubFormat) => Promise<void>>(
      async () => {}
    );
  });

  it("reports no drift and sends no email when BookingApp and Xero agree", async () => {
    const db = makeDb({
      cronJobRun: null,
      stampedCreditNoteIdsByBooking: { bk_1: ["cn_1"] },
      netCentsByBooking: { bk_1: 12000 },
      bookings: [bookingRow("bk_1", "inv_1")],
      inFlightOpBookingPaymentIds: new Set(),
    });

    const result = await reconcileXeroCreditSync(CLUB_FORMAT_TEST, {
      db,
      minRecheckIntervalMs: 0,
      readInvoiceCreditAllocation: async () =>
        invoiceRead(12000, [stampedNote(12000, "cn_1")]),
      sendAlert,
    });

    expect(result).toMatchObject({
      skipped: false,
      scannedBookings: 1,
      checkedBookings: 1,
      deferredBookings: 0,
      driftBookings: 0,
      totalDriftCents: 0,
      completePass: true,
      emailSent: false,
    });
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it("reconciles clean when a MODIFICATION credit note also sits on the invoice (Finding #2501-1)", async () => {
    // The invoice carries TWO credit notes: the member's stamped BOOKING_APPLIED
    // note ($100) AND a downward-reprice modification credit note ($50), so
    // Xero's invoice.amountCredited is $150. Only the member note is a
    // BOOKING_APPLIED row, so localCents = $100. Comparing against the STAMPED
    // note's applied amount ($100) reconciles clean; comparing against the
    // invoice-wide $150 would raise a permanent false `excess_in_xero`.
    const db = makeDb({
      cronJobRun: null,
      stampedCreditNoteIdsByBooking: { bk_1: ["cn_member"] },
      netCentsByBooking: { bk_1: 10000 },
      bookings: [bookingRow("bk_1", "inv_1")],
      inFlightOpBookingPaymentIds: new Set(),
    });

    const result = await reconcileXeroCreditSync(CLUB_FORMAT_TEST, {
      db,
      minRecheckIntervalMs: 0,
      readInvoiceCreditAllocation: async () =>
        invoiceRead(15000, [
          stampedNote(10000, "cn_member", "CN-MEMBER"),
          // A modification/reprice credit note — NOT a BOOKING_APPLIED row.
          { creditNoteId: "cn_mod", creditNoteNumber: "CN-MOD", appliedCents: 5000 },
        ]),
      sendAlert,
    });

    expect(result.driftBookings).toBe(0);
    expect(result.checkedBookings).toBe(1);
    expect(result.emailSent).toBe(false);
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it("does NOT warn when the local net changes between the snapshot and the Xero read (Finding #2501-2)", async () => {
    // The pre-loop bulk snapshot recorded $120, but a concurrent deallocation
    // dropped the live net to $80 before the Xero read — which now shows $80.
    // Comparing the STALE $120 against $80 would warn; the aligned fresh re-read
    // ($80) matches Xero, so the skew resolves with no warning.
    const db = makeDb({
      cronJobRun: null,
      stampedCreditNoteIdsByBooking: { bk_1: ["cn_1"] },
      netCentsByBooking: { bk_1: 12000 },
      netCentsByBookingFresh: { bk_1: 8000 },
      bookings: [bookingRow("bk_1", "inv_1")],
      inFlightOpBookingPaymentIds: new Set(),
    });

    const result = await reconcileXeroCreditSync(CLUB_FORMAT_TEST, {
      db,
      minRecheckIntervalMs: 0,
      readInvoiceCreditAllocation: async () =>
        invoiceRead(8000, [stampedNote(8000, "cn_1")]),
      sendAlert,
    });

    expect(result.driftBookings).toBe(0);
    expect(result.checkedBookings).toBe(1);
    expect(result.deferredBookings).toBe(0);
    expect(result.emailSent).toBe(false);
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it("reconciles a COMPLETED clamp deallocation via the net-of-all metric (no false drift)", async () => {
    // Stamped rows still sum to -$120, but the #1887 clamp appended an unstamped
    // +$20 offset and the deallocation reduced the invoice to $100. Netting all
    // rows gives $100, which matches Xero — summing stamped rows alone would
    // have falsely reported $20 of drift.
    const db = makeDb({
      cronJobRun: null,
      stampedCreditNoteIdsByBooking: { bk_1: ["cn_1"] },
      netCentsByBooking: { bk_1: 10000 },
      bookings: [bookingRow("bk_1", "inv_1")],
      inFlightOpBookingPaymentIds: new Set(),
    });

    const result = await reconcileXeroCreditSync(CLUB_FORMAT_TEST, {
      db,
      minRecheckIntervalMs: 0,
      readInvoiceCreditAllocation: async () =>
        invoiceRead(10000, [stampedNote(10000, "cn_1")]),
      sendAlert,
    });

    expect(result.driftBookings).toBe(0);
    expect(result.checkedBookings).toBe(1);
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it("warns with the EXACT shortfall when Xero has less allocated than BookingApp recorded", async () => {
    const db = makeDb({
      cronJobRun: null,
      stampedCreditNoteIdsByBooking: { bk_1: ["cn_1"] },
      netCentsByBooking: { bk_1: 12000 },
      bookings: [bookingRow("bk_1", "inv_1")],
      inFlightOpBookingPaymentIds: new Set(),
    });

    const result = await reconcileXeroCreditSync(CLUB_FORMAT_TEST, {
      db,
      minRecheckIntervalMs: 0,
      // Xero shows only $30 allocated where BookingApp believes $120.
      readInvoiceCreditAllocation: async () =>
        invoiceRead(3000, [
          { creditNoteId: "cn_1", creditNoteNumber: "CN-9", appliedCents: 3000 },
        ]),
      sendAlert,
    });

    expect(result.driftBookings).toBe(1);
    expect(result.totalDriftCents).toBe(9000);
    expect(result.emailSent).toBe(true);
    expect(sendAlert).toHaveBeenCalledTimes(1);

    const report = sendAlert.mock.calls[0][0] as CreditSyncDriftReportEmail;
    expect(report.drifts).toEqual([
      {
        kind: "missing_in_xero",
        bookingId: "bk_1",
        memberName: "Ada Lovelace",
        invoiceId: "inv_1",
        invoiceNumber: "INV-001",
        invoiceUrl: "https://xero.test/invoice/inv_1",
        localCents: 12000,
        xeroCents: 3000,
        deltaCents: 9000,
        notes: [{ creditNoteId: "cn_1", creditNoteNumber: "CN-9", appliedCents: 3000 }],
      },
    ]);
  });

  it("warns with the EXACT excess when Xero has more allocated than BookingApp recorded", async () => {
    const db = makeDb({
      cronJobRun: null,
      stampedCreditNoteIdsByBooking: { bk_1: ["cn_1"] },
      netCentsByBooking: { bk_1: 5000 },
      bookings: [bookingRow("bk_1", "inv_1")],
      inFlightOpBookingPaymentIds: new Set(),
    });

    const result = await reconcileXeroCreditSync(CLUB_FORMAT_TEST, {
      db,
      minRecheckIntervalMs: 0,
      readInvoiceCreditAllocation: async () =>
        invoiceRead(8000, [stampedNote(8000, "cn_1")]),
      sendAlert,
    });

    expect(result.driftBookings).toBe(1);
    expect(result.totalDriftCents).toBe(3000);
    const report = sendAlert.mock.calls[0][0] as CreditSyncDriftReportEmail;
    expect(report.drifts[0]).toMatchObject({
      kind: "excess_in_xero",
      localCents: 5000,
      xeroCents: 8000,
      deltaCents: 3000,
    });
  });

  it("flags applied credit that has no linked Xero invoice", async () => {
    const db = makeDb({
      cronJobRun: null,
      stampedCreditNoteIdsByBooking: { bk_1: ["cn_1"] },
      netCentsByBooking: { bk_1: 4200 },
      bookings: [bookingRow("bk_1", null, "Grace", "Hopper")],
      inFlightOpBookingPaymentIds: new Set(),
    });

    const readInvoice = vi.fn(async () => invoiceRead(0));
    const result = await reconcileXeroCreditSync(CLUB_FORMAT_TEST, {
      db,
      minRecheckIntervalMs: 0,
      readInvoiceCreditAllocation: readInvoice,
      sendAlert,
    });

    expect(readInvoice).not.toHaveBeenCalled();
    expect(result.driftBookings).toBe(1);
    const report = sendAlert.mock.calls[0][0] as CreditSyncDriftReportEmail;
    expect(report.drifts[0]).toMatchObject({
      kind: "no_invoice",
      localCents: 4200,
      xeroCents: 0,
      deltaCents: 4200,
      invoiceId: null,
      invoiceUrl: null,
    });
  });

  it("DEFERS (no false warning) when the Xero read fails — fail-safe", async () => {
    const db = makeDb({
      cronJobRun: null,
      stampedCreditNoteIdsByBooking: { bk_1: ["cn_1"] },
      netCentsByBooking: { bk_1: 12000 },
      bookings: [bookingRow("bk_1", "inv_1")],
      inFlightOpBookingPaymentIds: new Set(),
    });

    const result = await reconcileXeroCreditSync(CLUB_FORMAT_TEST, {
      db,
      minRecheckIntervalMs: 0,
      readInvoiceCreditAllocation: async () => {
        throw new Error("Xero temporarily unavailable");
      },
      sendAlert,
    });

    expect(result.deferredBookings).toBe(1);
    expect(result.checkedBookings).toBe(0);
    expect(result.driftBookings).toBe(0);
    expect(result.completePass).toBe(false);
    expect(result.emailSent).toBe(false);
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it("DEFERS a booking whose allocation is still in flight (not drift)", async () => {
    const db = makeDb({
      cronJobRun: null,
      stampedCreditNoteIdsByBooking: { bk_1: ["cn_1"] },
      netCentsByBooking: { bk_1: 12000 },
      bookings: [bookingRow("bk_1", "inv_1")],
      inFlightOpBookingPaymentIds: new Set(["pay_bk_1"]),
    });

    const readInvoice = vi.fn(async () => invoiceRead(0));
    const result = await reconcileXeroCreditSync(CLUB_FORMAT_TEST, {
      db,
      minRecheckIntervalMs: 0,
      readInvoiceCreditAllocation: readInvoice,
      sendAlert,
    });

    expect(readInvoice).not.toHaveBeenCalled();
    expect(result.deferredBookings).toBe(1);
    expect(result.driftBookings).toBe(0);
    expect(result.completePass).toBe(false);
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it("DEFERS on a degraded payload with an unreadable amountCredited", async () => {
    const db = makeDb({
      cronJobRun: null,
      stampedCreditNoteIdsByBooking: { bk_1: ["cn_1"] },
      netCentsByBooking: { bk_1: 12000 },
      bookings: [bookingRow("bk_1", "inv_1")],
      inFlightOpBookingPaymentIds: new Set(),
    });

    const result = await reconcileXeroCreditSync(CLUB_FORMAT_TEST, {
      db,
      minRecheckIntervalMs: 0,
      readInvoiceCreditAllocation: async () => ({
        found: true,
        amountCreditedCents: null,
        invoiceNumber: null,
        notes: [],
      }),
      sendAlert,
    });

    expect(result.deferredBookings).toBe(1);
    expect(result.driftBookings).toBe(0);
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it("is idempotent: a re-run over an in-sync ledger reports the same zero drift", async () => {
    const state: FakeDbState = {
      cronJobRun: null,
      stampedCreditNoteIdsByBooking: { bk_1: ["cn_1"] },
      netCentsByBooking: { bk_1: 7500 },
      bookings: [bookingRow("bk_1", "inv_1")],
      inFlightOpBookingPaymentIds: new Set(),
    };
    const read = async () => invoiceRead(7500, [stampedNote(7500, "cn_1")]);

    const first = await reconcileXeroCreditSync(CLUB_FORMAT_TEST, {
      db: makeDb(state),
      minRecheckIntervalMs: 0,
      readInvoiceCreditAllocation: read,
      sendAlert,
    });
    const second = await reconcileXeroCreditSync(CLUB_FORMAT_TEST, {
      db: makeDb(state),
      minRecheckIntervalMs: 0,
      readInvoiceCreditAllocation: read,
      sendAlert,
    });

    expect(first).toEqual(second);
    expect(first.driftBookings).toBe(0);
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it("throttles: a complete pass within the recheck interval skips real Xero work", async () => {
    const readInvoice = vi.fn(async () => invoiceRead(0));
    const db = makeDb({
      cronJobRun: {
        startedAt: new Date(),
        resultSummary: { completePass: true },
      },
      stampedCreditNoteIdsByBooking: { bk_1: ["cn_1"] },
      netCentsByBooking: { bk_1: 12000 },
      bookings: [],
      inFlightOpBookingPaymentIds: new Set(),
    });

    const result = await reconcileXeroCreditSync(CLUB_FORMAT_TEST, {
      db,
      minRecheckIntervalMs: 20 * 60 * 60 * 1000,
      readInvoiceCreditAllocation: readInvoice,
      sendAlert,
    });

    expect(result.skipped).toBe(true);
    expect(result.reason).toMatch(/throttled/i);
    expect(readInvoice).not.toHaveBeenCalled();
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it("does NOT throttle when the last pass was incomplete (e.g. a prior Xero outage)", async () => {
    const readInvoice = vi.fn(async () =>
      invoiceRead(12000, [stampedNote(12000, "cn_1")])
    );
    const db = makeDb({
      cronJobRun: {
        startedAt: new Date(),
        resultSummary: { completePass: false },
      },
      stampedCreditNoteIdsByBooking: { bk_1: ["cn_1"] },
      netCentsByBooking: { bk_1: 12000 },
      bookings: [bookingRow("bk_1", "inv_1")],
      inFlightOpBookingPaymentIds: new Set(),
    });

    const result = await reconcileXeroCreditSync(CLUB_FORMAT_TEST, {
      db,
      minRecheckIntervalMs: 20 * 60 * 60 * 1000,
      readInvoiceCreditAllocation: readInvoice,
      sendAlert,
    });

    expect(result.skipped).toBe(false);
    expect(readInvoice).toHaveBeenCalledTimes(1);
    expect(result.checkedBookings).toBe(1);
  });

  it("ignores population bookings whose net applied credit is zero (fully clamped)", async () => {
    const readInvoice = vi.fn(async () => invoiceRead(0));
    const db = makeDb({
      cronJobRun: null,
      // A stamped booking whose negative applied row is fully offset by the
      // #1887 positive clamp offset — net zero, no live credit to reconcile.
      stampedCreditNoteIdsByBooking: { bk_1: ["cn_1"] },
      netCentsByBooking: { bk_1: 0 },
      bookings: [],
      inFlightOpBookingPaymentIds: new Set(),
    });

    const result = await reconcileXeroCreditSync(CLUB_FORMAT_TEST, {
      db,
      minRecheckIntervalMs: 0,
      readInvoiceCreditAllocation: readInvoice,
      sendAlert,
    });

    expect(result.scannedBookings).toBe(0);
    expect(result.completePass).toBe(true);
    expect(readInvoice).not.toHaveBeenCalled();
    expect(sendAlert).not.toHaveBeenCalled();
  });
});
