import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const data = vi.hoisted(() => ({ modifications: [] as unknown[], tasks: [] as unknown[], links: [] as unknown[], operations: [] as unknown[] }));
vi.mock("@/lib/prisma", () => ({ prisma: {
  bookingModification: { findMany: vi.fn(async () => data.modifications) },
  manualRefundTask: { findMany: vi.fn(async () => data.tasks) },
  xeroObjectLink: { findMany: vi.fn(async () => data.links) },
  xeroSyncOperation: { findMany: vi.fn(async () => data.operations) },
} }));
import { prisma } from "@/lib/prisma";
import { bookingHasAnySupplementaryInvoiceEvidence, readBookingSupplementaryInvoiceIdentities } from "@/lib/booking-supplementary-invoice-identities";
import { observationReviewContext } from "./support/booking-observation-fixtures";
import { buildXeroSupplementaryInvoiceKey } from "@/lib/xero-supplementary-invoice-key";
import { buildXeroBookingInvoiceCorrelationKey } from "@/lib/xero-booking-invoice-key";
const stamp = new Date("2026-06-01T00:00:00Z");
function operation(localModel: string, localId: string, id: string | null, extra: Record<string, unknown> = {}) {
  return { id: `op-${localId}-${id}`, localModel, localId, entityType: "INVOICE", operationType: "CREATE", direction: "OUTBOUND", status: "SUCCEEDED",
    queueType: "SUPPLEMENTARY_INVOICE", requestPayload: { queueType: "SUPPLEMENTARY_INVOICE", bookingId: "booking", bookingModificationId: localModel === "Booking" ? undefined : "mod", shortfallReviewTaskId: localModel === "ManualRefundTask" ? localId : undefined, priceDiffCents: 100, changeFeeCents: 0, recordPayment: false },
    xeroObjectType: "INVOICE", xeroObjectId: id, xeroObjectNumber: "INV-1", xeroObjectUrl: null, correlationKey: null, idempotencyKey: null, createdAt: stamp, updatedAt: stamp, ...extra };
}
function link(localModel: string, localId: string, id: string, active = true) {
  return { id: `link-${localModel}-${localId}-${id}`, localModel, localId, xeroObjectType: "INVOICE", xeroObjectId: id, xeroObjectNumber: "INV-1", xeroObjectUrl: null, role: "SUPPLEMENTARY_INVOICE", active, createdAt: stamp, updatedAt: stamp };
}
beforeEach(() => { data.modifications = [{ id: "mod" }]; data.tasks = []; data.links = []; data.operations = []; vi.clearAllMocks(); });
describe("complete supplementary display identity discovery", () => {
  it("reads Booking, modification and eligible second-ask anchors and deduplicates replay links", async () => {
    // The context uses the canonical parser's current version and required fields.
    data.tasks = [{ id: "task", reviewContext: observationReviewContext("booking", "mod") }];
    data.operations = [operation("Booking", "booking", "direct"), operation("BookingModification", "mod", "mod-invoice"), operation("ManualRefundTask", "task", "second")];
    data.links = [link("Booking", "booking", "direct"), link("BookingModification", "mod", "mod-invoice")];
    const result = await readBookingSupplementaryInvoiceIdentities("booking");
    expect(result.invoiceIds).toEqual(["direct", "mod-invoice", "second"]);
    expect(result.incomplete).toBe(false);
    expect(prisma.xeroObjectLink.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ role: "SUPPLEMENTARY_INVOICE" }) }));
  });
  it("recovers sent/PARTIAL IDs without links and retains all distinct replayed invoices", async () => {
    data.operations = [operation("BookingModification", "mod", "one", { status: "PARTIAL" }), operation("BookingModification", "mod", "two")];
    expect((await readBookingSupplementaryInvoiceIdentities("booking")).invoiceIds).toEqual(["one", "two"]);
  });
  it("excludes card receipts even if their Xero payment-recording leg failed", async () => {
    const op = operation("BookingModification", "mod", "receipt");
    data.operations = [{ ...op, status: "PARTIAL", requestPayload: { ...op.requestPayload, recordPayment: true } }];
    data.links = [link("BookingModification", "mod", "receipt")];
    expect(await readBookingSupplementaryInvoiceIdentities("booking")).toMatchObject({ invoiceIds: [], incomplete: false });
  });
  it("marks unissued, inactive, owner-mismatched and unknown provenance honestly", async () => {
    data.operations = [operation("BookingModification", "mod", null, { status: "PENDING" })];
    expect(await readBookingSupplementaryInvoiceIdentities("booking")).toMatchObject({ invoiceIds: [], incomplete: true });
    data.operations = [];
    data.links = [link("BookingModification", "mod", "inactive", false)];
    expect((await readBookingSupplementaryInvoiceIdentities("booking")).incomplete).toBe(true);
    data.links = [link("BookingModification", "mod", "unknown")];
    expect(await readBookingSupplementaryInvoiceIdentities("booking")).toMatchObject({ invoiceIds: [], incomplete: true });
    const op = operation("BookingModification", "mod", "wrong");
    data.operations = [{ ...op, requestPayload: { ...op.requestPayload, bookingId: "someone-else" } }];
    expect((await readBookingSupplementaryInvoiceIdentities("booking")).invoiceIds).toEqual([]);
  });
  it("does not recover an unrelated primary/group invoice from a shared Booking anchor", async () => {
    data.operations = [operation("Booking", "booking", "primary", { queueType: "BOOKING_INVOICE" }), operation("Booking", "booking", "group", { queueType: "GROUP_SETTLEMENT_INVOICE" })];
    expect(await readBookingSupplementaryInvoiceIdentities("booking")).toMatchObject({ invoiceIds: [], incomplete: false });
  });
  it.each(["FAILED", "RUNNING"])("retains a legacy %s CREATE with no hint, link or outcome as unknown", async (status) => {
    for (const localModel of ["Booking", "BookingModification"] as const) {
      const localId = localModel === "Booking" ? "booking" : "mod";
      data.operations = [operation(localModel, localId, null, { status, queueType: null,
        requestPayload: { invoices: [], priceLines: {} }, responsePayload: null,
        correlationKey: buildXeroSupplementaryInvoiceKey({ localModel, localId, priceDiffCents: 100, changeFeeCents: 0 }) })];
      expect(await readBookingSupplementaryInvoiceIdentities("booking")).toMatchObject({ invoiceIds: [], incomplete: true });
    }
  });
  it("keeps an entirely unclassified legacy anchor unknown while recognizing the canonical primary key", async () => {
    data.operations = [operation("Booking", "booking", null, { queueType: null, requestPayload: { invoices: [] }, status: "FAILED" })];
    expect((await readBookingSupplementaryInvoiceIdentities("booking")).incomplete).toBe(true);
    data.operations = [operation("Booking", "booking", "primary", { queueType: null, requestPayload: { invoices: [] }, correlationKey: buildXeroBookingInvoiceCorrelationKey("booking") })];
    expect(await readBookingSupplementaryInvoiceIdentities("booking")).toMatchObject({ invoiceIds: [], incomplete: false });
  });
  it("keeps revisions invariant under row permutations and changes them for actual evidence changes", async () => {
    data.tasks = [{ id: "task-2", reviewContext: observationReviewContext("booking", "mod") }, { id: "task-1", reviewContext: observationReviewContext("booking", "mod") }];
    data.links = [link("Booking", "booking", "one"), link("BookingModification", "mod", "two")];
    data.operations = [operation("Booking", "booking", "one"), operation("BookingModification", "mod", "two")];
    const first = await readBookingSupplementaryInvoiceIdentities("booking");
    data.tasks.reverse(); data.links.reverse(); data.operations.reverse();
    expect((await readBookingSupplementaryInvoiceIdentities("booking")).revision).toBe(first.revision);
    data.operations = [operation("Booking", "booking", "one", { status: "PARTIAL" }), operation("BookingModification", "mod", "two")];
    expect((await readBookingSupplementaryInvoiceIdentities("booking")).revision).not.toBe(first.revision);
  });
});
// #5066: the booking page's invoice download must not hand over the primary
// invoice alone while ANY supplementary invoice exists — card receipts too.
describe("bookingHasAnySupplementaryInvoiceEvidence", () => {
  const receipt = (extra: Record<string, unknown> = {}) => {
    // The fee-gap path (`recordPayment: true`) raises this on the Booking anchor with no ADDITIONAL row.
    const op = operation("Booking", "booking", "receipt", extra);
    return { ...op, requestPayload: { ...op.requestPayload, recordPayment: true } };
  };
  it("is false with no supplementary rows, and ignores the primary and group invoices on the Booking anchor", async () => {
    expect(await bookingHasAnySupplementaryInvoiceEvidence("booking")).toBe(false);
    data.operations = [operation("Booking", "booking", "primary", { queueType: "BOOKING_INVOICE" }), operation("Booking", "booking", "group", { queueType: "GROUP_SETTLEMENT_INVOICE" }),
      operation("Booking", "booking", "legacy-primary", { queueType: null, requestPayload: { invoices: [] }, correlationKey: buildXeroBookingInvoiceCorrelationKey("booking") })];
    expect(await bookingHasAnySupplementaryInvoiceEvidence("booking")).toBe(false);
  });
  it("is true for a receipt-only supplementary invoice that the identity reader leaves out", async () => {
    data.operations = [receipt()];
    data.links = [link("Booking", "booking", "receipt")];
    expect(await readBookingSupplementaryInvoiceIdentities("booking")).toMatchObject({ invoiceIds: [], incomplete: false });
    expect(await bookingHasAnySupplementaryInvoiceEvidence("booking")).toBe(true);
  });
  it("is true for a receipt not yet sent, a bank demand, an inactive link and an unclassifiable second ask", async () => {
    data.operations = [receipt({ status: "PENDING", xeroObjectId: null })];
    expect(await bookingHasAnySupplementaryInvoiceEvidence("booking")).toBe(true);
    data.operations = [operation("BookingModification", "mod", "bank")];
    expect(await bookingHasAnySupplementaryInvoiceEvidence("booking")).toBe(true);
    data.operations = [];
    data.links = [link("BookingModification", "mod", "old", false)];
    expect(await bookingHasAnySupplementaryInvoiceEvidence("booking")).toBe(true);
    data.links = [];
    data.tasks = [{ id: "task", reviewContext: null }];
    expect(await bookingHasAnySupplementaryInvoiceEvidence("booking")).toBe(true);
  });
});
