import { beforeEach, describe, expect, it, vi } from "vitest";
import { Invoice } from "xero-node";
import type { SubscriptionStatus } from "@prisma/client";

/**
 * The membership sync's mapping of an age-up top-up's Xero invoice to its
 * adjustment (#5190 PR 3). A top-up is a coverage-less charge, so nothing else
 * in the sync reads it: this is what makes an issued, unpaid top-up hold a
 * member back, a paid one release them, and a voided one stay voided.
 *
 * The database double keeps rows and applies each write's `where`, so a guard
 * that is removed from the code changes what these tests observe.
 */

type AdjustmentRow = {
  id: string;
  kind: "TOP_UP" | "CREDIT";
  status: "PENDING" | "VOIDED" | "CREDITED_ON_INVOICE" | "CREDITED_TO_ACCOUNT";
  chargeId: string | null;
  xeroInvoiceStatus: SubscriptionStatus | null;
};
type ChargeRow = { id: string; status: string; xeroInvoiceId: string | null };

const store = vi.hoisted(() => ({
  adjustments: [] as AdjustmentRow[],
  charges: [] as ChargeRow[],
  /** What the adjustment read returns, when a test needs it to be out of date. */
  staleRead: null as AdjustmentRow[] | null,
}));

/** A flat `where`: a plain value must equal the column; `{ in: [...] }` must contain it. */
function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([column, wanted]) => {
    if (wanted && typeof wanted === "object" && "in" in wanted) {
      return (wanted as { in: unknown[] }).in.includes(row[column]);
    }
    return row[column] === wanted;
  });
}

function updateMany<Row extends Record<string, unknown>>(rows: Row[]) {
  return vi.fn(async (args: { where: Record<string, unknown>; data: Partial<Row> }) => {
    const hit = rows.filter((row) => matches(row, args.where));
    for (const row of hit) Object.assign(row, args.data);
    return { count: hit.length };
  });
}

const db = vi.hoisted(() => ({
  memberSubscriptionAgeUpAdjustment: { findMany: vi.fn(), updateMany: vi.fn() },
  membershipSubscriptionCharge: { findMany: vi.fn(), updateMany: vi.fn() },
  $transaction: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: db }));

import { requireCalendarDate } from "@/lib/club-time";
import { syncAgeUpTopUpInvoices, withoutAgeUpTopUpInvoices } from "@/lib/subscription-age-up-sync";

const invoice = (invoiceID: string, status: Invoice.StatusEnum = Invoice.StatusEnum.AUTHORISED) =>
  ({ invoiceID, status }) as Invoice;

/** The club's today the sweep judges an unpaid invoice's due day against. */
const TODAY = requireCalendarDate("2026-07-01");

const chargeOf = (adjustment: AdjustmentRow) => store.charges.find((charge) => charge.id === adjustment.chargeId);

beforeEach(() => {
  store.adjustments = [
    { id: "top-up-1", kind: "TOP_UP", status: "PENDING", chargeId: "charge-1", xeroInvoiceStatus: "UNPAID" },
  ];
  store.charges = [{ id: "charge-1", status: "EMAILED", xeroInvoiceId: "inv-1" }];
  store.staleRead = null;

  db.memberSubscriptionAgeUpAdjustment.findMany.mockImplementation(
    async (args: { where: { kind: string; status: string; charge: { xeroInvoiceId: { in: string[] } } } }) =>
      (store.staleRead ?? store.adjustments)
        .filter((row) => row.kind === args.where.kind && row.status === args.where.status)
        .map((row) => ({ ...row, charge: chargeOf(row) ?? null }))
        .filter((row) => row.charge?.xeroInvoiceId && args.where.charge.xeroInvoiceId.in.includes(row.charge.xeroInvoiceId)),
  );
  db.memberSubscriptionAgeUpAdjustment.updateMany = updateMany(store.adjustments);
  db.membershipSubscriptionCharge.updateMany = updateMany(store.charges);
  db.membershipSubscriptionCharge.findMany.mockImplementation(
    async (args: { where: { xeroInvoiceId: { in: string[] } } }) =>
      store.charges
        .filter((charge) => charge.xeroInvoiceId && args.where.xeroInvoiceId.in.includes(charge.xeroInvoiceId))
        .filter((charge) => store.adjustments.some((row) => row.chargeId === charge.id))
        .map((charge) => ({ xeroInvoiceId: charge.xeroInvoiceId })),
  );
  db.$transaction.mockImplementation(async (run: (tx: typeof db) => unknown) => run(db));
});

describe("syncAgeUpTopUpInvoices (#5190 PR 3)", () => {
  it("marks a top-up paid when its invoice is paid, and writes nothing on a repeat sweep", async () => {
    const paid = [invoice("inv-1", Invoice.StatusEnum.PAID)];

    expect(await syncAgeUpTopUpInvoices(paid, TODAY)).toBe(1);
    expect(store.adjustments[0]).toMatchObject({ status: "PENDING", xeroInvoiceStatus: "PAID" });

    expect(await syncAgeUpTopUpInvoices(paid, TODAY)).toBe(0);
    expect(db.memberSubscriptionAgeUpAdjustment.updateMany).toHaveBeenCalledTimes(1);
  });

  it("reads only top-ups whose charge carries one of the changed invoices", async () => {
    store.adjustments.push({ id: "top-up-2", kind: "TOP_UP", status: "PENDING", chargeId: "charge-2", xeroInvoiceStatus: "UNPAID" });
    store.charges.push({ id: "charge-2", status: "EMAILED", xeroInvoiceId: "inv-2" });

    expect(await syncAgeUpTopUpInvoices([invoice("inv-2", Invoice.StatusEnum.PAID), invoice("inv-season")], TODAY)).toBe(1);

    expect(store.adjustments.map((row) => row.xeroInvoiceStatus)).toEqual(["UNPAID", "PAID"]);
  });

  it("makes no read when no changed invoice has an id", async () => {
    expect(await syncAgeUpTopUpInvoices([{ status: Invoice.StatusEnum.PAID } as Invoice], TODAY)).toBe(0);
    expect(db.memberSubscriptionAgeUpAdjustment.findMany).not.toHaveBeenCalled();
  });

  it.each([Invoice.StatusEnum.VOIDED, Invoice.StatusEnum.DELETED])(
    "voids the adjustment and its charge when the invoice is %s, once",
    async (status) => {
      expect(await syncAgeUpTopUpInvoices([invoice("inv-1", status)], TODAY)).toBe(1);
      expect(store.adjustments[0]).toMatchObject({ status: "VOIDED" });
      expect(store.charges[0]).toMatchObject({ status: "VOIDED" });

      // A voided top-up is no longer PENDING, so the next sweep does not read it.
      expect(await syncAgeUpTopUpInvoices([invoice("inv-1", status)], TODAY)).toBe(0);
    },
  );

  it("turns an unpaid top-up overdue once the club's today is past its due day, not on it", async () => {
    const due = (dueDate: string) => ({ ...invoice("inv-1"), dueDate }) as Invoice;

    expect(await syncAgeUpTopUpInvoices([due("2026-07-01")], TODAY)).toBe(0);
    expect(store.adjustments[0]).toMatchObject({ xeroInvoiceStatus: "UNPAID" });

    expect(await syncAgeUpTopUpInvoices([due("2026-06-30")], TODAY)).toBe(1);
    expect(store.adjustments[0]).toMatchObject({ status: "PENDING", xeroInvoiceStatus: "OVERDUE" });
  });

  it("MUTATION (status guard): never revives a top-up another sweep voided after this one read it", async () => {
    // This sweep read the top-up as PENDING; before it writes, the row is VOIDED.
    store.staleRead = [{ ...store.adjustments[0]! }];
    store.adjustments[0]!.status = "VOIDED";
    store.charges[0]!.status = "VOIDED";

    expect(await syncAgeUpTopUpInvoices([invoice("inv-1", Invoice.StatusEnum.PAID)], TODAY)).toBe(0);

    expect(store.adjustments[0]).toMatchObject({ status: "VOIDED", xeroInvoiceStatus: "UNPAID" });
  });

  it("MUTATION (status guard): a void that lost the claim leaves the charge alone", async () => {
    // Read as PENDING, then voided elsewhere while its charge is being re-driven.
    store.staleRead = [{ ...store.adjustments[0]! }];
    store.adjustments[0]!.status = "VOIDED";

    expect(await syncAgeUpTopUpInvoices([invoice("inv-1", Invoice.StatusEnum.VOIDED)], TODAY)).toBe(0);

    expect(db.membershipSubscriptionCharge.updateMany).not.toHaveBeenCalled();
    expect(store.charges[0]).toMatchObject({ status: "EMAILED" });
  });

  it("MUTATION (previous-status guard): does not overwrite a status a newer sweep already wrote", async () => {
    // This sweep read UNPAID and judges OVERDUE; a newer one has since written PAID.
    store.staleRead = [{ ...store.adjustments[0]! }];
    store.adjustments[0]!.xeroInvoiceStatus = "PAID";

    const overdue = { ...invoice("inv-1"), dueDate: "2026-06-30" } as Invoice;
    expect(await syncAgeUpTopUpInvoices([overdue], TODAY)).toBe(0);

    expect(store.adjustments[0]).toMatchObject({ xeroInvoiceStatus: "PAID" });
  });
});

describe("withoutAgeUpTopUpInvoices (#5190 PR 3)", () => {
  it("takes a top-up's invoice out of the member's season-invoice candidates", async () => {
    const season = invoice("inv-season");
    expect(await withoutAgeUpTopUpInvoices([season, invoice("inv-1")])).toEqual([season]);
    expect(db.membershipSubscriptionCharge.findMany).toHaveBeenCalledWith({
      where: { xeroInvoiceId: { in: ["inv-season", "inv-1"] }, ageUpAdjustment: { isNot: null } },
      select: { xeroInvoiceId: true },
    });
  });

  it("returns the same list, unread, when there is nothing to look up", async () => {
    const none: Invoice[] = [];
    expect(await withoutAgeUpTopUpInvoices(none)).toBe(none);
    expect(db.membershipSubscriptionCharge.findMany).not.toHaveBeenCalled();
  });

  it("returns the same list when none of them is a top-up", async () => {
    const invoices = [invoice("inv-season"), invoice("inv-other")];
    expect(await withoutAgeUpTopUpInvoices(invoices)).toBe(invoices);
  });
});
