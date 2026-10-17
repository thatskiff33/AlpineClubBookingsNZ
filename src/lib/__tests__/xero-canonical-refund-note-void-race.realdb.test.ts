/**
 * Real-PostgreSQL proof of #4223 (`INV-ADDPAY-041`): a bank-transfer
 * payment's ONE canonical refund note (`REFUND_CREDIT_NOTE`, #4091), voided
 * in Xero while a retry is recording it as its cover.
 *
 * The retry (`createXeroCreditNote`, the "already covered" branch) reads the
 * note as live outside any transaction. The inbound void then commits the
 * mirror inactive and VOIDED and releases the payment's pointer. Before #4223
 * the retry's link write, which names no Xero status, wrote the mirror back
 * active. #4195 closed the same race for a refund request's own note; the one
 * helper (`keepStoredRefundNoteVoid`) now covers both roles.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions, which
 * imports this file so CI reaches it; it owns and cleans its own `race-4223-`
 * fixtures.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { realElapsedMs } from "@/lib/__tests__/helpers/clock";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const MEMBER_ID = "race-4223-member";
const LODGE_ID = "race-4223-lodge";
const BOOKING_ID = "race-4223-booking";
const PAYMENT_ID = "race-4223-payment";
const NOTE = "cn-race-4223-canonical";

/** Standalone fail-closed copy: importing this file must not register another suite. */
export function assertSafeCanonicalNoteVoidRaceDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Canonical refund-note void race proofs need a valid CONCURRENCY_RACE_DATABASE_URL.");
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(
      `Refusing to run canonical refund-note void race proofs against port ${parsed.port || "(none)"}: use a throwaway PostgreSQL on 55442+ (never 5432).`,
    );
  }
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname.toLowerCase())) {
    throw new Error("Canonical refund-note void race proof DB must be loopback-only.");
  }
  if (!decodeURIComponent(parsed.pathname.replace(/^\//, "")).includes("concurrency_race_1881")) {
    throw new Error("Canonical refund-note void race proof DB name must contain 'concurrency_race_1881'.");
  }
}

let prisma: (typeof import("@/lib/prisma"))["prisma"];

(RUN ? describe : describe.skip)(
  "a canonical refund note voided in Xero while a retry records it stays inactive - real PostgreSQL (#4223)",
  { timeout: 60_000 },
  () => {
    async function deleteFixtures() {
      await prisma.xeroSyncOperation.deleteMany({ where: { localModel: "Payment", localId: PAYMENT_ID } });
      await prisma.xeroObjectLink.deleteMany({ where: { localId: PAYMENT_ID } });
      await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
      await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
    }

    beforeAll(async () => {
      assertSafeCanonicalNoteVoidRaceDbUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      await deleteFixtures();
      await prisma.member.create({
        data: { id: MEMBER_ID, email: `${MEMBER_ID}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Canonical", lastName: "Proof", role: "ADMIN", ageTier: "ADULT" },
      });
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4223 Lodge", slug: "race-4223" } });
      await prisma.booking.create({
        data: {
          id: BOOKING_ID, memberId: MEMBER_ID, lodgeId: LODGE_ID, status: "CANCELLED", totalPriceCents: 20_000, finalPriceCents: 20_000,
          checkIn: new Date("2026-08-01T00:00:00.000Z"), checkOut: new Date("2026-08-03T00:00:00.000Z"),
        },
      });
    }, 60_000);

    afterAll(async () => {
      if (!prisma) return;
      await deleteFixtures();
    }, 60_000);

    /** The cancellation refunded the bank transfer in full; its one note is live and named by the pointer (or not). */
    async function seed(pointer: string | null) {
      await prisma.xeroSyncOperation.deleteMany({ where: { localModel: "Payment", localId: PAYMENT_ID } });
      await prisma.xeroObjectLink.deleteMany({ where: { localId: PAYMENT_ID } });
      await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
      await prisma.payment.create({
        data: {
          id: PAYMENT_ID, bookingId: BOOKING_ID, amountCents: 20_000, source: "INTERNET_BANKING", status: "REFUNDED",
          refundedAmountCents: 20_000, xeroInvoiceId: "inv-race-4223", xeroRefundCreditNoteId: pointer,
        },
      });
      await prisma.xeroObjectLink.create({
        data: {
          localModel: "Payment", localId: PAYMENT_ID, xeroObjectType: "CREDIT_NOTE", xeroObjectId: NOTE, xeroObjectNumber: "CN-4223",
          role: "REFUND_CREDIT_NOTE", active: true, metadata: { amountCents: 20_000, watermarkCents: 20_000 },
        },
      });
    }
    beforeEach(async () => {
      await seed(NOTE);
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

    /**
     * The inbound void's link write (what `reconcileXeroCreditNote` sends for a
     * VOIDED note), held open on its own connection until `release()`.
     */
    async function holdInboundVoid() {
      const { upsertXeroObjectLink } = await import("@/lib/xero-sync");
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let voidWritten!: (pid: number) => void;
      const holderPid = new Promise<number>((resolve) => (voidWritten = resolve));
      const committed = prisma.$transaction(
        async (tx) => {
          await upsertXeroObjectLink(
            {
              localModel: "Payment", localId: PAYMENT_ID, xeroObjectType: "CREDIT_NOTE", xeroObjectId: NOTE, xeroObjectNumber: "CN-4223",
              role: "REFUND_CREDIT_NOTE", metadata: { status: "VOIDED", total: 200 }, mergeMetadata: true,
            },
            { store: tx },
          );
          const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS "pid"`;
          voidWritten(pid);
          await released;
        },
        { timeout: 15_000 },
      );
      return { pid: await holderPid, release, committed };
    }

    /** The cancellation's refund-note retry: the note already covers it, so no Xero call is made. */
    async function retryRefundNote() {
      const apiClient = await import("@/lib/xero-api-client");
      const getClient = vi.spyOn(apiClient, "getAuthenticatedXeroClient").mockRejectedValue(new Error("no Xero call expected (#4223)"));
      try {
        const { createXeroCreditNote } = await import("@/lib/xero-credit-notes");
        return await createXeroCreditNote(PAYMENT_ID, 20_000, { refundMethod: "internet-banking" });
      } finally {
        getClient.mockRestore();
      }
    }

    async function state() {
      const link = await prisma.xeroObjectLink.findFirstOrThrow({
        where: { localId: PAYMENT_ID, xeroObjectId: NOTE, role: "REFUND_CREDIT_NOTE" },
        select: { active: true, metadata: true },
      });
      const payment = await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID }, select: { xeroRefundCreditNoteId: true } });
      return { active: link.active, metadata: link.metadata, pointer: payment.xeroRefundCreditNoteId };
    }

    it("a retry that read the canonical note as live, then waited on the inbound void, keeps the void: inactive, status kept, pointer released (race)", async () => {
      const inbound = await holdInboundVoid();
      // The retry reads the note as live (the void has not committed), finds it
      // covers the refund, and writes its link naming no status.
      const retry = retryRefundNote();
      await waitForBlockedBy(inbound.pid);
      inbound.release();
      await inbound.committed;
      expect(await retry).toBe(NOTE);

      // Before #4223 the retry wrote the voided mirror back `active: true`.
      expect(await state()).toEqual({
        active: false,
        metadata: { amountCents: 20_000, watermarkCents: 20_000, status: "VOIDED", total: 200 },
        pointer: null,
      });
    });

    it("a retry that wrote the pointer back before the void committed has it released by its own link write (race)", async () => {
      // The pointer is null: the note is the payment's one note by its link alone.
      await seed(null);
      const inbound = await holdInboundVoid();
      const retry = retryRefundNote();
      await waitForBlockedBy(inbound.pid);
      inbound.release();
      await inbound.committed;
      expect(await retry).toBe(NOTE);

      // The retry wrote the pointer at the note before its link write waited;
      // the link write that keeps the void releases it, as the inbound write does.
      expect(await state()).toEqual({
        active: false,
        metadata: { amountCents: 20_000, watermarkCents: 20_000, status: "VOIDED", total: 200 },
        pointer: null,
      });
    });
  },
);
