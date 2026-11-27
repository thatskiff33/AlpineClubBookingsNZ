import { describe, expect, it, vi } from "vitest";

// #5289 C (`INV-SSOT`): the settle's rule for an invoice's one bank-transfer
// payment, which the allocation write, its removal and the outbound allocation
// completion lock by. The real-database races are in
// `kept-settle-queued-cancel.realdb.test.ts`; this pins the rule's reads.

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import {
  bankTransferPaymentIdsOfInvoices,
  bankTransferPaymentsOfInvoiceWhere,
  bankTransferPaymentsOfNoteAllocations,
  decisionInvoiceIdsOf,
} from "@/lib/xero-inbound/bank-transfer-payment-of-invoice";

type Payment = { id: string; source: string; xeroInvoiceId: string | null };
type Link = { localModel: string; localId: string; xeroObjectType: string; xeroObjectId: string; role: string; active: boolean; metadata?: unknown };

/** A store holding these payments and links, answering the reads the rule makes. */
function store(payments: Payment[], links: Link[]) {
  const linkFindMany = vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
    const ids = (where.xeroObjectId as { in?: string[] } | undefined)?.in;
    const localIds = (where.localId as { in?: string[] } | undefined)?.in;
    if (where.role === "PRIMARY_INVOICE") {
      return links.filter(
        (link) =>
          link.localModel === "Payment" && link.xeroObjectType === "INVOICE" && link.role === "PRIMARY_INVOICE" && link.active &&
          (!ids || ids.includes(link.xeroObjectId)) && (!localIds || localIds.includes(link.localId)),
      );
    }
    const creditNoteId = (where.metadata as { equals: string }).equals;
    return links.filter((link) => link.xeroObjectType === "ALLOCATION" && link.active && (link.metadata as { creditNoteId?: string })?.creditNoteId === creditNoteId);
  });
  type PaymentWhere = { source?: string; OR?: Array<{ xeroInvoiceId?: { in: string[] }; id?: { in: string[] } }>; xeroInvoiceId?: { in: string[] } };
  const paymentFindMany = vi.fn(async ({ where }: { where: PaymentWhere }) =>
    // Two shapes: the settle's filter (a source and an OR), or any payment stamped with one of these invoices.
    payments.filter((payment) =>
      where.OR
        ? payment.source === where.source &&
          where.OR.some((clause) => clause.xeroInvoiceId?.in.includes(payment.xeroInvoiceId ?? "") || clause.id?.in.includes(payment.id))
        : where.xeroInvoiceId!.in.includes(payment.xeroInvoiceId ?? ""),
    ),
  );
  return { db: { xeroObjectLink: { findMany: linkFindMany }, payment: { findMany: paymentFindMany } } as never, linkFindMany };
}

const invoiceLink = (paymentId: string, invoiceId: string, active = true): Link => ({
  localModel: "Payment", localId: paymentId, xeroObjectType: "INVOICE", xeroObjectId: invoiceId, role: "PRIMARY_INVOICE", active,
});

describe("bankTransferPaymentsOfInvoiceWhere", () => {
  it("is the settle's filter: a bank transfer by its own invoice id, or one of the linked payments", () => {
    expect(bankTransferPaymentsOfInvoiceWhere("inv-1", ["pay-2"])).toEqual({
      source: "INTERNET_BANKING",
      OR: [{ xeroInvoiceId: "inv-1" }, { id: { in: ["pay-2"] } }],
    });
    expect(bankTransferPaymentsOfInvoiceWhere("inv-1", [])).toEqual({ source: "INTERNET_BANKING", OR: [{ xeroInvoiceId: "inv-1" }] });
  });
});

describe("bankTransferPaymentIdsOfInvoices (#5289 C)", () => {
  it("MUTATION (link-only): names a bank transfer found only by its active invoice link, as the settle finds it", async () => {
    const { db } = store([{ id: "pay-1", source: "INTERNET_BANKING", xeroInvoiceId: null }], [invoiceLink("pay-1", "inv-1")]);
    await expect(bankTransferPaymentIdsOfInvoices(["inv-1"], db)).resolves.toEqual(new Map([["inv-1", "pay-1"]]));
  });

  it("names one found by its own invoice id, and none by an inactive link", async () => {
    const { db } = store(
      [{ id: "pay-1", source: "INTERNET_BANKING", xeroInvoiceId: "inv-1" }, { id: "pay-2", source: "INTERNET_BANKING", xeroInvoiceId: null }],
      [invoiceLink("pay-2", "inv-2", false)],
    );
    await expect(bankTransferPaymentIdsOfInvoices(["inv-1", "inv-2"], db)).resolves.toEqual(new Map([["inv-1", "pay-1"]]));
  });

  it("MUTATION (exactly one): names none when two bank transfers match, by id and by link", async () => {
    const { db } = store(
      [{ id: "pay-1", source: "INTERNET_BANKING", xeroInvoiceId: "inv-1" }, { id: "pay-2", source: "INTERNET_BANKING", xeroInvoiceId: null }],
      [invoiceLink("pay-2", "inv-1")],
    );
    await expect(bankTransferPaymentIdsOfInvoices(["inv-1"], db)).resolves.toEqual(new Map());
  });

  it("counts only bank transfers, as the settle does: a card payment on the invoice neither matches nor blocks", async () => {
    const { db } = store(
      [{ id: "pay-1", source: "INTERNET_BANKING", xeroInvoiceId: "inv-1" }, { id: "pay-card", source: "STRIPE", xeroInvoiceId: "inv-1" }],
      [],
    );
    await expect(bankTransferPaymentIdsOfInvoices(["inv-1"], db)).resolves.toEqual(new Map([["inv-1", "pay-1"]]));
  });

  it("asks nothing for no invoice", async () => {
    const { db, linkFindMany } = store([], []);
    await expect(bankTransferPaymentIdsOfInvoices([], db)).resolves.toEqual(new Map());
    expect(linkFindMany).not.toHaveBeenCalled();
  });
});

describe("decisionInvoiceIdsOf (#5289 C)", () => {
  it("MUTATION (one invoice per payment): its own invoice id, never an older invoice it is still linked to", async () => {
    const { db } = store([], [invoiceLink("pay-1", "inv-old")]);
    await expect(decisionInvoiceIdsOf([{ id: "pay-1", source: "INTERNET_BANKING" as never, xeroInvoiceId: "inv-1" }], db)).resolves.toEqual(new Map([["pay-1", "inv-1"]]));
  });

  it("MUTATION (link-only): with none stamped, the invoice its only active link names; none when two do", async () => {
    const { db } = store(
      [{ id: "pay-1", source: "INTERNET_BANKING", xeroInvoiceId: null }, { id: "pay-2", source: "INTERNET_BANKING", xeroInvoiceId: null }],
      [invoiceLink("pay-1", "inv-1"), invoiceLink("pay-2", "inv-2"), invoiceLink("pay-2", "inv-3")],
    );
    await expect(
      decisionInvoiceIdsOf(
        [
          { id: "pay-1", source: "INTERNET_BANKING" as never, xeroInvoiceId: null },
          { id: "pay-2", source: "INTERNET_BANKING" as never, xeroInvoiceId: null },
        ],
        db,
      ),
    ).resolves.toEqual(new Map([["pay-1", "inv-1"]]));
  });

  it("MUTATION (the invoice's one payment): an unstamped payment linked to an invoice another payment owns, or shares, takes no invoice", async () => {
    // pay-1 owns inv-1 by its own id and pay-2 is linked to it; pay-4 and pay-5 are both linked to inv-2;
    // card payment card-1 is stamped with inv-3, which pay-6 is linked to.
    const { db } = store(
      [
        { id: "pay-1", source: "INTERNET_BANKING", xeroInvoiceId: "inv-1" },
        { id: "pay-2", source: "INTERNET_BANKING", xeroInvoiceId: null },
        { id: "pay-4", source: "INTERNET_BANKING", xeroInvoiceId: null },
        { id: "pay-5", source: "INTERNET_BANKING", xeroInvoiceId: null },
        { id: "pay-6", source: "INTERNET_BANKING", xeroInvoiceId: null },
        { id: "card-1", source: "STRIPE", xeroInvoiceId: "inv-3" },
      ],
      [invoiceLink("pay-2", "inv-1"), invoiceLink("pay-4", "inv-2"), invoiceLink("pay-5", "inv-2"), invoiceLink("pay-6", "inv-3")],
    );
    await expect(
      decisionInvoiceIdsOf(
        (["pay-1", "pay-2", "pay-4", "pay-5", "pay-6"] as const).map((id) => ({ id, source: "INTERNET_BANKING" as never, xeroInvoiceId: id === "pay-1" ? "inv-1" : null })),
        db,
      ),
    ).resolves.toEqual(new Map([["pay-1", "inv-1"]]));
  });

  it("MUTATION (#4444): a card payment counts its own invoice; with none stamped, no linked one (the settle's rule is bank-transfer only)", async () => {
    const { db } = store([], [invoiceLink("pay-2", "inv-2")]);
    await expect(
      decisionInvoiceIdsOf(
        [
          { id: "pay-1", source: "STRIPE" as never, xeroInvoiceId: "inv-1" },
          { id: "pay-2", source: "STRIPE" as never, xeroInvoiceId: null },
        ],
        db,
      ),
    ).resolves.toEqual(new Map([["pay-1", "inv-1"]]));
  });
});

describe("bankTransferPaymentsOfNoteAllocations (#5289 A)", () => {
  it("MUTATION (active only): the note's still-active allocation links, in one order, each with the payment its invoice names", async () => {
    const allocation = (id: string, invoiceId: string, active = true): Link => ({
      localModel: "BookingModification", localId: "mod-1", xeroObjectType: "ALLOCATION", xeroObjectId: id, role: "MODIFICATION_CREDIT_NOTE_ALLOCATION", active,
      metadata: { creditNoteId: "cn-1", invoiceId, amountCents: 1_000 },
    });
    const { db, linkFindMany } = store(
      [{ id: "pay-1", source: "INTERNET_BANKING", xeroInvoiceId: "inv-1" }],
      [allocation("a-1", "inv-1"), allocation("a-2", "inv-none"), allocation("a-3", "inv-1", false)],
    );
    const found = await bankTransferPaymentsOfNoteAllocations("cn-1", db);
    expect(found.map((entry) => [entry.link.xeroObjectId, entry.invoiceId, entry.paymentId])).toEqual([
      ["a-1", "inv-1", "pay-1"],
      ["a-2", "inv-none", null],
    ]);
    expect(linkFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          xeroObjectType: "ALLOCATION",
          active: true,
          role: { in: ["MODIFICATION_CREDIT_NOTE_ALLOCATION", "CREDIT_NOTE_ALLOCATION"] },
          metadata: { path: ["creditNoteId"], equals: "cn-1" },
        },
        orderBy: [{ xeroObjectId: "asc" }, { localModel: "asc" }, { localId: "asc" }, { role: "asc" }],
      }),
    );
  });
});
