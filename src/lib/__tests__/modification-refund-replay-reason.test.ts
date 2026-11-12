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
 * door it uses and the prefix/reason it sent before they were shared, so it is
 * byte-identical on Stripe and a new caller is asked here whether the map knows
 * its door. The behavioural half drives the real helper per caller;
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
  markBookingModificationRefundRecoverySucceeded: vi.fn(),
}));

vi.mock("@/lib/payment-recovery-alert", () => ({ alertPaymentRecoveryOfficers: h.alertPaymentRecoveryOfficers }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/payment-transactions", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/payment-transactions")),
  refundPaymentTransactions: h.refundPaymentTransactions,
}));
vi.mock("@/lib/payment-recovery", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/payment-recovery")),
  markBookingModificationRefundRecoverySucceeded:
    h.markBookingModificationRefundRecoverySucceeded,
}));

import { executeBookingModificationRefund } from "@/lib/booking-modification-settlement";
import {
  BOOKING_MODIFICATION_REFUND_DOORS,
  type BookingModificationRefundDoor,
  buildBookingModificationRefundKeyPrefix,
  bookingModificationRefundReasonForKeyPrefix,
  buildBookingModificationRefundMetadata,
} from "@/lib/payment-recovery-keys";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const HELPER = "executeBookingModificationRefund";

type Caller = { file: string; door: BookingModificationRefundDoor };

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
        const door = property("door");
        if (door && ts.isStringLiteral(door) && door.text in BOOKING_MODIFICATION_REFUND_DOORS) {
          callers.push({ file: relativeSource(file), door: door.text as BookingModificationRefundDoor });
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
    h.refundPaymentTransactions.mockResolvedValue({ refunds: [{ refundId: "re-1", paymentIntentId: "pi-1", amountCents: 4000, status: "succeeded", slice: { paymentTransactionId: "txn_refund", amountCents: 4000 } }] });
    h.markBookingModificationRefundRecoverySucceeded.mockResolvedValue({ count: 1 });
  });

  it("reads every caller's registered door, so none escapes the check", () => {
    // Dynamic doors must extend the scan, never silently escape it.
    expect(UNREADABLE, "INV-MOD-061: unreadable executeBookingModificationRefund door").toEqual([]);
  });

  it("finds the four booking-edit refund callers, each with a prefix the reason map knows", () => {
    expect(CALLERS.map(({ file, door }) => `${file} ${door}`).sort()).toEqual([
      "src/app/api/bookings/[id]/guests/[guestId]/route.ts guestRemoval",
      "src/lib/booking-batch-modification-service.ts batchModify",
      "src/lib/booking-date-modification-service.ts dateChange",
      "src/lib/booking-guest-acceptance-reprice.ts guestAcceptanceReprice",
    ]);
    for (const { file, door } of CALLERS) {
      const keyPrefix = buildBookingModificationRefundKeyPrefix(door, "booking-1");
      expect(
        bookingModificationRefundReasonForKeyPrefix(`${keyPrefix}_mod-1`),
        `INV-MOD-061: ${file} passes ${keyPrefix}, which bookingModificationRefundReasonForKeyPrefix does not know - add its reason there`,
      ).not.toBe("booking_modification_refund_recovery");
    }
  });

  it.each(CALLERS)(
    "$file ($door): sends its pre-#4101 reason, and the replay rebuilds it from the stored prefix",
    async ({ door }) => {
      const keyPrefix = BOOKING_MODIFICATION_REFUND_DOORS[door].prefix;
      const bookingId = "booking-1";
      await executeBookingModificationRefund({
        format: CLUB_FORMAT_TEST,
        bookingId,
        result: {
          pendingRefundAmountCents: 4000,
          paymentId: "pay-1",
          bookingModificationId: "mod-1",
          organiserChildRefund: null,
          ownCardRefund: { plan: [{ paymentTransactionId: "txn_refund", amountCents: 4000 }] },
        } as never,
        door,
        failureMessage: "inline refund failed",
      });

      const [inline] = h.refundPaymentTransactions.mock.calls[0];
      const storedPrefix = `${buildBookingModificationRefundKeyPrefix(door, bookingId)}_mod-1`;
      // Byte-identical to what this caller sent while it passed the reason by
      // hand, so refunds Stripe already holds replay too.
      expect(inline.metadata, `INV-MOD-061: ${keyPrefix} changed its Stripe reason`).toEqual({
        bookingId,
        reason: REASON_SENT_BEFORE_4101[keyPrefix],
      });
      // The replay sends under the prefix the row stored, so it must be the
      // inline call's own.
      expect(storedPrefix).toBe(inline.idempotencyKeyPrefix);
      // The body the replay's modification branch builds from that stored
      // prefix alone (pinned per prefix in payment-recovery.test.ts).
      expect(
        buildBookingModificationRefundMetadata(
          bookingId,
          bookingModificationRefundReasonForKeyPrefix(storedPrefix),
        ),
        "INV-MOD-061: the replay would send another body under the same key",
      ).toEqual(inline.metadata);
    },
  );
});


/** AST calls, including enclosing functions: comments cannot stand in for a reserve. */
function callsNamed(name: string) {
  const calls: { file: string; node: ts.CallExpression; source: ts.SourceFile }[] = [];
  for (const file of sourceFiles()) {
    const code = readFileSync(file, "utf8");
    if (!code.includes(name)) continue;
    const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) {
        calls.push({ file: relativeSource(file), node, source });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return calls;
}

function property(node: ts.Node | undefined, name: string): ts.Expression | undefined {
  if (!node || !ts.isObjectLiteralExpression(node)) return undefined;
  const value = node.properties.find((p): p is ts.PropertyAssignment =>
    ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === name);
  return value?.initializer;
}

function containingFunction(node: ts.Node): string | undefined {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isFunctionDeclaration(parent)) return parent.name?.text;
  }
  return undefined;
}

// These edges bind the after-commit attempt to its transaction producer. The
// realdb crash-window tests prove the persisted state; this census prevents a
// fifth executor or a shared removal caller escaping that coverage unnoticed.
describe("every booking-edit refund reserves its debt before commit (#4992)", () => {
  const reserves = callsNamed("reserveModificationRefundDebts");
  const producerFiles: Record<BookingModificationRefundDoor, string> = {
    dateChange: "src/lib/booking-date-modification-service.ts",
    batchModify: "src/lib/booking-batch-modification-service.ts",
    guestRemoval: "src/lib/booking-guest-removal-service.ts",
    guestAcceptanceReprice: "src/lib/booking-guest-acceptance-reprice.ts",
  };

  it("each registered executor has one matching reserve using its transaction client", () => {
    expect(reserves.map(({ file, node }) => `${file} ${property(node.arguments[1], "door")?.getText()}`).sort()).toEqual(
      Object.entries(producerFiles).map(([door, file]) => `${file} "${door}"`).sort(),
    );
    for (const { door } of CALLERS) {
      const reserve = reserves.find(({ file }) => file === producerFiles[door]);
      expect(reserve, `missing in-transaction reserve for ${door}`).toBeDefined();
      expect(reserve!.node.arguments[0]?.getText()).toBe("tx");
      // A reserve nested in an after-commit callback would have no tx binding.
      let bindsTx = false;
      for (let node = reserve!.node.parent; node; node = node.parent) {
        if (ts.isFunctionLike(node) && node.parameters.some((p) => p.name.getText() === "tx" ||
          (ts.isObjectBindingPattern(p.name) && p.name.elements.some((e) => e.name.getText() === "tx")))) bindsTx = true;
      }
      expect(bindsTx, `${door} reserve must run in its tx scope`).toBe(true);
    }
  });

  it("the guest route and consent's shared removal are the complete service caller population", () => {
    expect(callsNamed("removeBookingGuestInTransaction").map(({ file, node }) => `${file} ${containingFunction(node)}`).sort()).toEqual([
      "src/app/api/bookings/[id]/guests/[guestId]/route.ts DELETE",
      "src/lib/member-guest-consent-service.ts removeClaimedConsentGuest",
    ]);
    expect(reserves.filter(({ file, node }) => file === producerFiles.guestRemoval &&
      containingFunction(node) === "removeBookingGuestInTransaction")).toHaveLength(1);
  });

  it("both consent decline and expiry use that reserved removal with the same transaction", () => {
    const calls = callsNamed("removeClaimedConsentGuest");
    expect(calls.map(({ node }) => containingFunction(node)).sort()).toEqual([
      "expireMemberGuestConsent", "respondToMemberGuestConsent",
    ]);
    expect(calls.map(({ node }) => property(node.arguments[1], "kind")?.getText()).sort()).toEqual([
      '"CONSENT_DECLINE"', '"CONSENT_EXPIRY"',
    ]);
    for (const { node } of calls) expect(node.arguments[0]?.getText()).toBe("tx");
  });
});
