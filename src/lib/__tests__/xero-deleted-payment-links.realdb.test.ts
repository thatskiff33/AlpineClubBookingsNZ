/**
 * Real-PostgreSQL proof of #4531 (`INV-INT-031`): an invoice re-read after one
 * of its payments was deleted in Xero retires that payment's link (inactive,
 * recorded status DELETED) and keeps the hand-entered replacement active; a
 * replay writes nothing and asks Xero nothing; a payload without `Payments`
 * retires nothing; the guarded write never overwrites a concurrent writer's
 * metadata; a candidate Xero could not answer for is marked and the scheduled
 * re-check retires it; an operation on the payment's record that may still run
 * holds the retire back until it is done; and the backfill's `--apply` retires
 * through the same write.
 *
 * Only Xero's client is doubled (synthetic payloads); every link read and
 * write is the real one. Ordinary Vitest runs skip the whole file. It reuses
 * the guarded, disposable loopback PostgreSQL the race harness provisions,
 * which imports this file so CI reaches it; it owns and cleans its own
 * `race-4531-` fixtures.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";
import { assertSafeRaceDbUrl } from "./support/race-db-url";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const P = "race-4531";
const LOCAL_PAYMENT = `${P}-payment`;
const INVOICE = `${P}-invoice`;
const DELETED = `${P}-xpay-deleted`;
const REPLACEMENT = `${P}-xpay-replacement`;

let db: (typeof import("@/lib/prisma"))["prisma"];
const spies: Array<{ mockRestore(): void }> = [];
const getPayment = vi.fn();
const getPayments = vi.fn();
let invoicePayload: Record<string, unknown>;

(RUN ? describe : describe.skip)("a payment deleted in Xero retires its link - real PostgreSQL (#4531)", { timeout: 60_000 }, () => {
  async function clean() {
    await db.xeroObjectLink.deleteMany({ where: { localId: LOCAL_PAYMENT } });
    await db.xeroSyncOperation.deleteMany({ where: { localModel: "Payment", localId: LOCAL_PAYMENT } });
    await db.xeroSyncCursor.deleteMany({ where: { resourceType: "DELETED_PAYMENT_RECHECK" } });
  }

  async function seed() {
    await clean();
    await db.xeroObjectLink.create({
      data: { localModel: "Payment", localId: LOCAL_PAYMENT, xeroObjectType: "INVOICE", xeroObjectId: INVOICE, role: "PRIMARY_INVOICE" },
    });
    for (const xeroObjectId of [DELETED, REPLACEMENT]) {
      await db.xeroObjectLink.create({
        data: {
          localModel: "Payment",
          localId: LOCAL_PAYMENT,
          xeroObjectType: "PAYMENT",
          xeroObjectId,
          role: "INVOICE_PAYMENT",
          // The production shape: the app's own write, with no recorded status.
          metadata: { invoiceId: INVOICE, amount: 120, status: null },
        },
      });
    }
  }

  const paymentLink = (xeroObjectId: string) =>
    db.xeroObjectLink.findFirstOrThrow({
      where: { localId: LOCAL_PAYMENT, xeroObjectType: "PAYMENT", xeroObjectId },
      select: { active: true, metadata: true, updatedAt: true, id: true },
    });

  beforeAll(async () => {
    assertSafeRaceDbUrl(DB_URL, "Deleted Xero payment links");
    process.env.DATABASE_URL = DB_URL;
    ({ prisma: db } = await import("@/lib/prisma"));
    const api = await import("@/lib/xero-api-client");
    spies.push(
      vi.spyOn(api, "getAuthenticatedXeroClient").mockResolvedValue({
        tenantId: "test-tenant",
        xero: {
          accountingApi: {
            getInvoice: async () => ({ body: { invoices: [invoicePayload] } }),
            getPayment,
            getPayments,
          },
        },
      } as never),
    );
    spies.push(vi.spyOn(api, "callXeroApi").mockImplementation(((fn: () => Promise<unknown>) => fn()) as never));
  });

  afterAll(async () => {
    try {
      if (db) await clean();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  beforeEach(async () => {
    getPayment.mockReset();
    getPayments.mockReset();
    getPayment.mockResolvedValue({ body: { payments: [{ paymentID: DELETED, status: "DELETED", invoice: { invoiceID: INVOICE } }] } });
    invoicePayload = {
      invoiceID: INVOICE,
      invoiceNumber: "RACE-4531",
      status: "AUTHORISED",
      total: 240,
      amountDue: 120,
      amountPaid: 120,
      payments: [{ paymentID: REPLACEMENT, amount: 120, status: "AUTHORISED" }],
    };
    await seed();
  });

  it("retires the deleted payment's link, keeps the replacement, and a replay changes nothing", async () => {
    const { reconcileXeroInvoice } = await import("@/lib/xero-inbound/invoice");

    const first = await reconcileXeroInvoice(INVOICE, CLUB_FORMAT_TEST, { skipSubscriptionRefresh: true });

    expect(first.deletedPaymentLinks).toMatchObject({ candidatePayments: 1, xeroCalls: 1, confirmedDeleted: [DELETED], retiredLinks: 1 });
    expect(await paymentLink(DELETED)).toMatchObject({ active: false, metadata: { invoiceId: INVOICE, amount: 120, status: "DELETED" } });
    expect(await paymentLink(REPLACEMENT)).toMatchObject({ active: true, metadata: { invoiceId: INVOICE, status: "AUTHORISED" } });

    const retired = await paymentLink(DELETED);
    const replay = await reconcileXeroInvoice(INVOICE, CLUB_FORMAT_TEST, { skipSubscriptionRefresh: true });

    expect(replay.deletedPaymentLinks).toMatchObject({ candidatePayments: 0, xeroCalls: 0, retiredLinks: 0 });
    expect(getPayment).toHaveBeenCalledTimes(1);
    expect(await paymentLink(DELETED)).toEqual(retired);
  });

  it("a payload without Payments retires nothing and asks Xero nothing", async () => {
    const { reconcileXeroInvoice } = await import("@/lib/xero-inbound/invoice");
    invoicePayload = { ...invoicePayload, payments: undefined };

    const result = await reconcileXeroInvoice(INVOICE, CLUB_FORMAT_TEST, { skipSubscriptionRefresh: true });

    expect(result.deletedPaymentLinks).toMatchObject({ skippedReason: "The payload carries no Payments list.", retiredLinks: 0 });
    expect(getPayment).not.toHaveBeenCalled();
    expect(await paymentLink(DELETED)).toMatchObject({ active: true, metadata: { status: null } });
  });

  it("the guarded write keeps a concurrent writer's metadata", async () => {
    const { retireDeletedXeroPaymentLink } = await import("@/lib/xero-inbound/deleted-payment-links");
    const stale = await db.xeroObjectLink.findFirstOrThrow({
      where: { localId: LOCAL_PAYMENT, xeroObjectId: DELETED },
      select: { id: true, localModel: true, localId: true, role: true, xeroObjectId: true, xeroObjectNumber: true, metadata: true },
    });
    // Another writer lands between the read and the retire.
    await db.xeroObjectLink.update({ where: { id: stale.id }, data: { metadata: { invoiceId: INVOICE, amount: 125, note: "concurrent" } } });

    expect(await retireDeletedXeroPaymentLink(stale)).toBe("retired");
    expect(await paymentLink(DELETED)).toMatchObject({
      active: false,
      metadata: { invoiceId: INVOICE, amount: 125, note: "concurrent", status: "DELETED" },
    });
    expect(await retireDeletedXeroPaymentLink(stale)).toBe("unchanged");
  });

  it("a candidate Xero could not answer for is marked, and the scheduled re-check retires it", async () => {
    const { reconcileXeroInvoice } = await import("@/lib/xero-inbound/invoice");
    const { recheckPendingDeletedPaymentLinks } = await import("@/lib/xero-inbound/deleted-payment-links");
    const { getAuthenticatedXeroClient } = await import("@/lib/xero-api-client");
    getPayment.mockRejectedValueOnce(Object.assign(new Error("Xero 503"), { response: { statusCode: 503, headers: {} } }));

    const first = await reconcileXeroInvoice(INVOICE, CLUB_FORMAT_TEST, { skipSubscriptionRefresh: true });

    expect(first.deletedPaymentLinks).toMatchObject({ deferred: [DELETED], retiredLinks: 0 });
    expect(await paymentLink(DELETED)).toMatchObject({
      active: true,
      metadata: { invoiceId: INVOICE, deletionCheckPending: true, deletionCheckAttempts: 0 },
    });

    const recheck = await recheckPendingDeletedPaymentLinks({ minimumIntervalMs: 0, session: await getAuthenticatedXeroClient() });

    expect(recheck).toMatchObject({ confirmedDeleted: [DELETED], retiredLinks: 1 });
    const retired = await paymentLink(DELETED);
    expect(retired).toMatchObject({ active: false, metadata: { invoiceId: INVOICE, amount: 120, status: "DELETED" } });
    expect(retired.metadata).not.toHaveProperty("deletionCheckPending");
    expect(await paymentLink(REPLACEMENT)).toMatchObject({ active: true });
    const again = await recheckPendingDeletedPaymentLinks({ minimumIntervalMs: 0, session: await getAuthenticatedXeroClient() });
    expect(again).toMatchObject({ candidatePayments: 0, xeroCalls: 0 });
  });

  it("a PARTIAL invoice operation on the payment holds the retire back until it completes", async () => {
    const { reconcileXeroInvoice } = await import("@/lib/xero-inbound/invoice");
    const { recheckPendingDeletedPaymentLinks } = await import("@/lib/xero-inbound/deleted-payment-links");
    const { getAuthenticatedXeroClient } = await import("@/lib/xero-api-client");
    const partial = await db.xeroSyncOperation.create({
      data: {
        direction: "OUTBOUND",
        entityType: "INVOICE",
        operationType: "CREATE",
        localModel: "Payment",
        localId: LOCAL_PAYMENT,
        status: "PARTIAL",
        correlationKey: `${P}-partial-invoice`,
      },
    });

    const held = await reconcileXeroInvoice(INVOICE, CLUB_FORMAT_TEST, { skipSubscriptionRefresh: true });

    expect(held.deletedPaymentLinks).toMatchObject({ blocked: [DELETED], retiredLinks: 0, xeroCalls: 0 });
    expect(getPayment).not.toHaveBeenCalled();
    expect(await paymentLink(DELETED)).toMatchObject({
      active: true,
      metadata: { deletionCheckPending: true, deletionCheckBlockedBy: partial.id },
    });

    await db.xeroSyncOperation.update({ where: { id: partial.id }, data: { status: "SUCCEEDED" } });
    const recheck = await recheckPendingDeletedPaymentLinks({ minimumIntervalMs: 0, session: await getAuthenticatedXeroClient() });

    expect(recheck).toMatchObject({ confirmedDeleted: [DELETED], retiredLinks: 1, blocked: [] });
    expect(await paymentLink(DELETED)).toMatchObject({ active: false, metadata: { status: "DELETED" } });
  });

  it("the backfill's --apply retires through the same write, once", async () => {
    const { applyDeletedPaymentLinkBackfill } = await import("@/lib/xero-deleted-payment-link-backfill");
    const { getAuthenticatedXeroClient } = await import("@/lib/xero-api-client");
    getPayments.mockResolvedValue({ body: { payments: [{ paymentID: DELETED, status: "DELETED" }] } });
    const session = await getAuthenticatedXeroClient();

    const first = await applyDeletedPaymentLinkBackfill(session, { paymentIds: [DELETED, REPLACEMENT] });
    expect(first).toMatchObject({ confirmedDeleted: [DELETED], retiredLinks: 1 });
    expect(await paymentLink(DELETED)).toMatchObject({ active: false, metadata: { status: "DELETED" } });
    expect(await paymentLink(REPLACEMENT)).toMatchObject({ active: true });

    const again = await applyDeletedPaymentLinkBackfill(session, { paymentIds: [DELETED, REPLACEMENT] });
    expect(again.report.candidates).toEqual([]);
    expect(again.retiredLinks).toBe(0);
  });
});
