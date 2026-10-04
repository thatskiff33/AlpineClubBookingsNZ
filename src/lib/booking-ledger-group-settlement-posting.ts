/**
 * WHICH LINES A GROUP ORGANISER'S SETTLEMENT POSTS ON ITS CHILDREN (#3854,
 * programme #3527 Stage 4; owner decision 2A on #3583; design
 * `docs/design/booking-ledger.md` §5.2).
 *
 * A group organiser settles every joiner's child booking in one payment — one
 * card intent or one combined Internet Banking invoice (`GroupBookingSettlement`).
 * No `PaymentTransaction` exists per child, so `syncBookingLedgerSettlements`
 * finds nothing to post for them. This posts each child's SHARE instead: one
 * settlement line per child, anchored on the settlement.
 *
 * Pure: it reads nothing and writes nothing. The live settle calls it through
 * `booking-ledger-group-settlement-sync.ts`; the back-post (#3583 PR 2) calls it
 * for the historical children with the same inputs read from the rows, so both
 * mint the same keys and a child posted twice is a skipped replay.
 *
 * A SHARE IS THE CHILD'S OWN PRICE, NEVER A SPLIT OF THE TOTAL. The settle is
 * refused unless the settlement's total equals the sum of its children's
 * `finalPriceCents` (#1033, `INV-PAY-105`), so each child's share is exactly what
 * it cost and nothing is ever divided — there is no rounding to distribute. The
 * planner holds the same identity as a fence (sum or nothing): shares that do
 * not add up to the settlement post nothing, and the caller logs the gap for
 * C4's census rather than guess which child absorbs the difference.
 */
import type { PaymentSource } from "@prisma/client";

import type { BookingLedgerPosting } from "@/lib/booking-ledger-write";
import { groupSettlementRefundKey, groupSettlementShareKey } from "@/lib/booking-ledger-posting-keys";

export type GroupSettlementForPosting = {
  id: string;
  /** How the organiser paid: `STRIPE` (card) or `INTERNET_BANKING`. */
  source: PaymentSource;
  /** What the settlement collected. The shares must add up to it. */
  amountCents: number;
};

export type GroupSettlementChildShare = {
  bookingId: string;
  lodgeId: string;
  /** The child's price as the settlement paid it (`finalPriceCents` at the settle). */
  shareCents: number;
};

export type GroupSettlementSharePlan = {
  postings: BookingLedgerPosting[];
  /** False when the shares do not add up to the settlement; nothing is posted then. */
  reconciles: boolean;
  totalShareCents: number;
};

/** How the money moved, as the settlement's own source says (`INV-PAY-013`). */
function settlementShape(
  source: PaymentSource,
  direction: "share" | "refund",
): Pick<BookingLedgerPosting, "kind" | "settlementMethod" | "narration"> {
  const card = source === "STRIPE";
  if (direction === "share") {
    return card
      ? { kind: "CARD_CAPTURE", settlementMethod: "CARD", narration: "Paid by the group organiser (card)" }
      : {
          kind: "BANK_RECEIPT",
          settlementMethod: "INTERNET_BANKING",
          narration: "Paid by the group organiser (Internet Banking)",
        };
  }
  return card
    ? { kind: "CARD_REFUND", settlementMethod: "CARD", narration: "Refunded to the group organiser (card)" }
    : {
        kind: "BANK_REFUND",
        settlementMethod: "INTERNET_BANKING",
        narration: "Refunded to the group organiser (Internet Banking)",
      };
}

/**
 * One settlement line per child for its share. The caller passes exactly the
 * children the settlement paid — the live settle, the children it flips to PAID;
 * the back-post, the children the settlement's payment covered. A child
 * cancelled before the settlement was on no bill and is not passed; if it is
 * still counted in the settlement's total, the shares do not add up and nothing
 * posts (the live settle refuses that payment before reaching here).
 */
export function planGroupSettlementShareLines(input: {
  settlement: GroupSettlementForPosting;
  children: readonly GroupSettlementChildShare[];
}): GroupSettlementSharePlan {
  const totalShareCents = input.children.reduce((sum, child) => sum + child.shareCents, 0);
  if (totalShareCents !== input.settlement.amountCents) {
    return { postings: [], reconciles: false, totalShareCents };
  }
  const postings: BookingLedgerPosting[] = [];
  for (const child of input.children) {
    // A $0 share moves no money, so it posts nothing (§9: INV-PAY-007).
    if (child.shareCents <= 0) continue;
    postings.push({
      bookingId: child.bookingId,
      lodgeId: child.lodgeId,
      side: "SETTLEMENT",
      ...settlementShape(input.settlement.source, "share"),
      sign: 1,
      quantity: 1,
      unitCents: child.shareCents,
      anchorKind: "GROUP_SETTLEMENT",
      anchorId: input.settlement.id,
      postingKey: groupSettlementShareKey(input.settlement.id, child.bookingId),
    });
  }
  return { postings, reconciles: true, totalShareCents };
}

/**
 * The refund the organiser's cancellation plan (`refundPlan`, #1236) hands back
 * on one child: a card plan frozen before #3653, or an Internet Banking
 * settlement's plan, whose refund the club makes by hand. Null for nothing.
 */
export function planGroupSettlementRefundLine(input: {
  settlement: Pick<GroupSettlementForPosting, "id" | "source">;
  bookingId: string;
  lodgeId: string;
  refundCents: number;
}): BookingLedgerPosting | null {
  if (input.refundCents <= 0) return null;
  return {
    bookingId: input.bookingId,
    lodgeId: input.lodgeId,
    side: "SETTLEMENT",
    ...settlementShape(input.settlement.source, "refund"),
    sign: -1,
    quantity: 1,
    unitCents: input.refundCents,
    anchorKind: "GROUP_SETTLEMENT",
    anchorId: input.settlement.id,
    postingKey: groupSettlementRefundKey(input.settlement.id, input.bookingId),
  };
}
