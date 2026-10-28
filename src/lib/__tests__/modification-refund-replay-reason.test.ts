/**
 * `INV-MOD-061` (#4101, the #1507 rule): A BOOKING EDIT'S CARD REFUND AND ITS
 * RECOVERY REPLAY SEND ONE STRIPE REQUEST.
 *
 * Stripe refuses a reused idempotency key whose parameters differ
 * (`idempotency_error`), so a refund made on Stripe but lost locally recovers
 * only if the replay sends the original body. `executeBookingModificationRefund`
 * takes no reason of its own: it stamps the one
 * `bookingModificationRefundReasonForKeyPrefix` gives its caller's key prefix,
 * and the replay rebuilds the reason from that same prefix stored on the row.
 * Before #4101 each caller passed its reason by hand, and the guest-acceptance
 * re-price's prefix was missing from the map, so its replay never converged.
 *
 * The census finds EVERY caller by AST and pins each one's reason to the
 * literal it sent before the reason was derived, so the change of source is
 * byte-identical on Stripe and a new caller is asked here whether the map knows
 * its prefix. The behavioural half drives the real helper per caller;
 * `payment-recovery.test.ts` pins that the replay processor builds the same
 * body per stored prefix.
 */
import { readFileSync } from "node:fs";
import ts from "typescript";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  relativeSource,
  sourceFiles,
} from "@/lib/__tests__/support/booking-guest-night-writer-scan";

const h = vi.hoisted(() => ({
  alertPaymentRecoveryOfficers: vi.fn(),
  refundPaymentTransactions: vi.fn(),
  enqueueBookingModificationRefundRecovery: vi.fn(),
}));

vi.mock("@/lib/payment-recovery-alert", () => ({ alertPaymentRecoveryOfficers: h.alertPaymentRecoveryOfficers }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/payment-transactions", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/payment-transactions")),
  planStripeRefundAllocation: vi.fn(async ({ amountCents }: { amountCents: number }) => ({
    slices: [{ paymentTransactionId: "txn_refund", amountCents }],
    plannedAmountCents: amountCents,
    totalRefundableCents: amountCents,
  })),
  refundPaymentTransactions: h.refundPaymentTransactions,
}));
vi.mock("@/lib/payment-recovery", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/payment-recovery")),
  enqueueBookingModificationRefundRecovery:
    h.enqueueBookingModificationRefundRecovery,
}));

import { planStripeRefundAllocation, PartialRefundError } from "@/lib/payment-transactions";
import { executeBookingModificationRefund } from "@/lib/booking-modification-settlement";
import {
  bookingModificationRefundReasonForKeyPrefix,
  buildBookingModificationRefundMetadata,
} from "@/lib/payment-recovery-keys";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const HELPER = "executeBookingModificationRefund";

type Caller = { file: string; keyPrefix: string };

/** The literal head of `idempotencyKeyPrefix`: `guest_accept_refund_${id}` -> `guest_accept_refund_`. */
function literalKeyPrefix(node: ts.Expression): string | undefined {
  if (ts.isTemplateExpression(node)) return node.head.text || undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text || undefined;
  }
  return undefined;
}

function scanCallers(): { callers: Caller[]; unreadable: string[] } {
  const callers: Caller[] = [];
  const unreadable: string[] = [];
  for (const file of sourceFiles()) {
    const code = readFileSync(file, "utf8");
    if (!code.includes(HELPER)) continue;
    const source = ts.createSourceFile(
      file,
      code,
      ts.ScriptTarget.Latest,
      false,
      /[jt]sx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === HELPER
      ) {
        const where = `${relativeSource(file)}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
        const [arg] = node.arguments;
        const property = (name: string) =>
          arg && ts.isObjectLiteralExpression(arg)
            ? arg.properties.find(
                (p): p is ts.PropertyAssignment =>
                  ts.isPropertyAssignment(p) &&
                  ts.isIdentifier(p.name) &&
                  p.name.text === name,
              )?.initializer
            : undefined;
        const prefix = property("idempotencyKeyPrefix");
        const keyPrefix = prefix ? literalKeyPrefix(prefix) : undefined;
        if (keyPrefix) {
          callers.push({ file: relativeSource(file), keyPrefix });
        } else {
          unreadable.push(where);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { callers, unreadable };
}

const { callers: CALLERS, unreadable: UNREADABLE } = scanCallers();

/**
 * The reason each caller passed by hand before #4101 derived it from the
 * prefix. Spelled here, never read from the map under test: Stripe already
 * holds refunds with these exact bodies, so a replay of one must send the same.
 */
const REASON_SENT_BEFORE_4101: Record<string, string> = {
  mod_dates_refund_: "date_change_price_decrease",
  mod_batch_refund_: "batch_modification",
  guest_remove_refund_: "guest_removed_price_decrease",
  guest_accept_refund_: "guest_accepted_promo_reprice",
};

describe("INV-MOD-061: a booking edit's card refund and its replay send one request (#4101)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The inline refund fails after Stripe may have made it (a timeout): the
    // helper stores its key prefix for the replay.
    h.refundPaymentTransactions.mockRejectedValue(new Error("Stripe timed out"));
    h.enqueueBookingModificationRefundRecovery.mockResolvedValue({});
  });

  it("reads every caller's key prefix as a literal, so none escapes the check", () => {
    // INV-MOD-061: a caller passing a computed prefix cannot be checked here.
    // Spell its head as a literal at the call site, or extend this census to
    // read the new shape - never exempt it.
    expect(UNREADABLE, "INV-MOD-061: unreadable executeBookingModificationRefund prefix").toEqual([]);
  });

  it("finds the four booking-edit refund callers, each with a prefix the reason map knows", () => {
    expect(CALLERS.map(({ file, keyPrefix }) => `${file} ${keyPrefix}`).sort()).toEqual([
      "src/app/api/bookings/[id]/guests/[guestId]/route.ts guest_remove_refund_",
      "src/lib/booking-batch-modification-service.ts mod_batch_refund_",
      "src/lib/booking-date-modification-service.ts mod_dates_refund_",
      "src/lib/booking-guest-acceptance-reprice.ts guest_accept_refund_",
    ]);
    for (const { file, keyPrefix } of CALLERS) {
      expect(
        bookingModificationRefundReasonForKeyPrefix(`${keyPrefix}booking-1_mod-1`),
        `INV-MOD-061: ${file} passes ${keyPrefix}, which bookingModificationRefundReasonForKeyPrefix does not know - add its reason there`,
      ).not.toBe("booking_modification_refund_recovery");
    }
  });

  it.each(CALLERS)(
    "$file ($keyPrefix): sends its pre-#4101 reason, and the replay rebuilds it from the stored prefix",
    async ({ keyPrefix }) => {
      const bookingId = "booking-1";
      await executeBookingModificationRefund({
        format: CLUB_FORMAT_TEST,
        bookingId,
        result: {
          pendingRefundAmountCents: 4000,
          paymentId: "pay-1",
          bookingModificationId: "mod-1",
          organiserChildRefund: null,
        } as never,
        idempotencyKeyPrefix: `${keyPrefix}${bookingId}`,
        failureMessage: "inline refund failed",
        recoveryFailureMessage: "enqueue failed",
      });

      const [inline] = h.refundPaymentTransactions.mock.calls[0];
      const [enqueued] = h.enqueueBookingModificationRefundRecovery.mock.calls[0];
      // Byte-identical to what this caller sent while it passed the reason by
      // hand, so refunds Stripe already holds replay too.
      expect(inline.metadata, `INV-MOD-061: ${keyPrefix} changed its Stripe reason`).toEqual({
        bookingId,
        reason: REASON_SENT_BEFORE_4101[keyPrefix],
      });
      // The replay sends under the prefix the row stored, so it must be the
      // inline call's own.
      expect(enqueued.stripeKeyPrefix).toBe(inline.idempotencyKeyPrefix);
      // The body the replay's modification branch builds from that stored
      // prefix alone (pinned per prefix in payment-recovery.test.ts).
      expect(
        buildBookingModificationRefundMetadata(
          bookingId,
          bookingModificationRefundReasonForKeyPrefix(enqueued.stripeKeyPrefix),
        ),
        "INV-MOD-061: the replay would send another body under the same key",
      ).toEqual(inline.metadata);
    },
  );
});

// #3984: the plan carries progress for every slice, even on a thrown attempt.
describe("an edit's frozen refund plan after a partial attempt (#3984)", () => {
  const plan = [
    { paymentTransactionId: "made", amountCents: 2000 },
    { paymentTransactionId: "refused", amountCents: 3000 },
    { paymentTransactionId: "unanswered", amountCents: 3000 },
  ];
  const execute = () => executeBookingModificationRefund({
    format: CLUB_FORMAT_TEST, bookingId: "booking-1",
    result: { pendingRefundAmountCents: 8000, paymentId: "pay-1", bookingModificationId: "mod-1", organiserChildRefund: null } as never,
    idempotencyKeyPrefix: "mod_dates_refund_booking-1", failureMessage: "refund failed", recoveryFailureMessage: "enqueue failed",
  });
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(planStripeRefundAllocation).mockResolvedValue({ slices: plan, plannedAmountCents: 8000, totalRefundableCents: 8000 });
    h.enqueueBookingModificationRefundRecovery.mockResolvedValue({ created: true });
    h.refundPaymentTransactions.mockRejectedValue(new PartialRefundError({
      completedRefundCents: 2000,
      refunds: [
        { paymentIntentId: "pi_made", refundId: "re_made", amountCents: 2000 },
        { paymentIntentId: "pi_refused", refundId: "re_refused", amountCents: 3000 },
      ],
      refusedSlices: [plan[1]], cause: new Error("third slice lost its reply"), format: CLUB_FORMAT_TEST,
    }));
  });

  it("keeps the whole plan: made marked, refused on a fresh key, unanswered on its original key", async () => {
    expect((await execute()).refundDestination).toBe("own_card_pending");
    expect(h.refundPaymentTransactions).toHaveBeenCalledWith(expect.objectContaining({ allocation: plan }));
    expect(h.enqueueBookingModificationRefundRecovery).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 8000, allocationPlan: [
      { ...plan[0], madeRefundId: "re_made" }, { ...plan[1], stripeKeySuffix: "refused1" }, plan[2],
    ] }));
    expect(h.alertPaymentRecoveryOfficers).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 3000, paymentIntentId: "pi_refused" }), CLUB_FORMAT_TEST);
  });

  it("still alerts a refused slice when writing recovery also fails (#4117)", async () => {
    h.enqueueBookingModificationRefundRecovery.mockRejectedValue(new Error("enqueue failed too"));
    expect((await execute()).refundDestination).toBe("own_card_pending");
    expect(h.alertPaymentRecoveryOfficers).toHaveBeenCalledTimes(1);
  });

  it("does not repeat the refusal alert when the recovery row already exists", async () => {
    h.enqueueBookingModificationRefundRecovery.mockResolvedValue({ created: false });
    await execute();
    expect(h.alertPaymentRecoveryOfficers).not.toHaveBeenCalled();
  });

  it("keeps the original shortfall failure before Stripe and queues the full debt", async () => {
    vi.mocked(planStripeRefundAllocation).mockResolvedValue({ slices: [plan[0]], plannedAmountCents: 2000, totalRefundableCents: 2000 });
    expect((await execute()).refundDestination).toBe("own_card_pending");
    expect(h.refundPaymentTransactions).not.toHaveBeenCalled();
    expect(h.enqueueBookingModificationRefundRecovery).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 8000, allocationPlan: undefined }));
  });
});
