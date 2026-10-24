import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  BookingStatus,
  PaymentRecoveryOperationStatus,
  PaymentRecoveryOperationType,
  PaymentSource,
  PaymentStatus,
  PaymentTransactionKind,
} from "@prisma/client";
import { describe, expect, it } from "vitest";
import { bookingWorthCents } from "@/lib/booking-payment-state";
import { MAX_PAYMENT_RECOVERY_ATTEMPTS, PAYMENT_RECOVERY_OPERATION_IN_FLIGHT_WHERE } from "@/lib/payment-recovery-constants";
import { buildDuplicateCaptureRefundRecoveryIdempotencyKey } from "@/lib/payment-recovery-keys";
import { CAPTURED_NOT_FULLY_REFUNDED_TRANSACTION_STATUS_LIST } from "@/lib/payment-transaction-status";
import { SUPERSEDED_INTENT_OPERATION_TYPES } from "@/lib/superseded-intent-ownership";
import { completedRedeliveryDeployQuery } from "./support/completed-redelivery-deploy-query";

/**
 * #4285 (`INV-SSOT`, `INV-PAY-043`): the UPGRADING deploy query, which lists
 * completed bookings that may hold a card payment nobody refunded, spells by
 * hand what the code defines once - the booking status, a payment row's kind
 * and source, the captured statuses, a cancelled intent's operation and audit
 * entry, the duplicate-capture refund's key and liveness, and the superseded
 * refund's type - because an operator runs it in psql. This pins each literal
 * to the code, so a drift fails here rather than leaving a query that quietly
 * lists nothing. The real-PostgreSQL proof (`completed-redelivery.realdb.test.ts`)
 * runs the same query.
 */
const all = (text: string, pattern: RegExp) => [...text.matchAll(pattern)].map((match) => match[1]!);
const list = (text: string) => text.split(", ").map((item) => item.slice(1, -1));
const REPO_ROOT = resolve(__dirname, "../../..");

describe("the #4285 deploy query matches the code's one definition", () => {
  const sql = completedRedeliveryDeployQuery();

  it("reads completed bookings' PRIMARY rows, card rows by the card source", () => {
    expect(all(sql, /b\.status = '([^']*)'/g)).toEqual([BookingStatus.COMPLETED]);
    expect(all(sql, /t\.kind = '([^']*)'/g)).toEqual([PaymentTransactionKind.PRIMARY]);
    expect(new Set(all(sql, /t\.source = '([^']*)'/g))).toEqual(new Set([PaymentSource.STRIPE]));
  });

  it("counts a row of any source holding money, and a card row that may yet hold it", () => {
    const lists = all(sql, /t\.status IN \(([^)]*)\)/g).map(list);
    expect(lists).toHaveLength(3);
    const [captured, uncaptured, settlementSide] = lists;
    expect(new Set(captured)).toEqual(new Set(CAPTURED_NOT_FULLY_REFUNDED_TRANSACTION_STATUS_LIST));
    expect(new Set(settlementSide)).toEqual(new Set(CAPTURED_NOT_FULLY_REFUNDED_TRANSACTION_STATUS_LIST));
    // A refused success never wrote its row, so it may still read PENDING,
    // PROCESSING or FAILED (a declined first try the member then paid).
    expect(new Set(uncaptured)).toEqual(new Set([PaymentStatus.PENDING, PaymentStatus.PROCESSING, PaymentStatus.FAILED]));
    // Only a fully REFUNDED row is never a candidate.
    expect(Object.values(PaymentStatus).filter((status) => ![...captured!, ...uncaptured!].includes(status))).toEqual([PaymentStatus.REFUNDED]);
  });

  it("treats an intent as dead only when the superseded cancel succeeded or Stripe's cancel was recorded", () => {
    expect(all(sql, /c\.type = '([^']*)'/g)).toEqual([PaymentRecoveryOperationType.CANCEL_PAYMENT_INTENT]);
    expect(SUPERSEDED_INTENT_OPERATION_TYPES).toContain(PaymentRecoveryOperationType.CANCEL_PAYMENT_INTENT);
    expect(all(sql, /c\.status = '([^']*)'/g)).toEqual([PaymentRecoveryOperationStatus.SUCCEEDED]);
    const [action] = all(sql, /a\.action = '([^']*)'/g);
    expect(action).toBe("booking.payment.canceled");
    // The webhook's `payment_intent.canceled` writes that action against the
    // booking, with the intent as the details' FIRST key - the shape the
    // query's position() reads (`JSON.stringify` writes no spaces).
    const webhook = readFileSync(resolve(REPO_ROOT, "src/lib/stripe-webhook-service.ts"), "utf8");
    const handler = webhook.slice(webhook.indexOf("async function handlePaymentIntentCanceled("));
    const auditStart = handler.indexOf("logAudit({");
    expect(auditStart).toBeGreaterThan(0);
    const audit = handler.slice(auditStart, handler.indexOf("});", auditStart));
    expect(audit).toContain(`: "${action}",`);
    expect(audit).toContain("targetId: bookingId ?? undefined,");
    expect(audit).toMatch(/details: JSON\.stringify\(\{\s*paymentIntentId: paymentIntent\.id,/);
    expect(JSON.stringify({ paymentIntentId: "pi_x", amountCents: 1 })).toContain('"paymentIntentId":"pi_x"');
  });

  it("leaves out a capture only while a duplicate-capture refund is still sending it back, by its key and the code's in-flight rule", () => {
    const [shape] = all(sql, /o\."idempotencyKey" = ([^\n]*)/g);
    const rendered = shape!.replace(
      /^'([^']*)' \|\| b\.id \|\| '([^']*)' \|\| t\."stripePaymentIntentId"$/,
      (_all, head: string, mid: string) => `${head}BOOKING${mid}PI`,
    );
    expect(rendered).toBe(buildDuplicateCaptureRefundRecoveryIdempotencyKey("BOOKING", "PI"));

    const processing = all(sql, /o\.status = '([^']*)'\n/g);
    const pending = [...sql.matchAll(/\(o\.status = '([^']*)' AND o\.attempts < (\d+)\)/g)];
    const failed = [...sql.matchAll(/\(o\.status = '([^']*)' AND o\."nextRetryAt" IS NOT NULL AND o\.attempts < (\d+)\)/g)];
    expect(processing).toHaveLength(1);
    expect(pending).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect({
      OR: [
        { status: processing[0] },
        { status: pending[0]![1], attempts: { lt: Number(pending[0]![2]) } },
        { status: failed[0]![1], nextRetryAt: { not: null }, attempts: { lt: Number(failed[0]![2]) } },
      ],
    }).toEqual(PAYMENT_RECOVERY_OPERATION_IN_FLIGHT_WHERE);
    expect(Number(pending[0]![2])).toBe(MAX_PAYMENT_RECOVERY_ATTEMPTS);
  });

  it("F4: lists any card payment on a booking paid another way - its recorded credit covering its worth, or an organiser's settlement", () => {
    // The worth is the settle's (`bookingWorthCents`: price plus a recorded change fee).
    expect(sql).toContain(`OR p."creditAppliedCents" >= b."finalPriceCents" + p."changeFeeCents"`);
    expect(sql).toContain(`OR b."organiserSettled"`);
    const schema = readFileSync(resolve(REPO_ROOT, "prisma/schema.prisma"), "utf8");
    const model = (name: string) => schema.slice(schema.indexOf(`model ${name} {`), schema.indexOf("\n}", schema.indexOf(`model ${name} {`)));
    // NOT NULL, every one: a nullable column would turn the comparison NULL and
    // silently drop the booking from the list (#4285 review F2).
    expect(model("Booking")).toMatch(/\n\s+organiserSettled\s+Boolean\s+@default\(false\)/);
    expect(model("Booking")).toMatch(/\n\s+finalPriceCents\s+Int\s*(\n|\/\/)/);
    expect(model("Payment")).toMatch(/\n\s+creditAppliedCents\s+Int\s+@default\(0\)/);
    expect(model("Payment")).toMatch(/\n\s+changeFeeCents\s+Int\s+@default\(0\)/);
    expect(bookingWorthCents({ finalPriceCents: 100, changeFeeCents: 25 })).toBe(125);
  });

  it("leaves out a capture the superseded-payment refund owns", () => {
    const [type] = all(sql, /s\.type = '([^']*)'/g);
    expect(type).toBe(PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT);
    expect(SUPERSEDED_INTENT_OPERATION_TYPES).toContain(type);
  });
});
