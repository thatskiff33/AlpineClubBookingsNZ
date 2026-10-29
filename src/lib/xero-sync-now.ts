import "server-only";
import { z } from "zod";
import { asRecord } from "@/lib/xero-json";
import { prisma } from "@/lib/prisma";
import { bookingOwner } from "@/lib/booking-owner";
import { isEffectiveModuleEnabled } from "@/lib/admin-modules";
import { isXeroConnected } from "@/lib/xero-token-store";
import { callXeroApi, getAuthenticatedXeroClient } from "@/lib/xero-api-client";
import { clubFormatValues } from "@/lib/club-format-server";
import { reconcileXeroContact } from "@/lib/xero-inbound/contact";
import { reconcileXeroInvoice } from "@/lib/xero-inbound/invoice";
import { reconcileXeroCreditNote } from "@/lib/xero-inbound/credit-note";
import { failIfRecountLeftUnsettled } from "@/lib/xero-inbound/recount-left-unsettled";
import { runXeroInboundCronCycle } from "@/lib/xero-cron-runner";
import type { CreditNote, Invoice } from "xero-node";

export class XeroSyncNowError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function requireConnection() {
  if (!(await isEffectiveModuleEnabled("xeroIntegration")) || !(await isXeroConnected())) {
    throw new XeroSyncNowError("Xero is not connected.", 409);
  }
}

/** Business fields only: a refreshed cache/link timestamp is not a financial change. */
async function businessSnapshot(memberId: string | null, bookingIds: string[]) {
  const [payments, credits, bookings, slices] = await Promise.all([
    prisma.payment.findMany({
      where: { bookingId: { in: bookingIds } }, orderBy: { id: "asc" },
      select: { id: true, status: true, amountCents: true, refundedAmountCents: true, creditAppliedCents: true, xeroInvoiceId: true, xeroRefundCreditNoteId: true },
    }),
    prisma.memberCredit.findMany({
      where: memberId ? { memberId } : { id: { in: [] } }, orderBy: { id: "asc" },
      select: { id: true, amountCents: true, type: true, appliedToBookingId: true, xeroCreditNoteId: true },
    }),
    prisma.booking.findMany({
      where: { id: { in: bookingIds } }, orderBy: { id: "asc" },
      select: { id: true, status: true },
    }),
    prisma.memberCreditNoteAllocation.findMany({
      where: memberId ? { memberCredit: { memberId } } : { appliedToBookingId: { in: bookingIds } },
      orderBy: { id: "asc" }, select: { id: true, amountCents: true, xeroCreditNoteId: true, appliedToBookingId: true },
    }),
  ]);
  return new Map<string, string>([payments, credits, bookings, slices].flatMap((rows, kind) =>
    rows.map((row): [string, string] => [`${kind}:${row.id}`, JSON.stringify(row)]),
  ));
}

function changesBetween(before: Map<string, string>, after: Map<string, string>) {
  return [...new Set([...before.keys(), ...after.keys()])].filter((id) => before.get(id) !== after.get(id)).length;
}

/** Complete contact reads, without consuming or moving any scheduled cursor. */
async function contactDocuments(contactId: string) {
  // Contact ids are stored data, never executable Xero filter text.
  if (!z.uuid().safeParse(contactId).success) throw new XeroSyncNowError("The member's Xero contact link is invalid.", 409);
  const { xero, tenantId } = await getAuthenticatedXeroClient();
  const invoices: Invoice[] = [];
  const notes: CreditNote[] = [];
  for (let page = 1; ; page++) {
    const response = await callXeroApi(() => xero.accountingApi.getInvoices(
      tenantId, undefined, undefined, "InvoiceID ASC", undefined, undefined,
      [contactId], undefined, page, true, undefined, undefined, false, 100,
    ), { operation: "getInvoices", resourceType: "INVOICE", workflow: "syncFromXeroNow", context: "syncFromXeroNow invoices" });
    const batch = response.body.invoices ?? [];
    invoices.push(...batch);
    if (batch.length < 100) break;
  }
  for (let page = 1; ; page++) {
    const response = await callXeroApi(() => xero.accountingApi.getCreditNotes(
      tenantId, undefined, `Contact.ContactID==Guid("${contactId}")`, "CreditNoteID ASC", page, undefined, 100,
    ), { operation: "getCreditNotes", resourceType: "CREDIT_NOTE", workflow: "syncFromXeroNow", context: "syncFromXeroNow credit notes" });
    const batch = response.body.creditNotes ?? [];
    notes.push(...batch);
    if (batch.length < 100) break;
  }
  return { invoices, notes };
}

async function reconcileDocuments(invoiceIds: Set<string>, noteIds: Set<string>) {
  const format = await clubFormatValues();
  for (const id of invoiceIds) failIfRecountLeftUnsettled(await reconcileXeroInvoice(id, format));
  // Includes allocation repair and the #4270 mirror, in their existing order.
  for (const id of noteIds) {
    const result = failIfRecountLeftUnsettled(await reconcileXeroCreditNote(id));
    if (result.mirrorFailed) throw new XeroSyncNowError("Some records updated, but a credit-note mirror could not finish. It is safe to retry.", 502);
  }
}

function summary(changed: number, invoices: number, creditNotes: number, contactFields = 0) {
  return {
    changed, invoices, creditNotes, contactFields,
    message: changed + contactFields > 0
      ? `Updated ${changed} financial record(s) and ${contactFields} contact field(s); checked ${invoices} invoice(s) and ${creditNotes} credit note(s).`
      : "Already in step.",
  };
}

export async function syncMemberFromXeroNow(memberId: string) {
  await requireConnection();
  const member = await prisma.member.findUnique({ where: { id: memberId }, select: { xeroContactId: true } });
  if (!member) throw new XeroSyncNowError("Member not found.", 404);
  if (!member.xeroContactId) throw new XeroSyncNowError("Link the member to a Xero contact first.", 409);
  const bookings = await prisma.booking.findMany({ where: { memberId }, select: { id: true } });
  const ids = bookings.map((booking) => booking.id);
  const before = await businessSnapshot(memberId, ids);
  const contact = await reconcileXeroContact(member.xeroContactId);
  const { invoices, notes } = await contactDocuments(member.xeroContactId);
  const invoiceIds = new Set(invoices.flatMap((invoice) => invoice.invoiceID ? [invoice.invoiceID] : []));
  const noteIds = new Set(notes.flatMap((note) => note.creditNoteID ? [note.creditNoteID] : []));
  await reconcileDocuments(invoiceIds, noteIds);
  return summary(changesBetween(before, await businessSnapshot(memberId, ids)), invoiceIds.size, noteIds.size,
    "backfilledFields" in contact ? contact.backfilledFields : 0);
}

export async function syncBookingFromXeroNow(bookingId: string) {
  await requireConnection();
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId }, select: { memberId: true, payment: { select: { id: true, xeroInvoiceId: true, xeroRefundCreditNoteId: true } } },
  });
  if (!booking) throw new XeroSyncNowError("Booking not found.", 404);
  const [modifications, tasks] = await Promise.all([
    prisma.bookingModification.findMany({ where: { bookingId }, select: { id: true } }),
    prisma.manualRefundTask.findMany({ where: { bookingId }, select: { id: true } }),
  ]);
  const links = await prisma.xeroObjectLink.findMany({ where: {
    active: true, xeroObjectType: { in: ["INVOICE", "CREDIT_NOTE"] }, OR: [
      { localModel: "Booking", localId: bookingId },
      ...(booking.payment ? [{ localModel: "Payment", localId: booking.payment.id }] : []),
      { localModel: "BookingModification", localId: { in: modifications.map((row) => row.id) } },
      { localModel: "ManualRefundTask", localId: { in: tasks.map((row) => row.id) } },
    ],
  }, select: { xeroObjectId: true, xeroObjectType: true } });
  const invoiceIds = new Set(links.filter((link) => link.xeroObjectType === "INVOICE").map((link) => link.xeroObjectId));
  const noteIds = new Set(links.filter((link) => link.xeroObjectType === "CREDIT_NOTE").map((link) => link.xeroObjectId));
  if (booking.payment?.xeroRefundCreditNoteId) noteIds.add(booking.payment.xeroRefundCreditNoteId);
  if (booking.payment?.xeroInvoiceId) invoiceIds.add(booking.payment.xeroInvoiceId);
  if (invoiceIds.size + noteIds.size === 0) throw new XeroSyncNowError("This booking has no linked Xero invoices or credit notes.", 409);
  const before = await businessSnapshot(bookingOwner(booking).memberId, [bookingId]);
  // The invoice's credit-note summaries identify notes without reading another
  // contact's documents. Include historical allocation links for deleted allocations.
  const { xero, tenantId } = await getAuthenticatedXeroClient();
  for (const id of invoiceIds) {
    const response = await callXeroApi(() => xero.accountingApi.getInvoice(tenantId, id), {
      operation: "getInvoice", resourceType: "INVOICE", workflow: "syncFromXeroNow", context: "syncFromXeroNow booking invoice",
    });
    for (const note of response.body.invoices?.[0]?.creditNotes ?? []) if (note.creditNoteID) noteIds.add(note.creditNoteID);
  }
  const allocations = await prisma.xeroObjectLink.findMany({ where: {
    xeroObjectType: "ALLOCATION", OR: [...invoiceIds].map((id) => ({ metadata: { path: ["invoiceId"], equals: id } })),
  }, select: { metadata: true } });
  for (const allocation of allocations) {
    const parsed = z.object({ creditNoteId: z.string() }).safeParse(allocation.metadata);
    if (parsed.success) noteIds.add(parsed.data.creditNoteId);
  }
  await reconcileDocuments(invoiceIds, noteIds);
  return summary(changesBetween(before, await businessSnapshot(bookingOwner(booking).memberId, [bookingId])), invoiceIds.size, noteIds.size);
}

export async function syncClubFromXeroNow() {
  await requireConnection();
  const result = await runXeroInboundCronCycle();
  if ("skipped" in result) return { message: result.message, result };
  const count = (value: unknown, key: string) => {
    const amount = asRecord(value)?.[key];
    return typeof amount === "number" ? amount : 0;
  };
  const inbound = asRecord(result.inboundReconciliation) ?? {};
  const mirror = result.creditNoteMirror;
  const errors = count(inbound.inbound, "failed") + count(inbound.contactReconciliation, "errors")
    + count(inbound.membershipReconciliation, "errors") + count(inbound.invoiceReconciliation, "failed")
    + count(mirror, "readFailures") + count(mirror, "mirrorFailures");
  if (errors > 0) throw new XeroSyncNowError(`The sync partly completed with ${errors} failed read(s) or repair(s). Check Xero Sync and retry.`, 502);
  const events = count(inbound.inbound, "succeeded");
  const records = count(inbound.contactReconciliation, "created") + count(inbound.contactReconciliation, "updated") + count(inbound.membershipReconciliation, "updated");
  const invoices = count(inbound.invoiceReconciliation, "succeeded");
  const writtenDown = count(mirror, "writtenDown");
  const restored = count(mirror, "restored");
  const message = events + records + invoices + writtenDown + restored === 0 ? "Already in step."
    : `Reconciled ${events} event(s), updated ${records} contact or membership record(s), checked ${invoices} invoice(s), and mirrored ${writtenDown + restored} credit note(s).`;
  return { message, events, records, invoices, writtenDown, restored, result };
}
