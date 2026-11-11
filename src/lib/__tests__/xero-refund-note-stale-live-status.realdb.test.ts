/**
 * Real-PostgreSQL proof of #4288 (`INV-ADDPAY-041`, owner decision 24 Oct
 * 2026): an older explicit LIVE reading of a refund credit note never revives
 * a mirror a later write recorded VOIDED.
 *
 * The writers that name a live status read Xero outside any transaction: the
 * inbound reconcile, the Stripe status recorder, and the hand-made note answer.
 * A reading taken before the void and written after it used to write the
 * mirror back active, erase the VOIDED status, retire siblings on the
 * bank-transfer canonical path and let the inbound gate re-set the pointer.
 * Every refund-note link write now re-reads its row under its own row lock and
 * keeps a stored void (`judgeRefundNoteWrite`); between two live readings the
 * one with the older Xero `UpdatedDateUTC` keeps the stored snapshot.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions, which
 * imports this file so CI reaches it, and the schedule shapes of
 * `xero-canonical-refund-note-void-race.realdb.test.ts`; it owns and cleans its
 * own `race-4288-` fixtures.
 */
import type { Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { realElapsedMs } from "@/lib/__tests__/helpers/clock";
import { assertSafeRaceDbUrl } from "./support/race-db-url";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const P = "race-4288";
const MEMBER_ID = `${P}-member`;
const LODGE_ID = `${P}-lodge`;
const BT_BOOKING = `${P}-bt-booking`;
const CARD_BOOKING = `${P}-card-booking`;
/** A bank-transfer payment and a card payment, each with two refund notes. */
const BT = `${P}-bt`;
const CARD = `${P}-card`;
const NOTE = `cn-${P}-stale`;
const REPLACEMENT = `cn-${P}-replacement`;
const REQUEST_ID = `${P}-request`;
const EARLY = "2026-06-30T11:00:00.000Z";
const LATE = "2026-06-30T12:00:00.000Z";

type Case = "bank-transfer canonical" | "Stripe per-delta" | "bank-transfer per-refund" | "refund request";
const ROLE: Record<Case, string> = {
  "bank-transfer canonical": "REFUND_CREDIT_NOTE",
  "Stripe per-delta": "REFUND_CREDIT_NOTE",
  "bank-transfer per-refund": "REFUND_CREDIT_NOTE",
  "refund request": "REFUND_REQUEST_CREDIT_NOTE",
};
const PAYMENT: Record<Case, string> = {
  "bank-transfer canonical": BT,
  "Stripe per-delta": CARD,
  "bank-transfer per-refund": BT,
  "refund request": BT,
};

let prisma: (typeof import("@/lib/prisma"))["prisma"];

/** A Xero reading of `NOTE`, as the SDK returns it. */
function reading(status: string, updatedAt: string, payments: Array<Record<string, unknown>> = [], allocations: Array<Record<string, unknown>> = []) {
  return {
    creditNoteID: NOTE, creditNoteNumber: "CN-4288", status, total: 100, appliedAmount: 0,
    remainingCredit: status === "VOIDED" ? 0 : 100, updatedDateUTC: new Date(updatedAt), allocations, payments,
  };
}

(RUN ? describe : describe.skip)(
  "an older live Xero reading never revives a voided refund-note mirror - real PostgreSQL (#4288)",
  { timeout: 60_000 },
  () => {
    async function deleteLinksAndPayments() {
      await prisma.xeroSyncOperation.deleteMany({ where: { localModel: "Payment", localId: { in: [BT, CARD] } } });
      await prisma.xeroObjectLink.deleteMany({ where: { localId: { in: [BT, CARD] } } });
      await prisma.payment.deleteMany({ where: { id: { in: [BT, CARD] } } });
    }
    async function deleteFixtures() {
      await deleteLinksAndPayments();
      await prisma.booking.deleteMany({ where: { id: { in: [BT_BOOKING, CARD_BOOKING] } } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "Stale live refund-note status");
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      await deleteFixtures();
      await prisma.member.create({
        data: { id: MEMBER_ID, email: `${MEMBER_ID}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Stale", lastName: "Proof", role: "ADMIN", ageTier: "ADULT" },
      });
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4288 Lodge", slug: "race-4288" } });
      for (const id of [BT_BOOKING, CARD_BOOKING]) {
        await prisma.booking.create({
          data: {
            id, memberId: MEMBER_ID, lodgeId: LODGE_ID, status: "CANCELLED", totalPriceCents: 20_000, finalPriceCents: 20_000,
            checkIn: new Date("2026-08-01T00:00:00.000Z"), checkOut: new Date("2026-08-03T00:00:00.000Z"),
          },
        });
      }
    }, 60_000);

    afterAll(async () => {
      if (!prisma) return;
      await deleteFixtures();
    }, 60_000);

    /**
     * Both payments, refunded in part. The stale note was read live; a
     * replacement live sibling of the same role stands beside it. On the
     * bank-transfer canonical case the stale note is the payment's one note,
     * named by the pointer, and the replacement a per-refund note.
     */
    async function seed(kase: Case, options: { storedStatus?: string; storedAt?: string } = {}) {
      await deleteLinksAndPayments();
      await prisma.payment.create({
        data: {
          id: BT, bookingId: BT_BOOKING, amountCents: 20_000, source: "INTERNET_BANKING", status: "PARTIALLY_REFUNDED", refundedAmountCents: 15_000,
          xeroInvoiceId: `inv-${P}-bt`, xeroRefundCreditNoteId: kase === "bank-transfer canonical" ? NOTE : null,
        },
      });
      await prisma.payment.create({
        data: { id: CARD, bookingId: CARD_BOOKING, amountCents: 20_000, source: "STRIPE", status: "PARTIALLY_REFUNDED", refundedAmountCents: 15_000, xeroInvoiceId: `inv-${P}-card` },
      });
      const own = {
        ...(kase === "refund request" ? { refundRequestId: REQUEST_ID } : {}),
        ...(kase === "bank-transfer per-refund" ? { perDelta: true } : {}),
      };
      await prisma.xeroObjectLink.create({
        data: {
          localModel: "Payment", localId: PAYMENT[kase], xeroObjectType: "CREDIT_NOTE", xeroObjectId: NOTE, xeroObjectNumber: "CN-4288",
          role: ROLE[kase], active: true,
          metadata: { amountCents: 10_000, watermarkCents: 10_000, ...own, status: options.storedStatus ?? "AUTHORISED", total: 100, providerUpdatedAt: options.storedAt ?? "2026-06-30T10:00:00.000Z" },
        },
      });
      await prisma.xeroObjectLink.create({
        data: {
          localModel: "Payment", localId: PAYMENT[kase], xeroObjectType: "CREDIT_NOTE", xeroObjectId: REPLACEMENT, xeroObjectNumber: "CN-4288-2",
          role: ROLE[kase], active: true,
          metadata: {
            amountCents: 5_000, watermarkCents: 15_000, status: "AUTHORISED", total: 50, providerUpdatedAt: LATE,
            ...(kase === "refund request" ? { refundRequestId: REQUEST_ID } : { perDelta: true }),
          },
        },
      });
    }

    /** The link write the inbound reconcile sends for a reading, on the caller's transaction or its own. */
    async function writeReading(kase: Case, status: string, updatedAt: string, store?: Prisma.TransactionClient) {
      const { upsertXeroObjectLink } = await import("@/lib/xero-sync");
      const { xeroCreditNoteSnapshotMetadata } = await import("@/lib/xero-refund-note-status");
      return upsertXeroObjectLink(
        {
          localModel: "Payment", localId: PAYMENT[kase], xeroObjectType: "CREDIT_NOTE", xeroObjectId: NOTE, xeroObjectNumber: "CN-4288",
          role: ROLE[kase], metadata: xeroCreditNoteSnapshotMetadata(reading(status, updatedAt)), mergeMetadata: true,
        },
        store ? { store } : undefined,
      );
    }

    /** A fake Xero (no provider call), and no alert, for the length of `run`. */
    async function withFakeXero<T>(getCreditNote: (tenant: string, id: string) => Promise<unknown>, run: () => Promise<T>): Promise<T> {
      const apiClient = await import("@/lib/xero-api-client");
      const alerts = await import("@/lib/xero-error-alert");
      const spies = [
        vi.spyOn(apiClient, "getAuthenticatedXeroClient").mockResolvedValue({ xero: { accountingApi: { getCreditNote } }, tenantId: "tenant-4288" } as never),
        vi.spyOn(apiClient, "callXeroApi").mockImplementation(((call: () => unknown) => call()) as never),
        vi.spyOn(alerts, "notifyXeroSyncError").mockResolvedValue(undefined as never),
      ];
      try {
        return await run();
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
    }

    /**
     * The stale writer for each case, paused at `gate` after it read the note
     * as live and before its link write: the real inbound reconcile (after its
     * link reads), the real Stripe status recorder (in its Xero fetch, after
     * its link reads), or the link write a reconcile sends for a per-refund or
     * request note.
     */
    /** The real inbound reconcile of `live`, paused at `gate` after its link reads and before its writes. */
    async function staleReconcile(live: ReturnType<typeof reading>, gate: Promise<void>, reached: () => void) {
      const objectLinks = await import("@/lib/xero-inbound/object-links");
      const original = objectLinks.findActiveXeroObjectLinks;
      const spy = vi.spyOn(objectLinks, "findActiveXeroObjectLinks").mockImplementationOnce(async (...args: Parameters<typeof original>) => {
        const rows = await original(...args);
        reached();
        await gate;
        return rows;
      });
      const { reconcileXeroCreditNote } = await import("@/lib/xero-inbound/credit-note");
      try {
        return await withFakeXero(async () => ({ body: { creditNotes: [live] } }), () => reconcileXeroCreditNote(NOTE));
      } finally {
        spy.mockRestore();
      }
    }

    /** Schedule A: `stale` reads the note as live and pauses; the void commits; then `stale` writes. */
    async function voidWhileStale(kase: Case, stale: (gate: Promise<void>, reached: () => void) => Promise<unknown>) {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let reached!: () => void;
      const atGate = new Promise<void>((resolve) => (reached = resolve));
      const running = stale(gate, reached);
      void running.catch(() => undefined);
      try {
        await Promise.race([atGate, running.then(() => { throw new Error("The stale writer finished before its gate"); })]);
        // B: the void's own write commits while A holds its live reading.
        await writeReading(kase, "VOIDED", LATE);
      } finally {
        release();
      }
      await running;
    }

    async function staleLiveWriter(kase: Case, gate: Promise<void>, reached: () => void): Promise<unknown> {
      const authorised = reading("AUTHORISED", EARLY);
      if (kase === "bank-transfer canonical") return staleReconcile(authorised, gate, reached);
      if (kase === "Stripe per-delta") {
        const { recordStripeRefundNoteLinkStatuses } = await import("@/lib/xero-refund-note-status-recorder");
        return withFakeXero(
          async (_tenant, id) => {
            if (id !== NOTE) return { body: { creditNotes: [{ ...reading("AUTHORISED", LATE), creditNoteID: REPLACEMENT, creditNoteNumber: "CN-4288-2", total: 50 }] } };
            reached();
            await gate;
            return { body: { creditNotes: [authorised] } };
          },
          () => recordStripeRefundNoteLinkStatuses({ paymentIds: [CARD] }),
        );
      }
      reached();
      await gate;
      return writeReading(kase, "AUTHORISED", EARLY);
    }

    async function state(kase: Case) {
      const { sumCoveredRefundCreditNoteCents } = await import("@/lib/xero-sync");
      const { refundRequestOwnNotes } = await import("@/lib/xero-refund-note-status");
      const links = await prisma.xeroObjectLink.findMany({
        where: { localId: PAYMENT[kase], role: ROLE[kase] },
        select: { xeroObjectId: true, active: true, metadata: true },
      });
      const note = links.find((link) => link.xeroObjectId === NOTE)!;
      const replacement = links.find((link) => link.xeroObjectId === REPLACEMENT)!;
      const payment = await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT[kase] }, select: { xeroRefundCreditNoteId: true } });
      const metadata = note.metadata as Record<string, unknown>;
      return {
        active: note.active,
        status: metadata.status,
        providerUpdatedAt: metadata.providerUpdatedAt,
        pointer: payment.xeroRefundCreditNoteId,
        replacementActive: replacement.active,
        coverage: kase === "refund request"
          ? (await refundRequestOwnNotes(BT, REQUEST_ID, prisma)).live?.xeroObjectId ?? null
          : await sumCoveredRefundCreditNoteCents(PAYMENT[kase]),
      };
    }
    /** What every case must end with: the void kept, the replacement alone covering. */
    const kept = (kase: Case) => ({
      active: false, status: "VOIDED", providerUpdatedAt: LATE, pointer: null, replacementActive: true,
      coverage: kase === "refund request" ? REPLACEMENT : 5_000,
    });

    /**
     * Poll until a backend waits on a lock `blockerPid` holds - that backend
     * (`waiterPid`), or one running the statement `waiterQuery` (a LIKE
     * pattern), so a schedule never accepts the wrong waiter.
     */
    async function waitForBlockedBy(blockerPid: number, waiterPid?: number, waiterQuery?: string) {
      const startedAt = process.hrtime.bigint();
      while (realElapsedMs(startedAt) < 10_000) {
        const rows = await prisma.$queryRaw<Array<{ count: number }>>`
          SELECT COUNT(*)::int AS "count" FROM pg_stat_activity
          WHERE datname = current_database() AND ${blockerPid}::int = ANY(pg_blocking_pids(pid))
            AND (${waiterPid ?? null}::int IS NULL OR pid = ${waiterPid ?? null}::int)
            AND (${waiterQuery ?? null}::text IS NULL OR query LIKE ${waiterQuery ?? null}::text)
        `;
        if ((rows[0]?.count ?? 0) >= 1) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const waiting = await prisma.$queryRaw<Array<{ pid: number; query: string }>>`
        SELECT pid, query FROM pg_stat_activity
        WHERE datname = current_database() AND ${blockerPid}::int = ANY(pg_blocking_pids(pid))`;
      throw new Error(`Timed out waiting for ${waiterQuery ?? "a write"} to queue behind pid ${blockerPid}; waiting: ${JSON.stringify(waiting)}`);
    }

    /** A reading's link write held open on its own connection until `release()`. */
    async function holdReading(kase: Case, status: string, updatedAt: string) {
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let written!: (pid: number) => void;
      const holderPid = new Promise<number>((resolve) => (written = resolve));
      const committed = prisma.$transaction(
        async (tx) => {
          await writeReading(kase, status, updatedAt, tx);
          const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS "pid"`;
          written(pid);
          await released;
        },
        { timeout: 30_000 },
      );
      const pid = await Promise.race([holderPid, committed.then(() => { throw new Error("Held write ended before reporting its lock"); })]);
      return { pid, release, committed };
    }

    const CASES: Case[] = ["bank-transfer canonical", "Stripe per-delta", "bank-transfer per-refund", "refund request"];

    it.each(CASES)("%s: a live reading taken before the void and written after it keeps the void (schedule A)", async (kase) => {
      await seed(kase);
      await voidWhileStale(kase, (gate, reached) => staleLiveWriter(kase, gate, reached));

      // Before #4288: active, AUTHORISED, and on the canonical path the pointer back on the note.
      expect(await state(kase)).toEqual(kept(kase));
    });

    async function refunded(paymentId: string) {
      return prisma.payment.findUniqueOrThrow({ where: { id: paymentId }, select: { refundedAmountCents: true, status: true } });
    }

    it("MUTATION (recount): a bank transfer's stale reconcile recounts the kept void, so the void's lowered total is not raised back", async () => {
      const kase: Case = "bank-transfer canonical";
      await seed(kase);
      // The void's own recount already took the note out: only the $50 replacement counts.
      await prisma.payment.update({ where: { id: BT }, data: { refundedAmountCents: 5_000 } });
      await voidWhileStale(kase, (gate, reached) => staleReconcile(reading("AUTHORISED", EARLY), gate, reached));
      expect(await state(kase)).toEqual(kept(kase));
      // Before the recount read the judged snapshot, the stale reading's $100
      // was counted again and the total went back to $150: money moved.
      expect(await refunded(BT)).toEqual({ refundedAmountCents: 5_000, status: "PARTIALLY_REFUNDED" });
    });

    it("MUTATION (recount, card): a card payment's stale reconcile never raises its total from the voided note", async () => {
      const kase: Case = "Stripe per-delta";
      await seed(kase);
      // `INV-ADDPAY-021` lets an inbound recount RAISE a card ledger (never lower
      // it), so the stale reading's $100 counted again would raise $50 to $150.
      await prisma.payment.update({ where: { id: CARD }, data: { refundedAmountCents: 5_000 } });
      await voidWhileStale(kase, (gate, reached) => staleReconcile(reading("AUTHORISED", EARLY), gate, reached));
      expect(await state(kase)).toEqual(kept(kase));
      expect(await refunded(CARD)).toEqual({ refundedAmountCents: 5_000, status: "PARTIALLY_REFUNDED" });
    });

    it("MUTATION (review 1): A's live link write, then B's void and B's recount, then A's recount - A counts the void it reads now", async () => {
      const kase: Case = "bank-transfer canonical";
      await seed(kase);
      let current = reading("AUTHORISED", EARLY);
      const repairs = await import("@/lib/xero-inbound/credit-note-repairs");
      const original = repairs.repairRefundedPaymentBusinessState;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let reached!: () => void;
      const atRecount = new Promise<void>((resolve) => (reached = resolve));
      // A pauses after its link writes, before its recount.
      const spy = vi.spyOn(repairs, "repairRefundedPaymentBusinessState").mockImplementationOnce(async (...args: Parameters<typeof original>) => {
        reached();
        await gate;
        return original(...args);
      });
      const { reconcileXeroCreditNote } = await import("@/lib/xero-inbound/credit-note");
      try {
        await withFakeXero(async () => ({ body: { creditNotes: [current] } }), async () => {
          const a = reconcileXeroCreditNote(NOTE);
          void a.catch(() => undefined);
          try {
            await Promise.race([atRecount, a.then(() => { throw new Error("A finished before its recount"); })]);
            // A's live reading was applied: nothing newer was stored when it wrote.
            expect((await state(kase)).status).toBe("AUTHORISED");
            // B: the void's whole reconcile - its link write and its recount, $150 to $50.
            current = reading("VOIDED", LATE);
            await reconcileXeroCreditNote(NOTE);
            expect(await refunded(BT)).toEqual({ refundedAmountCents: 5_000, status: "PARTIALLY_REFUNDED" });
          } finally {
            release();
          }
          await a;
        });
      } finally {
        spy.mockRestore();
      }
      // A's recount reads the note's row as it is now: VOIDED, so it counts nothing.
      // Acting on its own write's verdict, it wrote $150 back.
      expect(await state(kase)).toEqual(kept(kase));
      expect(await refunded(BT)).toEqual({ refundedAmountCents: 5_000, status: "PARTIALLY_REFUNDED" });
    });

    it("MUTATION (refund payments): a stale reconcile writes no refund-payment link from its older reading's payments", async () => {
      const kase: Case = "bank-transfer canonical";
      await seed(kase);
      const payments = [{ paymentID: `xero-pay-${P}-stale`, amount: 100, date: "2026-06-30", paymentType: "ARCREDITPAYMENT", status: "AUTHORISED" }];
      await voidWhileStale(kase, (gate, reached) => staleReconcile(reading("AUTHORISED", EARLY, payments), gate, reached));
      expect(await state(kase)).toEqual(kept(kase));
      expect(await prisma.xeroObjectLink.count({ where: { localId: BT, role: "REFUND_PAYMENT" } })).toBe(0);
    });

    /** The note allocated in full to the bank transfer's invoice, as Xero reports it. */
    const ALLOCATED = [{ invoice: { invoiceID: `inv-${P}-bt` }, amount: 100 }];
    const allocationLinks = () =>
      prisma.xeroObjectLink.findMany({ where: { localId: BT, xeroObjectType: "ALLOCATION" }, select: { role: true, active: true, metadata: true } });

    it("MUTATION (allocations): a stale reconcile writes no allocation link from its older reading's allocations", async () => {
      const kase: Case = "bank-transfer canonical";
      await seed(kase);
      await voidWhileStale(kase, (gate, reached) => staleReconcile(reading("AUTHORISED", EARLY, [], ALLOCATED), gate, reached));
      expect(await state(kase)).toEqual(kept(kase));
      expect(await allocationLinks()).toEqual([]);
    });

    /**
     * A's reconcile paused inside its recount - after its row read, before its
     * claim - while the void and B's whole reconcile run, then released. The
     * payment starts at $50 with a live $100 note beside the $50 one, so A's
     * recount reads the note as live and owes $150; B's finds $50 right and
     * writes nothing.
     */
    async function voidBetweenReadAndClaim(kase: Case, paymentId: string, inWindow?: () => Promise<void>) {
      await seed(kase);
      await prisma.payment.update({ where: { id: paymentId }, data: { refundedAmountCents: 5_000 } });
      let current = reading("AUTHORISED", EARLY);
      const floor = await import("@/lib/xero-inbound/credit-note-bank-transfer-floor");
      const original = floor.floorBankTransferRefundedTotal;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let reached!: () => void;
      const atClaim = new Promise<void>((resolve) => (reached = resolve));
      // Every recount floors a bank transfer just before its claim (a no-op for a card).
      const spy = vi.spyOn(floor, "floorBankTransferRefundedTotal").mockImplementationOnce(async (...args: Parameters<typeof original>) => {
        reached();
        await gate;
        return original(...args);
      });
      const { reconcileXeroCreditNote } = await import("@/lib/xero-inbound/credit-note");
      try {
        return await withFakeXero(async () => ({ body: { creditNotes: [current] } }), async () => {
          const a = reconcileXeroCreditNote(NOTE);
          void a.catch(() => undefined);
          try {
            await Promise.race([atClaim, a.then(() => { throw new Error("A finished before its claim"); })]);
            if (inWindow) {
              await inWindow();
            } else {
              current = reading("VOIDED", LATE);
              await reconcileXeroCreditNote(NOTE);
            }
            expect(await refunded(paymentId)).toEqual({ refundedAmountCents: 5_000, status: "PARTIALLY_REFUNDED" });
          } finally {
            release();
          }
          const result = await a;
          expect(await state(kase)).toMatchObject(inWindow ? { active: false } : { active: false, status: "VOIDED" });
          // Round 6: A's locked re-read found the note no longer counting, so A wrote nothing.
          expect(result.updatedRefundedPayments).toBe(0);
          return result;
        });
      } finally {
        spy.mockRestore();
      }
    }

    it("MUTATION (round 4, review 1): A reads the live note's row, then the void and B's recount, then A claims - A recounts the void", async () => {
      await voidBetweenReadAndClaim("bank-transfer per-refund", BT);
      // A's claim saw no Payment change (the void moves none). Before the
      // re-read after its claim, it left $150 against a VOIDED note.
      expect(await refunded(BT)).toEqual({ refundedAmountCents: 5_000, status: "PARTIALLY_REFUNDED" });
    });

    it("MUTATION (round 5, F4): a live row deactivated between A's read and its claim recounts too - judged by the rule that counted it", async () => {
      await voidBetweenReadAndClaim("bank-transfer per-refund", BT, async () => {
        // Retired, still AUTHORISED: no longer counted, though not voided.
        await prisma.xeroObjectLink.updateMany({ where: { localId: BT, xeroObjectId: NOTE }, data: { active: false } });
      });
      expect(await refunded(BT)).toEqual({ refundedAmountCents: 5_000, status: "PARTIALLY_REFUNDED" });
    });

    it("MUTATION (round 6): on a card payment A writes nothing when the void commits before its locked re-read", async () => {
      await voidBetweenReadAndClaim("Stripe per-delta", CARD);
      // `INV-ADDPAY-021`: a card recount never lowers the ledger, so a $150
      // written here would stand. A re-reads the note under the Payment lock
      // and writes nothing.
      expect(await refunded(CARD)).toEqual({ refundedAmountCents: 5_000, status: "PARTIALLY_REFUNDED" });
    });

    /**
     * Round 6: A's recount paused INSIDE its locked transaction - after it
     * re-read the note as live, before it commits its claim - while the void
     * runs. An explicit void of the payment's own note waits on A's Payment
     * row before it takes the link (#4200), so it does not hold the link A
     * only reads. The serial order is "A, then the void, then B".
     * `waiterQuery` is the statement that must be the one waiting.
     */
    async function voidAfterLockedReRead(kase: Case, paymentId: string, waiterQuery = "%FOR NO KEY UPDATE%") {
      await seed(kase);
      await prisma.payment.update({ where: { id: paymentId }, data: { refundedAmountCents: 5_000 } });
      let current = reading("AUTHORISED", EARLY);
      const status = await import("@/lib/xero-refund-note-status");
      const original = status.readRefundNoteRowsByPayment;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let reached!: (pid: number) => void;
      const atReRead = new Promise<number>((resolve) => (reached = resolve));
      let gated = false;
      const spy = vi.spyOn(status, "readRefundNoteRowsByPayment").mockImplementation(async (...args: Parameters<typeof original>) => {
        const rows = await original(...args);
        // The re-read on a transaction client (not the module client): A's, once.
        if (!gated && args[2] !== prisma) {
          gated = true;
          const [{ pid }] = await (args[2] as unknown as typeof prisma).$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS "pid"`;
          reached(pid);
          await gate;
        }
        return rows;
      });
      const alerts = await import("@/lib/xero-error-alert");
      const { reconcileXeroCreditNote } = await import("@/lib/xero-inbound/credit-note");
      try {
        return await withFakeXero(async () => ({ body: { creditNotes: [current] } }), async () => {
          const a = reconcileXeroCreditNote(NOTE);
          void a.catch(() => undefined);
          let b: Promise<Awaited<ReturnType<typeof reconcileXeroCreditNote>>> | null = null;
          try {
            const pid = await Promise.race([atReRead, a.then(() => { throw new Error("A finished before its locked re-read"); })]);
            current = reading("VOIDED", LATE);
            b = reconcileXeroCreditNote(NOTE);
            void b.catch(() => undefined);
            await waitForBlockedBy(pid, undefined, waiterQuery);
          } finally {
            release();
          }
          const results = { a: await a, b: await b! };
          expect(await state(kase)).toMatchObject({ active: false, status: "VOIDED" });
          return { ...results, alerted: vi.mocked(alerts.notifyXeroSyncError).mock.calls.map(([call]) => call.errorType) };
        });
      } finally {
        spy.mockRestore();
      }
    }

    it("MUTATION (round 6): a void committing after A's locked re-read is A, then the void, then B - on a bank transfer B lowers it back", async () => {
      const { a, b } = await voidAfterLockedReRead("bank-transfer per-refund", BT);
      expect(a.updatedRefundedPayments).toBe(1);
      expect(b.updatedRefundedPayments).toBe(1);
      expect(await refunded(BT)).toEqual({ refundedAmountCents: 5_000, status: "PARTIALLY_REFUNDED" });
    });

    it("MUTATION (round 7, F4): the pointer-named canonical note - the void waits on A's Payment lock before it takes the link", async () => {
      const { a, b } = await voidAfterLockedReRead("bank-transfer canonical", BT, '%SELECT 1 FROM "Payment"%FOR NO KEY UPDATE%');
      expect(a.updatedRefundedPayments).toBe(1);
      expect(b.updatedRefundedPayments).toBe(1);
      expect(await refunded(BT)).toEqual({ refundedAmountCents: 5_000, status: "PARTIALLY_REFUNDED" });
      expect(await state("bank-transfer canonical")).toMatchObject({ pointer: null });
    });

    it("round 6 stated limit: on a card the same order leaves A's raise standing, raise-only, and alerts", async () => {
      // A's own reconcile pointed the card payment at the note (the inbound
      // gate). The void waits on A's Payment row before it takes the link.
      const { a, alerted } = await voidAfterLockedReRead("Stripe per-delta", CARD, '%SELECT 1 FROM "Payment"%FOR NO KEY UPDATE%');
      expect(a.updatedRefundedPayments).toBe(1);
      // `INV-ADDPAY-021`, F5 #1353: B never lowers a card ledger; it raises the divergence alert.
      expect(await refunded(CARD)).toEqual({ refundedAmountCents: 15_000, status: "PARTIALLY_REFUNDED" });
      expect(alerted).toContain("refund-ledger-divergence");
    });

    it("MUTATION (review 2): a stale reading kept under a newer LIVE snapshot still records its allocations and refund payments", async () => {
      // The newer snapshot came from a writer that records neither (the Stripe
      // status recorder): the note is still allocated and paid, so they stay true.
      const kase: Case = "bank-transfer canonical";
      await seed(kase, { storedStatus: "PAID", storedAt: LATE });
      const payments = [{ paymentID: `xero-pay-${P}-kept`, amount: 100, date: "2026-06-30", paymentType: "ARCREDITPAYMENT", status: "AUTHORISED" }];
      const { reconcileXeroCreditNote } = await import("@/lib/xero-inbound/credit-note");
      await withFakeXero(async () => ({ body: { creditNotes: [reading("AUTHORISED", EARLY, payments, ALLOCATED)] } }), () => reconcileXeroCreditNote(NOTE));
      expect(await state(kase)).toMatchObject({ active: true, status: "PAID", providerUpdatedAt: LATE });
      expect(await allocationLinks()).toEqual([
        {
          role: "CREDIT_NOTE_ALLOCATION",
          active: true,
          metadata: expect.objectContaining({
            creditNoteId: NOTE,
            invoiceId: `inv-${P}-bt`,
            amountCents: 10_000,
            providerUpdatedAt: EARLY,
          }),
        },
      ]);
      expect(await prisma.xeroObjectLink.count({ where: { localId: BT, role: "REFUND_PAYMENT", xeroObjectId: `xero-pay-${P}-kept` } })).toBe(1);
    });

    it("an applied reading still records its allocations", async () => {
      const kase: Case = "bank-transfer canonical";
      await seed(kase, { storedAt: EARLY });
      const { reconcileXeroCreditNote } = await import("@/lib/xero-inbound/credit-note");
      await withFakeXero(async () => ({ body: { creditNotes: [reading("PAID", LATE, [], ALLOCATED)] } }), () => reconcileXeroCreditNote(NOTE));
      expect(await allocationLinks()).toEqual([
        {
          role: "CREDIT_NOTE_ALLOCATION",
          active: true,
          metadata: expect.objectContaining({
            creditNoteId: NOTE,
            invoiceId: `inv-${P}-bt`,
            amountCents: 10_000,
            providerUpdatedAt: LATE,
          }),
        },
      ]);
    });

    it("an applied reading still records its refund payments", async () => {
      const kase: Case = "bank-transfer canonical";
      await seed(kase, { storedAt: EARLY });
      const payments = [{ paymentID: `xero-pay-${P}-live`, amount: 100, date: "2026-06-30", paymentType: "ARCREDITPAYMENT", status: "AUTHORISED" }];
      const { reconcileXeroCreditNote } = await import("@/lib/xero-inbound/credit-note");
      await withFakeXero(async () => ({ body: { creditNotes: [reading("PAID", LATE, payments)] } }), () => reconcileXeroCreditNote(NOTE));
      expect(await prisma.xeroObjectLink.findMany({ where: { localId: BT, role: "REFUND_PAYMENT" }, select: { xeroObjectId: true, active: true } }))
        .toEqual([{ xeroObjectId: `xero-pay-${P}-live`, active: true }]);
    });

    it("bank-transfer canonical: a live reconcile queued on the void's row lock keeps the void (lock-queued)", async () => {
      const kase: Case = "bank-transfer canonical";
      await seed(kase);
      const held = await holdReading(kase, "VOIDED", LATE);
      const { reconcileXeroCreditNote } = await import("@/lib/xero-inbound/credit-note");
      // It reads the note as live and active: the void has not committed.
      const stale = withFakeXero(async () => ({ body: { creditNotes: [reading("AUTHORISED", EARLY)] } }), () => reconcileXeroCreditNote(NOTE));
      void stale.catch(() => undefined);
      try {
        await waitForBlockedBy(held.pid);
      } finally {
        held.release();
      }
      await held.committed;
      await stale;
      expect(await state(kase)).toEqual(kept(kase));
    });

    it("MUTATION (order): an older live reading queued behind a newer live one keeps the newer snapshot (lock-queued)", async () => {
      const kase: Case = "Stripe per-delta";
      await seed(kase, { storedAt: "2026-06-30T09:00:00.000Z" });
      const held = await holdReading(kase, "PAID", LATE);
      const stale = writeReading(kase, "AUTHORISED", EARLY);
      void stale.catch(() => undefined);
      try {
        await waitForBlockedBy(held.pid);
      } finally {
        held.release();
      }
      await held.committed;
      await stale;
      expect(await state(kase)).toMatchObject({ active: true, status: "PAID", providerUpdatedAt: LATE, coverage: 15_000 });
    });

    it("a newer live reading is applied through the real reconcile: AUTHORISED to PAID is ordinary", async () => {
      const kase: Case = "bank-transfer canonical";
      await seed(kase, { storedAt: EARLY });
      const { reconcileXeroCreditNote } = await import("@/lib/xero-inbound/credit-note");
      await withFakeXero(async () => ({ body: { creditNotes: [reading("PAID", LATE)] } }), () => reconcileXeroCreditNote(NOTE));
      expect(await state(kase)).toEqual({ active: true, status: "PAID", providerUpdatedAt: LATE, pointer: NOTE, replacementActive: true, coverage: 15_000 });
    });

    it("MUTATION (pointer): a stale live write keeps the void without waiting on the Payment a Payment-first enqueue holds (race)", async () => {
      const { enqueueXeroRefundCreditNoteOperation } = await import("@/lib/xero-operation-outbox");
      const { lockPaymentForRefundedTotal } = await import("@/lib/payment-transactions");
      const kase: Case = "bank-transfer canonical";
      // The void committed, but its pointer still names the note (a reconcile's
      // gate wrote it back before the void, or the void found Payment busy).
      await deleteLinksAndPayments();
      await prisma.payment.create({
        data: {
          id: BT, bookingId: BT_BOOKING, amountCents: 20_000, source: "INTERNET_BANKING", status: "REFUNDED", refundedAmountCents: 20_000,
          xeroInvoiceId: `inv-${P}-bt`, xeroRefundCreditNoteId: NOTE,
        },
      });
      await prisma.xeroObjectLink.create({
        data: {
          localModel: "Payment", localId: BT, xeroObjectType: "CREDIT_NOTE", xeroObjectId: NOTE, xeroObjectNumber: "CN-4288", role: "REFUND_CREDIT_NOTE", active: false,
          metadata: { amountCents: 20_000, watermarkCents: 20_000, status: "VOIDED", total: 200, providerUpdatedAt: LATE },
        },
      });
      // F takes the Payment lock a group cancel's refund writer takes, and
      // holds it until K has finished; then it runs the real enqueue.
      let mayEnqueue!: () => void;
      const gate = new Promise<void>((resolve) => (mayEnqueue = resolve));
      let locked!: () => void;
      const paymentLocked = new Promise<void>((resolve) => (locked = resolve));
      const enqueue = prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
        await lockPaymentForRefundedTotal(tx, BT);
        locked();
        await gate;
        return enqueueXeroRefundCreditNoteOperation(BT, 20_000, { refundMethod: "internet-banking", store: tx });
      }, { timeout: 30_000 });
      void enqueue.catch(() => undefined);
      // A blocking-lock mutation makes K wait for F; the backstop lets F run
      // so the cycle (or the elapsed-time check) fails rather than hangs.
      const backstop = setTimeout(mayEnqueue, 10_000);
      try {
        await Promise.race([paymentLocked, enqueue.then(() => { throw new Error("Enqueue ended before reporting its Payment lock"); })]);
        // K: the stale live reading's write, with F holding the Payment.
        const startedAt = process.hrtime.bigint();
        await writeReading(kase, "AUTHORISED", EARLY);
        expect(realElapsedMs(startedAt)).toBeLessThan(5_000);
        // The void is kept; the busy Payment leaves only the pointer to the heal.
        const link = await prisma.xeroObjectLink.findFirstOrThrow({ where: { localId: BT, xeroObjectId: NOTE }, select: { active: true, metadata: true } });
        expect(link.active).toBe(false);
        expect(link.metadata).toMatchObject({ status: "VOIDED", providerUpdatedAt: LATE });
      } finally {
        clearTimeout(backstop);
        mayEnqueue();
      }
      // F finishes too: no lock cycle between the link and the Payment.
      await expect(enqueue).resolves.toBeDefined();
      const link = await prisma.xeroObjectLink.findFirstOrThrow({ where: { localId: BT, xeroObjectId: NOTE }, select: { active: true, metadata: true } });
      expect(link).toMatchObject({ active: false, metadata: expect.objectContaining({ status: "VOIDED" }) });
    });
  },
);
