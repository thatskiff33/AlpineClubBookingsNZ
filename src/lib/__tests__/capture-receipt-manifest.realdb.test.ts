/**
 * #4525 (Ledger M13): the capture-receipt recorder against real PostgreSQL.
 *
 * A booking is confirmed and captured by card through the real settle
 * (`booking-ledger-history.ts`), which journals the capture's receipt. The
 * recorder is then called as a capture sender calls it. What this proves that
 * the mocked suite cannot: the recorder finds that receipt's cash in the
 * journal, its row lock is one PostgreSQL accepts and two receipts of one
 * capture wait on, and the rows it writes pass the database's own checks.
 * Xero is never called: the payment ids are made up.
 *
 * Ordinary Vitest runs skip the file; CI's real-PostgreSQL job runs it against
 * the guarded loopback race database. It cleans its own namespaced rows.
 */
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cleanHistories, createHistoryBooking, historyNames, seedHistoryFixtures, settleHistoryByCard } from "./support/booking-ledger-history";
import { assertSafeRaceDbUrl } from "./support/race-db-url";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const PREFIX = "race-4525-";
const names = historyNames(PREFIX);
/** Two guests, two nights each, at 50.00: what `createHistoryBooking` makes. */
const CAPTURED_CENTS = 20_000;

let prisma: PrismaClient;
let doors: typeof import("@/lib/member-money/doors");
let sequence = 0;

/** A booking whose card capture of 200.00 the real settle journalled under `pi_<booking id>`. */
async function capturedBooking(): Promise<{ bookingId: string; paymentIntentId: string }> {
  const bookingId = `${PREFIX}b${++sequence}`;
  const paymentIntentId = `pi_${bookingId}`;
  await createHistoryBooking(prisma, names, bookingId, { payment: { amountCents: CAPTURED_CENTS, source: "STRIPE", intent: paymentIntentId } });
  await settleHistoryByCard(bookingId, CAPTURED_CENTS);
  return { bookingId, paymentIntentId };
}

function record(capture: { bookingId: string; paymentIntentId: string | null }, key: string, amountCents: number) {
  return doors.recordCaptureReceiptManifest({
    ...capture,
    paymentKey: `${capture.bookingId}:${key}`,
    amountCents,
    providerPaymentId: `xero-payment-${capture.bookingId}-${key}`,
    invoiceId: `xero-invoice-${capture.bookingId}`,
    reference: `Stripe ${capture.paymentIntentId}`,
    bankCode: "606",
  });
}

/** The booking's receipt manifests by key, each with the cents it covers. */
async function recorded(bookingId: string) {
  const manifests = await prisma.memberMoneyExportManifest.findMany({
    where: { bookingId, documentRole: "CAPTURE_RECEIPT" },
    select: { legacyKey: true, outcome: true, reason: true, lineTotalCents: true, providerInvoiceId: true,
      coverage: { select: { account: true, chargeIdentity: true, coveredCents: true, sliceKey: true } } },
  });
  return Object.fromEntries(manifests.map(({ legacyKey, ...manifest }) => [legacyKey.slice(bookingId.length + 1), manifest]));
}

(RUN ? describe : describe.skip)("capture-receipt manifests against real PostgreSQL (#4525)", () => {
  beforeAll(async () => {
    assertSafeRaceDbUrl(RACE_DB_URL, "Capture-receipt manifest");
    process.env.DATABASE_URL = RACE_DB_URL;
    ({ prisma } = await import("@/lib/prisma"));
    doors = await import("@/lib/member-money/doors");
    await cleanHistories(prisma, PREFIX);
    await seedHistoryFixtures(prisma, PREFIX);
  }, 120_000);

  afterAll(async () => {
    if (prisma) await cleanHistories(prisma, PREFIX);
  }, 120_000);

  it("covers a journalled capture payment by payment up to its cash, then records a conflict and covers nothing more", async () => {
    const capture = await capturedBooking();
    await record(capture, "first", 12_000);
    await record(capture, "rest", 8_000);
    await record(capture, "over", 1);
    // A replay of a recorded payment, even with other cents, leaves the first row standing.
    await record(capture, "first", 12_000);
    await record(capture, "first", 11_000);

    const cover = (key: string, coveredCents: number) =>
      [{ account: "STRIPE_CLEARING", chargeIdentity: `capture:${capture.paymentIntentId}`, coveredCents, sliceKey: `${capture.bookingId}:${key}` }];
    expect(await recorded(capture.bookingId)).toEqual({
      first: { outcome: "COVERED", reason: null, lineTotalCents: 12_000, providerInvoiceId: `xero-payment-${capture.bookingId}-first`, coverage: cover("first", 12_000) },
      rest: { outcome: "COVERED", reason: null, lineTotalCents: 8_000, providerInvoiceId: `xero-payment-${capture.bookingId}-rest`, coverage: cover("rest", 8_000) },
      over: { outcome: "CONFLICT", reason: "CAPTURE_CENTS", lineTotalCents: 0, providerInvoiceId: `xero-payment-${capture.bookingId}-over`, coverage: [] },
    });
  });

  it("lets only one of two receipts sent at once spend the same cash of a capture", async () => {
    const capture = await capturedBooking();
    await Promise.all([record(capture, "left", 12_000), record(capture, "right", 12_000)]);

    const { left, right } = await recorded(capture.bookingId);
    expect([left?.outcome, right?.outcome].sort()).toEqual(["CONFLICT", "COVERED"]);
    expect([left, right].find((manifest) => manifest?.outcome === "CONFLICT")).toMatchObject({ reason: "CAPTURE_CENTS", coverage: [] });
    expect((left?.lineTotalCents ?? 0) + (right?.lineTotalCents ?? 0)).toBe(12_000);
  });

  it("#4525 review: a primary payment recorded by a failed run, then by its replay, is one manifest covering its cents once", async () => {
    const capture = await capturedBooking();
    const senders = await import("@/lib/capture-receipt-senders");
    const payment = { id: `${capture.bookingId}-payment`, stripePaymentIntentId: capture.paymentIntentId };
    const invoiceId = `xero-invoice-${capture.bookingId}`;
    const sent = { paymentID: `xero-payment-${capture.bookingId}`, amount: 123.45 };
    // The failure path's call (the raising run's own input), then a replay's from the stored payment, twice.
    await senders.recordPrimaryInvoicePaymentReceipt({ bookingId: capture.bookingId, payment, invoiceId, sent, sentCents: 12_345, reference: `Stripe ${capture.paymentIntentId}`, bankCode: "606" });
    await senders.recordStoredPrimaryInvoicePaymentReceipt(sent, payment, capture.bookingId, invoiceId);
    await senders.recordStoredPrimaryInvoicePaymentReceipt(sent, payment, capture.bookingId, invoiceId);

    const manifests = await prisma.memberMoneyExportManifest.findMany({
      where: { bookingId: capture.bookingId, documentRole: "CAPTURE_RECEIPT" },
      select: { outcome: true, lineTotalCents: true, providerInvoiceId: true, coverage: { select: { chargeIdentity: true, coveredCents: true, sliceKey: true } } },
    });
    expect(manifests).toEqual([{
      outcome: "COVERED", lineTotalCents: 12_345, providerInvoiceId: sent.paymentID,
      coverage: [{ chargeIdentity: `capture:${capture.paymentIntentId}`, coveredCents: 12_345, sliceKey: senders.primaryInvoicePaymentKey(payment.id) }],
    }]);
  });

  it("records a conflict for a capture the journal does not hold, and for a payment naming no capture", async () => {
    const capture = await capturedBooking();
    await record({ bookingId: capture.bookingId, paymentIntentId: `${capture.paymentIntentId}_unjournalled` }, "unknown", 5_000);
    await record({ bookingId: capture.bookingId, paymentIntentId: null }, "unnamed", 5_000);

    expect(await recorded(capture.bookingId)).toMatchObject({
      unknown: { outcome: "CONFLICT", reason: "CAPTURE_NOT_JOURNALLED", lineTotalCents: 0, coverage: [] },
      unnamed: { outcome: "CONFLICT", reason: "CAPTURE_NOT_JOURNALLED", lineTotalCents: 0, coverage: [] },
    });
  });
});
