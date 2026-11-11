/**
 * Real-PostgreSQL proof of #4936: the refund-note gap list
 * (`getRefundsMissingXeroCreditNotes`, behind the Xero health check and the
 * nightly card self-heal) drops payments its active links' recorded amounts
 * already cover, in one query, and still answers exactly as the per-payment
 * reader (`readRefundCreditNoteGap`) does for every payment.
 *
 * Five $250 card refunds, each invoiced in Xero and past the 24-hour grace:
 * - covered: one live link recording $250 - the pre-filter drops it;
 * - short: one live link recording $100 - a $150 gap;
 * - legacy-covered and legacy-short: a link with no recorded amount, its value
 *   only in the create row's payload ($250 and $100) - the pre-filter cannot
 *   read that, so both reach the exact reader, which lists only the short one;
 * - unlinked: no note at all - a $250 gap.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions, which
 * imports this file so CI reaches it; it owns and cleans its own `race-4936-`
 * fixtures. No Stripe or Xero call is made.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const P = "race-4936";
const MEMBER_ID = `${P}-member`;
const LODGE_ID = `${P}-lodge`;
const PAID_CENTS = 40_000;
const REFUND_CENTS = 25_000;
const CHECK_IN = new Date("2026-08-01T00:00:00.000Z");
const CHECK_OUT = new Date("2026-08-03T00:00:00.000Z");
/** Past every payment's 24-hour grace: the list as a later night reads it. */
const LATER_NIGHT = new Date("2100-01-01T00:00:00.000Z");

type Note = { kind: "recorded"; cents: number } | { kind: "legacy"; cents: number } | null;
/** In `updatedAt` order: the list keeps it. */
const CASES: ReadonlyArray<{ key: string; note: Note }> = [
  { key: "covered", note: { kind: "recorded", cents: REFUND_CENTS } },
  { key: "short", note: { kind: "recorded", cents: 10_000 } },
  { key: "legacy-covered", note: { kind: "legacy", cents: REFUND_CENTS } },
  { key: "legacy-short", note: { kind: "legacy", cents: 10_000 } },
  { key: "unlinked", note: null },
];
const paymentId = (key: string) => `${P}-${key}-payment`;
const bookingId = (key: string) => `${P}-${key}-booking`;
const PAYMENT_IDS = CASES.map(({ key }) => paymentId(key));

/** Standalone fail-closed copy: importing this file must not register another suite. */
function assertSafeRaceDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Refund-gap pre-filter proofs need a valid CONCURRENCY_RACE_DATABASE_URL.");
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(
      `Refusing to run refund-gap pre-filter proofs against port ${parsed.port || "(none)"}: use a throwaway PostgreSQL on 55442+ (never 5432).`,
    );
  }
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname.toLowerCase())) {
    throw new Error("Refund-gap pre-filter proof DB must be loopback-only.");
  }
  if (!decodeURIComponent(parsed.pathname.replace(/^\//, "")).includes("concurrency_race_1881")) {
    throw new Error("Refund-gap pre-filter proof DB name must contain 'concurrency_race_1881'.");
  }
}

let prisma: (typeof import("@/lib/prisma"))["prisma"];

(RUN ? describe : describe.skip)(
  "the refund-note gap list skips link-covered payments and answers as the exact reader - real PostgreSQL (#4936)",
  { timeout: 60_000 },
  () => {
    async function deleteFixtures() {
      await prisma.xeroSyncOperation.deleteMany({ where: { localModel: "Payment", localId: { in: PAYMENT_IDS } } });
      await prisma.xeroObjectLink.deleteMany({ where: { localModel: "Payment", localId: { in: PAYMENT_IDS } } });
      await prisma.paymentRefund.deleteMany({ where: { paymentId: { in: PAYMENT_IDS } } });
      await prisma.paymentTransaction.deleteMany({ where: { paymentId: { in: PAYMENT_IDS } } });
      await prisma.payment.deleteMany({ where: { id: { in: PAYMENT_IDS } } });
      await prisma.booking.deleteMany({ where: { id: { in: CASES.map(({ key }) => bookingId(key)) } } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
    }

    /** A card payment, invoiced in Xero, with one $250 refund Stripe confirmed, and its note as the case says. */
    async function refundedCardPayment(key: string, note: Note) {
      const id = paymentId(key);
      const intent = `pi_${P}_${key}`;
      const txn = `${P}-${key}-txn`;
      const noteId = `${P}-${key}-note`;
      await prisma.booking.create({
        data: { id: bookingId(key), memberId: MEMBER_ID, lodgeId: LODGE_ID, checkIn: CHECK_IN, checkOut: CHECK_OUT, status: "PAID", totalPriceCents: PAID_CENTS, finalPriceCents: PAID_CENTS },
      });
      await prisma.payment.create({
        data: {
          id, bookingId: bookingId(key), amountCents: PAID_CENTS, refundedAmountCents: REFUND_CENTS, source: "STRIPE",
          status: "PARTIALLY_REFUNDED", stripePaymentIntentId: intent, xeroInvoiceId: `inv-${P}-${key}`,
          transactions: {
            create: {
              id: txn, kind: "PRIMARY", source: "STRIPE", stripePaymentIntentId: intent, amountCents: PAID_CENTS,
              refundedAmountCents: REFUND_CENTS, status: "PARTIALLY_REFUNDED",
            },
          },
        },
      });
      await prisma.paymentRefund.create({
        data: {
          paymentId: id, paymentTransactionId: txn, stripeRefundId: `re_${P}_${key}`, stripePaymentIntentId: intent,
          amountCents: REFUND_CENTS, currency: "nzd", status: "succeeded", stripeCreatedAt: new Date("2026-06-01T00:00:00.000Z"),
        },
      });
      if (!note) return;
      await prisma.xeroObjectLink.create({
        data: {
          localModel: "Payment", localId: id, xeroObjectType: "CREDIT_NOTE", xeroObjectId: noteId, role: "REFUND_CREDIT_NOTE", active: true,
          metadata: note.kind === "recorded" ? { amountCents: note.cents, status: "AUTHORISED" } : { status: "AUTHORISED" },
        },
      });
      if (note.kind === "legacy") {
        // A note from before links recorded amounts: its value is only in the create row's allocation, in dollars.
        await prisma.xeroSyncOperation.create({
          data: {
            direction: "OUTBOUND", entityType: "CREDIT_NOTE", operationType: "CREATE", localModel: "Payment", localId: id,
            status: "SUCCEEDED", xeroObjectId: noteId, requestPayload: { allocation: { amount: note.cents / 100 } },
          },
        });
      }
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));

      await deleteFixtures();
      await prisma.member.create({
        data: { id: MEMBER_ID, email: `${MEMBER_ID}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Gap", lastName: "Filter", role: "USER", ageTier: "ADULT" },
      });
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4936 Lodge", slug: P } });
      for (const { key, note } of CASES) {
        await refundedCardPayment(key, note);
      }
    }, 60_000);

    afterAll(async () => {
      if (!prisma) return;
      await deleteFixtures();
    }, 60_000);

    it("the pre-filter's one read sees only recorded link amounts: a legacy link counts 0", async () => {
      const { readActiveRefundNoteMetadataCentsByPayment } = await import("@/lib/xero-sync");

      const cents = await readActiveRefundNoteMetadataCentsByPayment(PAYMENT_IDS);

      expect(Object.fromEntries(cents)).toEqual({
        [paymentId("covered")]: REFUND_CENTS,
        [paymentId("short")]: 10_000,
        [paymentId("legacy-covered")]: 0,
        [paymentId("legacy-short")]: 0,
      });
    });

    it("MUTATION: the list is the exact reader's answer for every payment, in order", async () => {
      const { getRefundsMissingXeroCreditNotes, readRefundCreditNoteGap } = await import("@/lib/xero-admin-health");

      const listed = (await getRefundsMissingXeroCreditNotes({ now: LATER_NIGHT })).payments.filter((row) => PAYMENT_IDS.includes(row.paymentId));

      const exact: Array<[string, number]> = [];
      for (const id of PAYMENT_IDS) {
        const payment = await prisma.payment.findUniqueOrThrow({ where: { id }, select: { id: true, bookingId: true, refundedAmountCents: true } });
        const gap = await readRefundCreditNoteGap(payment);
        if (gap.uncoveredCents > 0) exact.push([id, gap.uncoveredCents]);
      }
      expect(exact).toEqual([
        [paymentId("short"), 15_000],
        [paymentId("legacy-short"), 15_000],
        [paymentId("unlinked"), REFUND_CENTS],
      ]);
      expect(listed.map((row) => [row.paymentId, row.uncoveredCents])).toEqual(exact);
    });
  },
);
