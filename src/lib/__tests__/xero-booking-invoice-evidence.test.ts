import { describe, expect, it, vi } from "vitest";

import {
  findActivePrimaryInvoiceLink,
  readBookingInvoiceEvidence,
  readBookingInvoiceEvidenceForPayment,
} from "@/lib/xero-booking-invoice-evidence";

/**
 * DOES THIS BOOKING'S INVOICE ALREADY EXIST IN XERO (#3001, MAD epic #2725)?
 *
 * The question two rules ask for the same reason: the enqueue fence, to refuse a
 * second mint, and the booking page's warning, to refuse to tell an officer that
 * no invoice exists. Both would raise a duplicate invoice in the club's accounts
 * if this answered `false` when the truth is `true`, so the two signals it reads
 * — and the order it reads them in — are pinned here.
 */

function db(overrides: {
  payment?: unknown;
  link?: unknown;
}) {
  return {
    payment: { findUnique: vi.fn().mockResolvedValue(overrides.payment ?? null) },
    xeroObjectLink: {
      findFirst: vi.fn().mockResolvedValue(overrides.link ?? null),
    },
  };
}

describe("the payment's stored invoice id settles it", () => {
  it("is evidence enough, and the link is not even asked for", async () => {
    // It is stamped onto the payment as soon as Xero returns the invoice, which
    // is BEFORE the applied-credit settlement and the completion write — the two
    // steps whose failure produces the row this whole reading exists for.
    const deps = { db: db({}) };

    await expect(
      readBookingInvoiceEvidence(
        { id: "pay_1", xeroInvoiceId: "inv_1", xeroInvoiceNumber: "INV-0007" },
        { deps },
      ),
    ).resolves.toEqual({ exists: true, invoiceNumber: "INV-0007" });

    expect(deps.db.xeroObjectLink.findFirst).not.toHaveBeenCalled();
  });
});

describe("the active primary-invoice link is the second signal", () => {
  it("counts as evidence when the payment field is empty", async () => {
    const deps = {
      db: db({ link: { xeroObjectId: "inv_2", xeroObjectNumber: "INV-0008" } }),
    };

    await expect(
      readBookingInvoiceEvidence(
        { id: "pay_2", xeroInvoiceId: null },
        { deps },
      ),
    ).resolves.toEqual({ exists: true, invoiceNumber: "INV-0008" });
  });

  it("asks only for the ACTIVE primary invoice link on that payment", async () => {
    // A voided or superseded link is not evidence that the club has an invoice,
    // and this is the same predicate the enqueue fence refuses a second mint on.
    const deps = { db: db({}) };

    await findActivePrimaryInvoiceLink("pay_3", { deps });

    expect(deps.db.xeroObjectLink.findFirst.mock.calls[0]?.[0]).toMatchObject({
      where: {
        localModel: "Payment",
        localId: "pay_3",
        xeroObjectType: "INVOICE",
        role: "PRIMARY_INVOICE",
        active: true,
      },
    });
  });

  it("reports no evidence when neither signal is there", async () => {
    await expect(
      readBookingInvoiceEvidence(
        { id: "pay_4", xeroInvoiceId: null },
        { deps: { db: db({}) } },
      ),
    ).resolves.toEqual({ exists: false, invoiceNumber: null });
  });
});

describe("reading it from the payment id the operation row carries", () => {
  it("loads the payment and answers from it", async () => {
    const deps = {
      db: db({
        payment: {
          id: "pay_5",
          xeroInvoiceId: "inv_5",
          xeroInvoiceNumber: "INV-0009",
        },
      }),
    };

    await expect(
      readBookingInvoiceEvidenceForPayment("pay_5", { deps }),
    ).resolves.toEqual({ exists: true, invoiceNumber: "INV-0009" });
  });

  it("falls back to the link when the payment row is gone", async () => {
    // The operation outlives the payment it was stored against. A missing
    // payment is "no evidence from that signal", never an error — the
    // projection's job is to describe a booking, not to fail on one.
    const deps = {
      db: db({ link: { xeroObjectId: "inv_6", xeroObjectNumber: "INV-0010" } }),
    };

    await expect(
      readBookingInvoiceEvidenceForPayment("pay_6", { deps }),
    ).resolves.toEqual({ exists: true, invoiceNumber: "INV-0010" });
  });
});
