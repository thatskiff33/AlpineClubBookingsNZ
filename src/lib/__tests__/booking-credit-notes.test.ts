import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { offeredBookingCreditNotes, readBookingCreditNotes } from "@/lib/booking-credit-notes";

/**
 * #5066 (owner decision on PR #5201, 17 Nov 2026): the booking page lists each
 * Xero credit note raised against the booking, from the app's own records, and
 * only notes whose Xero id the app holds.
 */
const link = (xeroObjectId: string, overrides: Record<string, unknown> = {}) => ({
  xeroObjectId,
  xeroObjectNumber: null as string | null,
  active: true,
  metadata: null as unknown,
  ...overrides,
});

describe("offeredBookingCreditNotes", () => {
  it("keeps each note once, in order, with the number any link records", () => {
    const offered = offeredBookingCreditNotes(
      [
        { creditNoteId: "cn-1", kind: "CHANGE" },
        { creditNoteId: "cn-2", kind: "REFUND" },
        { creditNoteId: "cn-1", kind: "REFUND" },
      ],
      [link("cn-1"), link("cn-1", { xeroObjectNumber: "CN-0001" }), link("cn-2", { xeroObjectNumber: "CN-0002" })],
    );
    expect(offered).toEqual([
      { creditNoteId: "cn-1", creditNoteNumber: "CN-0001", kind: "CHANGE" },
      { creditNoteId: "cn-2", creditNoteNumber: "CN-0002", kind: "REFUND" },
    ]);
  });

  it("leaves out a note any link records as voided or deleted in Xero", () => {
    const offered = offeredBookingCreditNotes(
      [
        { creditNoteId: "cn-1", kind: "REFUND" },
        { creditNoteId: "cn-2", kind: "REFUND" },
      ],
      [link("cn-1"), link("cn-1", { metadata: { status: "VOIDED" } }), link("cn-2", { metadata: { status: "DELETED" } })],
    );
    expect(offered).toEqual([]);
  });

  it("leaves out a note whose every link is inactive, and keeps a column-only note with no link at all", () => {
    const offered = offeredBookingCreditNotes(
      [
        { creditNoteId: "cn-retired", kind: "REFUND" },
        { creditNoteId: "cn-column", kind: "REFUND" },
      ],
      [link("cn-retired", { active: false })],
    );
    expect(offered).toEqual([{ creditNoteId: "cn-column", creditNoteNumber: null, kind: "REFUND" }]);
  });

  it("F5: labels a note this booking's credit slices name as credit used, whatever an older link calls it", () => {
    const offered = offeredBookingCreditNotes(
      [
        { creditNoteId: "cn-lot", kind: "ACCOUNT_CREDIT", role: "ACCOUNT_CREDIT_NOTE" },
        { creditNoteId: "cn-lot", kind: "CREDIT_USED" },
      ],
      [link("cn-lot", { xeroObjectNumber: "CN-0003" })],
      new Set(["cn-lot"]),
    );
    expect(offered).toEqual([{ creditNoteId: "cn-lot", creditNoteNumber: "CN-0003", kind: "CREDIT_USED" }]);
  });

  it("F6: drops a remainder note once no slice for this booking names it (the credit was given back)", () => {
    const remainder = { creditNoteId: "cn-remainder", kind: "CREDIT_USED" as const, role: "APPLIED_CREDIT_REMAINDER_NOTE" };
    expect(offeredBookingCreditNotes([remainder], [link("cn-remainder")], new Set())).toEqual([]);
    expect(offeredBookingCreditNotes([remainder], [link("cn-remainder")], new Set(["cn-remainder"]))).toEqual([
      { creditNoteId: "cn-remainder", creditNoteNumber: null, kind: "CREDIT_USED" },
    ]);
  });
});

describe("readBookingCreditNotes", () => {
  function store(overrides: Record<string, unknown> = {}) {
    const findLinks = vi
      .fn()
      .mockResolvedValueOnce([
        { xeroObjectId: "cn-mod", role: "MODIFICATION_CREDIT_NOTE" },
        { xeroObjectId: "cn-account", role: "MODIFICATION_ACCOUNT_CREDIT_NOTE" },
      ])
      .mockResolvedValueOnce([
        link("cn-mod", { xeroObjectNumber: "CN-0010" }),
        link("cn-account", { xeroObjectNumber: "CN-0011" }),
        link("cn-lot", { xeroObjectNumber: "CN-0003" }),
      ]);
    return {
      payment: { findUnique: vi.fn(async () => ({ xeroRefundCreditNoteId: "cn-refund" })) },
      paymentRefund: { findMany: vi.fn(async () => [{ xeroRefundCreditNoteId: "cn-refund" }]) },
      memberCreditNoteAllocation: { findMany: vi.fn(async () => [{ xeroCreditNoteId: "cn-lot" }]) },
      xeroObjectLink: { findMany: findLinks },
      ...overrides,
    };
  }

  it("finds notes on the booking's own anchors, its refund columns and the owner's credit allocated to it", async () => {
    const db = store();
    const notes = await readBookingCreditNotes(
      { id: "bk-1", paymentId: "pay-1", ownerMemberId: "owner-1", modificationIds: ["mod-1"] },
      db as never,
    );
    expect(notes).toEqual([
      { creditNoteId: "cn-mod", creditNoteNumber: "CN-0010", kind: "CHANGE" },
      { creditNoteId: "cn-account", creditNoteNumber: "CN-0011", kind: "ACCOUNT_CREDIT" },
      { creditNoteId: "cn-refund", creditNoteNumber: null, kind: "REFUND" },
      { creditNoteId: "cn-lot", creditNoteNumber: "CN-0003", kind: "CREDIT_USED" },
    ]);
    const anchored = db.xeroObjectLink.findMany.mock.calls[0][0];
    expect(anchored.where).toMatchObject({
      xeroObjectType: "CREDIT_NOTE",
      active: true,
      OR: [
        { localModel: "Booking", localId: "bk-1" },
        { localModel: "Payment", localId: "pay-1" },
        { localModel: "BookingModification", localId: { in: ["mod-1"] } },
      ],
    });
    // Organiser-extra notes credit another invoice and are never listed.
    expect(anchored.where.role.in).not.toContain("ORGANISER_EXTRA_WAIVER");
    expect(anchored.where.role.in).not.toContain("ORGANISER_EXTRA_REFUND");
    expect(anchored.where.role.in).toEqual(
      expect.arrayContaining(["MODIFICATION_CREDIT_NOTE", "REFUND_CREDIT_NOTE", "REFUND_REQUEST_CREDIT_NOTE", "APPLIED_CREDIT_REMAINDER_NOTE"]),
    );
    // Only the booking owner's own credit lots.
    expect(db.memberCreditNoteAllocation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { appliedToBookingId: "bk-1", amountCents: { gt: 0 }, memberCredit: { memberId: "owner-1" } } }),
    );
  });

  it("reads no allocation for an organisation-owned booking and no payment rows without a payment", async () => {
    const db = store({ xeroObjectLink: { findMany: vi.fn(async () => []) } });
    expect(await readBookingCreditNotes({ id: "bk-1", paymentId: null, ownerMemberId: null, modificationIds: [] }, db as never)).toEqual([]);
    expect(db.memberCreditNoteAllocation.findMany).not.toHaveBeenCalled();
    expect(db.payment.findUnique).not.toHaveBeenCalled();
    expect(db.paymentRefund.findMany).not.toHaveBeenCalled();
  });
});
