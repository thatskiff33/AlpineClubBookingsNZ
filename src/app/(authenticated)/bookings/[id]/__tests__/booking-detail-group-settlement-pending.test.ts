/*
  #3642 (`INV-PAY-105`) — the organiser's page renders a settlement that is
  waiting on its emailed Internet Banking invoice as PENDING, from the server,
  on every load. The card used to hold that state only in memory, so a reload
  offered the Card / Internet Banking picker again over an invoice already sent.
  The decision is the projection's: the reference is handed to the card only
  while the settlement is bound to its invoice.
*/
import { describe, expect, it } from "vitest";

import type { FeatureFlags } from "@/config/schema";
import { resolveBookingDetailLinkedParty } from "../_lib/booking-detail-linked-party";
import type { BookingDetailRecord } from "../_lib/load-booking-detail";
import type { BookingDetailViewer } from "../_lib/booking-detail-viewer";
import type { BookingDetailEditAccess } from "../_lib/booking-detail-edit-access";

function organiserSettlement(
  settlement: Record<string, unknown> | null,
  groupSettlementInvoiceCreate: { status: string; responsePayload: unknown } | null = null
) {
  const record = {
    checkIn: new Date("2026-08-10T00:00:00.000Z"),
    checkOut: new Date("2026-08-11T00:00:00.000Z"),
    status: "PAID",
    parentBooking: null,
    parentBookingId: null,
    cancelIfGuestsBumped: false,
    hasNonMembers: false,
    linkedBookings: [],
    groupBookingAsOrganiser: {
      id: "abcd1234-group",
      joinCode: "ABC123",
      status: "OPEN",
      paymentMode: "ORGANISER_PAYS",
      joinDeadline: null,
      maxJoiners: null,
      settlement,
      joins: [],
    },
    groupSettlementInvoiceCreate,
  } as unknown as BookingDetailRecord;
  return resolveBookingDetailLinkedParty({
    booking: record,
    modules: { groupBookings: true } as unknown as FeatureFlags,
    viewer: {
      canManageBooking: true,
      isBookingOwner: true,
      canSeeAdminTools: false,
    } as unknown as BookingDetailViewer,
    access: { isDeleted: false } as unknown as BookingDetailEditAccess,
  }).organiserGroupState!.settlement;
}

describe("the organiser's pending Internet Banking settlement (#3642)", () => {
  it("hands the card the bank-transfer reference while the invoice is outstanding", () => {
    expect(
      organiserSettlement({
        status: "PENDING",
        source: "INTERNET_BANKING",
        amountCents: 60000,
        paidAt: null,
      })
    ).toMatchObject({ amountCents: 60000, internetBankingReference: "GROUP-ABCD1234" });
  });

  it.each([
    ["a card settlement", { status: "PENDING", source: "STRIPE" }],
    ["a settlement the reaper released", { status: "FAILED", source: "INTERNET_BANKING" }],
    ["a paid settlement", { status: "SUCCEEDED", source: "INTERNET_BANKING" }],
  ])("hands it no reference for %s", (_label, fields) => {
    expect(
      organiserSettlement({ ...fields, amountCents: 60000, paidAt: null })
    ).toMatchObject({ internetBankingReference: null });
  });
});

// #3642 (review nit): the card says "Invoice emailed" only once it was.
describe("where the organiser's outstanding invoice has got to (#3642)", () => {
  const bound = { status: "PENDING", source: "INTERNET_BANKING", amountCents: 60000, paidAt: null };

  it.each([
    ["being prepared: no invoice yet, its create still queued", { xeroInvoiceId: null }, { status: "PENDING", responsePayload: null }, "preparing"],
    ["failed: no invoice, and its create failed", { xeroInvoiceId: null }, { status: "FAILED", responsePayload: null }, "failed"],
    ["emailed: raised and the email went out", { xeroInvoiceId: "inv-1" }, { status: "SUCCEEDED", responsePayload: { invoiceEmail: { sent: true } } }, "emailed"],
    ["raised: the organiser's No emails switch withheld it", { xeroInvoiceId: "inv-1" }, { status: "SUCCEEDED", responsePayload: { invoiceEmail: null, invoiceEmailWithheldByNoEmails: true } }, "raised"],
    ["raised: the email failed", { xeroInvoiceId: "inv-1" }, { status: "PARTIAL", responsePayload: { invoiceEmailError: "boom" } }, "raised"],
  ])("reads %s", (_label, fields, create, expected) => {
    expect(organiserSettlement({ ...bound, ...fields }, create)).toMatchObject({
      invoiceDisplay: expected,
    });
  });

  it("says nothing about an invoice when none is outstanding", () => {
    expect(
      organiserSettlement({ ...bound, status: "SUCCEEDED", xeroInvoiceId: "inv-1" })
    ).toMatchObject({ invoiceDisplay: null });
  });
});
