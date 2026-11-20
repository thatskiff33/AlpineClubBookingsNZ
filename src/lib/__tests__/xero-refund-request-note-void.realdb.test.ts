/**
 * Real-PostgreSQL proof of #4195 (`INV-ADDPAY-041`, `INV-PAY-118`): a refund
 * request's OWN Xero refund credit note, voided in Xero.
 *
 * The inbound reconcile of that note writes its mirror inactive (before #4195
 * the request role kept it active) and moves no refunded total. No retry of
 * the request's failed row re-raises it (#4214: the officer decides). A
 * re-raise never takes the voided note as the request's cover: it raises a
 * fresh note, under a Xero key naming the voided one, so a Xero that still
 * remembers the request's key cannot replay it back. And a status-less link
 * write racing the void keeps it.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions, which
 * imports this file so CI reaches it; it owns and cleans its own `race-4195-`
 * fixtures.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";
import { realElapsedMs } from "@/lib/__tests__/helpers/clock";
import { releaseBookingJournalForTeardown } from "./support/booking-financial-history-teardown";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const MEMBER_ID = "race-4195-member";
const LODGE_ID = "race-4195-lodge";
const BOOKING_ID = "race-4195-booking";
const PAYMENT_ID = "race-4195-payment";
const REQUEST_ID = "race-4195-request";
const VOIDED_NOTE = "cn-race-4195-first";
const FRESH_NOTE = "cn-race-4195-fresh";
const REQUEST_KEY = `payment:${PAYMENT_ID}:refund-request-credit-note:${REQUEST_ID}:v1`;

/** Standalone fail-closed copy: importing this file must not register another suite. */
export function assertSafeRequestNoteVoidRaceDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Refund-request note void proofs need a valid CONCURRENCY_RACE_DATABASE_URL.");
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(
      `Refusing to run refund-request note void proofs against port ${parsed.port || "(none)"}: use a throwaway PostgreSQL on 55442+ (never 5432).`,
    );
  }
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname.toLowerCase())) {
    throw new Error("Refund-request note void proof DB must be loopback-only.");
  }
  if (!decodeURIComponent(parsed.pathname.replace(/^\//, "")).includes("concurrency_race_1881")) {
    throw new Error("Refund-request note void proof DB name must contain 'concurrency_race_1881'.");
  }
}

let prisma: (typeof import("@/lib/prisma"))["prisma"];

(RUN ? describe : describe.skip)(
  "a refund request's own Xero note voided in Xero is never re-adopted - real PostgreSQL (#4195)",
  { timeout: 60_000 },
  () => {
    async function deleteFixtures() {
      // #4525 (M13): the refund note this suite raises leaves an export manifest naming the booking.
      await releaseBookingJournalForTeardown(prisma, [BOOKING_ID]);
      await prisma.xeroSyncOperation.deleteMany({ where: { localModel: "Payment", localId: PAYMENT_ID } });
      await prisma.xeroObjectLink.deleteMany({ where: { localId: PAYMENT_ID } });
      await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
      await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
    }

    beforeAll(async () => {
      assertSafeRequestNoteVoidRaceDbUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      await deleteFixtures();
      await prisma.member.create({
        data: { id: MEMBER_ID, email: `${MEMBER_ID}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Request", lastName: "Proof", role: "ADMIN", ageTier: "ADULT" },
      });
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4195 Lodge", slug: "race-4195" } });
      await prisma.booking.create({
        data: {
          id: BOOKING_ID, memberId: MEMBER_ID, lodgeId: LODGE_ID, status: "CONFIRMED", totalPriceCents: 20_000, finalPriceCents: 20_000,
          checkIn: new Date("2026-08-01T00:00:00.000Z"), checkOut: new Date("2026-08-03T00:00:00.000Z"),
        },
      });
      // The treasurer paid the request's $50 back by hand: the refunded total holds it.
      await prisma.payment.create({
        data: {
          id: PAYMENT_ID, bookingId: BOOKING_ID, amountCents: 20_000, source: "INTERNET_BANKING", status: "PARTIALLY_REFUNDED",
          refundedAmountCents: 5_000, xeroInvoiceId: "inv-race-4195",
        },
      });
      const queued = { queueType: "REFUND_CREDIT_NOTE", refundAmountCents: 5_000, refundMethod: "internet-banking", refundRequestId: REQUEST_ID };
      // The request's own row, failed before Xero raised anything...
      await prisma.xeroSyncOperation.create({
        data: {
          id: "race-4195-op-failed", direction: "OUTBOUND", entityType: "CREDIT_NOTE", operationType: "CREATE", localModel: "Payment",
          localId: PAYMENT_ID, status: "FAILED", idempotencyKey: REQUEST_KEY, correlationKey: REQUEST_KEY, queueType: "REFUND_CREDIT_NOTE",
          requestPayload: queued, lastErrorMessage: "Xero 503 on create",
        },
      });
      // ...then an earlier retry raised the request's note, under the request's one key.
      await prisma.xeroSyncOperation.create({
        data: {
          id: "race-4195-op-raised", direction: "OUTBOUND", entityType: "CREDIT_NOTE", operationType: "CREATE", localModel: "Payment",
          localId: PAYMENT_ID, status: "SUCCEEDED", idempotencyKey: REQUEST_KEY, correlationKey: REQUEST_KEY,
          requestPayload: { allocation: { invoiceId: "inv-race-4195", amount: 50 }, refundMethod: "internet-banking", refundRequestId: REQUEST_ID },
          xeroObjectType: "CREDIT_NOTE", xeroObjectId: VOIDED_NOTE, completedAt: new Date("2026-06-01T00:00:00.000Z"),
        },
      });
      await prisma.xeroObjectLink.create({
        data: {
          localModel: "Payment", localId: PAYMENT_ID, xeroObjectType: "CREDIT_NOTE", xeroObjectId: VOIDED_NOTE, xeroObjectNumber: "CN-4195",
          role: "REFUND_REQUEST_CREDIT_NOTE", active: true, metadata: { amountCents: 5_000, watermarkCents: 5_000, refundRequestId: REQUEST_ID },
        },
      });
    }, 60_000);

    afterAll(async () => {
      if (!prisma) return;
      await deleteFixtures();
    }, 60_000);

    /** Swap in a fake Xero (no provider call) for the length of `run`. */
    async function withFakeXero<T>(accountingApi: Record<string, unknown>, run: () => Promise<T>): Promise<T> {
      const apiClient = await import("@/lib/xero-api-client");
      const contacts = await import("@/lib/xero-contacts");
      const invoicedParty = await import("@/lib/organisation-xero-contacts");
      const invoicePayments = await import("@/lib/xero-invoice-payments");
      const spies = [
        vi.spyOn(apiClient, "getAuthenticatedXeroClient").mockResolvedValue({ xero: { accountingApi }, tenantId: "tenant-4195" } as never),
        vi.spyOn(apiClient, "callXeroApi").mockImplementation(((call: () => unknown) => call()) as never),
        vi.spyOn(invoicedParty, "findOrCreateXeroContactForInvoicedParty").mockResolvedValue("contact-4195"),
        vi.spyOn(contacts, "retryXeroWriteWithContactRepair").mockImplementation((async (options: { run: (input: { contactId: string }) => unknown; currentContactId: string }) =>
          options.run({ contactId: options.currentContactId })) as never),
        // No bank-transfer refund account mapped: the note is left unsettled, which this proof does not read.
        vi.spyOn(invoicePayments, "resolveRefundSettlement").mockResolvedValue({ kind: "unsettled", reason: "race-4195" }),
      ];
      try {
        return await run();
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
    }

    async function requestLinks() {
      const links = await prisma.xeroObjectLink.findMany({
        where: { localId: PAYMENT_ID, role: "REFUND_REQUEST_CREDIT_NOTE" },
        select: { xeroObjectId: true, active: true, metadata: true },
        orderBy: { xeroObjectId: "asc" },
      });
      return links.map((link) => {
        const metadata = link.metadata as Record<string, unknown>;
        return { id: link.xeroObjectId, active: link.active, status: metadata.status ?? null, requestId: metadata.refundRequestId };
      });
    }

    it("the inbound void writes the mirror inactive and moves no money; no retry re-raises it, and a re-raise takes a fresh note, never the voided one", async () => {
      const { reconcileXeroCreditNote } = await import("@/lib/xero-inbound/credit-note");
      const voided = {
        creditNoteID: VOIDED_NOTE, creditNoteNumber: "CN-4195", status: "VOIDED",
        total: 50, appliedAmount: 0, remainingCredit: 0, allocations: [], payments: [],
      };
      const reconcile = () =>
        withFakeXero({ getCreditNote: async () => ({ body: { creditNotes: [voided] } }) }, () => reconcileXeroCreditNote(VOIDED_NOTE));

      await reconcile();

      // Before #4195 the request role kept `active: true` beside VOIDED.
      expect(await requestLinks()).toEqual([{ id: VOIDED_NOTE, active: false, status: "VOIDED", requestId: REQUEST_ID }]);
      // The void of a request's note moves no refunded total, and no pointer.
      const payment = await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID }, select: { refundedAmountCents: true, xeroRefundCreditNoteId: true } });
      expect(payment).toEqual({ refundedAmountCents: 5_000, xeroRefundCreditNoteId: null });
      // A redelivery leaves it as it is.
      await reconcile();
      expect(await requestLinks()).toEqual([{ id: VOIDED_NOTE, active: false, status: "VOIDED", requestId: REQUEST_ID }]);

      // #4214 (owner decision): no retry re-raises it. The stale failed row's
      // retry is refused before anything is queued or sent to Xero.
      const { retryXeroSyncOperation } = await import("@/lib/xero-operation-retry");
      const { enqueueXeroSyncOperationRetry } = await import("@/lib/xero-operation-queue");
      await expect(retryXeroSyncOperation("race-4195-op-failed", CLUB_FORMAT_TEST)).rejects.toMatchObject({ status: 409 });
      await expect(enqueueXeroSyncOperationRetry("race-4195-op-failed")).rejects.toMatchObject({ status: 409 });
      expect(await prisma.xeroSyncOperation.count({ where: { localModel: "Payment", localId: PAYMENT_ID } })).toBe(2);

      // The re-raise itself: the builder an officer's action runs (#4214), for
      // the request's amount. A Xero that remembers the request's key would
      // hand the voided note back for it.
      const keys: string[] = [];
      const { createXeroCreditNote } = await import("@/lib/xero-credit-notes");
      await withFakeXero(
        {
          createCreditNotes: async (_t: string, body: { creditNotes: Array<{ lineItems: Array<{ unitAmount: number }> }> }, _s?: unknown, _u?: unknown, key?: string) => {
            keys.push(key!);
            const replay = key === REQUEST_KEY;
            const total = body.creditNotes[0]!.lineItems[0]!.unitAmount;
            return {
              body: {
                creditNotes: [{
                  creditNoteID: replay ? VOIDED_NOTE : FRESH_NOTE, creditNoteNumber: replay ? "CN-4195" : "CN-4195-2",
                  total, remainingCredit: total, status: "AUTHORISED", payments: [],
                }],
              },
            };
          },
          getCreditNote: async () => ({ body: { creditNotes: [] } }),
        },
        () => createXeroCreditNote(PAYMENT_ID, 5_000, { refundRequestId: REQUEST_ID, refundMethod: "internet-banking" }),
      );

      expect(keys).toEqual([`${REQUEST_KEY}:after-void:${VOIDED_NOTE}`]);
      expect(await requestLinks()).toEqual([
        { id: VOIDED_NOTE, active: false, status: "VOIDED", requestId: REQUEST_ID },
        { id: FRESH_NOTE, active: true, status: null, requestId: REQUEST_ID },
      ]);
      const raised = await prisma.xeroSyncOperation.findFirstOrThrow({
        where: { localModel: "Payment", localId: PAYMENT_ID, xeroObjectId: FRESH_NOTE },
        select: { status: true, idempotencyKey: true },
      });
      expect(raised).toEqual({ status: "SUCCEEDED", idempotencyKey: `${REQUEST_KEY}:after-void:${VOIDED_NOTE}` });
      // A request's note never takes the payment's one refund-note pointer.
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID } })).xeroRefundCreditNoteId).toBeNull();
    });

    /** Poll until a backend waits on a lock `blockerPid` holds. */
    async function waitForBlockedBy(blockerPid: number) {
      const startedAt = process.hrtime.bigint();
      while (realElapsedMs(startedAt) < 10_000) {
        const rows = await prisma.$queryRaw<Array<{ count: number }>>`
          SELECT COUNT(*)::int AS "count" FROM pg_stat_activity
          WHERE datname = current_database() AND ${blockerPid}::int = ANY(pg_blocking_pids(pid))
        `;
        if ((rows[0]?.count ?? 0) >= 1) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Timed out waiting for the retry's link write to queue behind the void held by pid ${blockerPid}.`);
    }

    it("a retry's status-less link write that waited on an inbound void keeps the void: inactive, status kept (race)", async () => {
      const RACE_NOTE = "cn-race-4195-race";
      await prisma.xeroObjectLink.create({
        data: {
          localModel: "Payment", localId: PAYMENT_ID, xeroObjectType: "CREDIT_NOTE", xeroObjectId: RACE_NOTE, role: "REFUND_REQUEST_CREDIT_NOTE",
          active: true, metadata: { amountCents: 5_000, refundRequestId: REQUEST_ID },
        },
      });
      const { upsertXeroObjectLink } = await import("@/lib/xero-sync");
      const base = { localModel: "Payment", localId: PAYMENT_ID, xeroObjectType: "CREDIT_NOTE", xeroObjectId: RACE_NOTE, role: "REFUND_REQUEST_CREDIT_NOTE" };

      // The inbound void, held open after its link write.
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let voidWritten!: (pid: number) => void;
      const holderPid = new Promise<number>((resolve) => (voidWritten = resolve));
      const inboundVoid = prisma.$transaction(
        async (tx) => {
          await upsertXeroObjectLink({ ...base, metadata: { status: "VOIDED", total: 50 }, mergeMetadata: true }, { store: tx });
          const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS "pid"`;
          voidWritten(pid);
          await released;
        },
        { timeout: 15_000 },
      );
      const pid = await holderPid;

      // A retry that read the note as live writes it as its cover, naming no status.
      const retryWrite = upsertXeroObjectLink({ ...base, xeroObjectNumber: "CN-4195-R", metadata: { amountCents: 5_000, refundRequestId: REQUEST_ID } });
      await waitForBlockedBy(pid);
      release();
      await inboundVoid;
      await retryWrite;

      const link = await prisma.xeroObjectLink.findFirstOrThrow({ where: { ...base }, select: { active: true, metadata: true } });
      expect(link.active).toBe(false);
      expect(link.metadata).toEqual({ amountCents: 5_000, refundRequestId: REQUEST_ID, status: "VOIDED", total: 50 });
    });
  },
);
