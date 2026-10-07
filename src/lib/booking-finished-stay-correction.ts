/**
 * The finished-stay correction (#3750): an officer-approved LOCKED_PERIOD change
 * request executed on a stay that has already finished.
 *
 * ONE HOME for what makes this edit different from every other batch edit, so
 * the executor that asks for it and the service that honours it read the same
 * rule (`INV-SSOT-001`):
 *
 *  - {@link FinishedStayCorrection} — the service argument itself. It is never a
 *    request-body field; `modifyBookingBatch` takes it beside `tx`, and
 *    `finished-stay-correction-call-sites.test.ts` pins the executor in
 *    `booking-change-request-execution.ts` as its only caller.
 *  - {@link classifyFinishedStayChangeFeeRule} — the owner's change-fee rule
 *    (decision record on #3750, 6 Oct 2026): adding guests incurs NO change fee;
 *    any removal or swap is charged "as if it normally would have been for a same
 *    day (0 day) notice change".
 *  - {@link finishedStayNoticeDay} — how "a 0-day notice" is expressed to the
 *    ordinary fee machinery: the day the late-notice change fee, the reduction's
 *    refund tier and the applied-credit give-back tier are measured FROM is the
 *    stay's own check-in, so `daysUntilCheckIn` is 0 for every one of them. A
 *    finished stay measured from the real today would be a NEGATIVE notice
 *    period, which `getRefundTier` answers with no tier at all (0%) — harsher
 *    than the club's own same-day tier, and not what the owner decided.
 */

import { ApiError } from "@/lib/api-error";
import type { PrismaTransactionClient } from "@/lib/db-transaction";
import {
  calendarDateOfDateOnlyInstant,
  eachCalendarDate,
  type CalendarDate,
} from "@/lib/club-time";
import { storedDateOnly } from "@/lib/stored-calendar-day";
import { calculateDualRefundAmounts, type CancellationRule } from "@/lib/policies/cancellation";

/**
 * The service argument that turns a batch edit into a finished-stay correction.
 * `changeRequestId` is the approved request it executes, recorded on the
 * modification row and the audit trail so the two are joined both ways (the
 * request also carries `linkedModificationId`).
 */
export interface FinishedStayCorrection {
  readonly changeRequestId: string;
}

/**
 * The three conditions `modifyBookingBatch` holds a finished-stay correction to.
 *
 * WHAT IT CHANGES in the batch edit, and it is deliberately little — everything
 * else is the ordinary edit, so pricing, settlement, the additional-payment ask,
 * the Xero documents, the ledger lines and the member email keep their one home:
 * the edit policy admits the finished stay with only the fields a change request
 * carries (`resolveTargetDates`); an over-capacity past night warns and asks the
 * officer to confirm, as the #1668 date override does, while a whole-lodge hold
 * still refuses; the fee rule below; and the Xero lock-date decision is taken
 * over the RESOLVED envelope, because a stay-range change can re-date the
 * primary invoice without naming a date.
 *
 * WHY THESE CONDITIONS. `input` is the parsed request body on the member-facing
 * save routes, and this lifts the fully-past edit lock, so it is a service
 * argument instead. It runs only inside the executor's approval transaction
 * (which claims the request in the same commit, so it needs `tx` and the
 * pre-transaction reads, `INV-LOCK-004`), only for an officer, and never with
 * the date-only `adminOverride`, whose conservative Xero guard has no
 * pre-resolved form.
 */
export function assertFinishedStayCorrectionCall(call: {
  readonly hasCallerTransaction: boolean;
  readonly actorRole: string;
  readonly adminOverride: boolean;
}): void {
  if (!call.hasCallerTransaction) {
    throw new Error(
      "#3750: a finished-stay correction runs only inside the approval " +
        "transaction that claims its change request (`tx` and `preTransaction`).",
    );
  }
  if (call.actorRole !== "ADMIN") {
    throw new ApiError("Finished-stay corrections are applied by an officer", 403);
  }
  if (call.adminOverride) {
    throw new Error("#3750: a finished-stay correction is not a date-only admin override.");
  }
}

/**
 * Which half of the owner's fee rule an executed correction fell under. Stored
 * on the modification row and the audit row, so a treasurer reconciling change
 * fees can tell "no fee because the officer only added guests" from "a same-day
 * tier that happened to come to nothing".
 */
export type FinishedStayChangeFeeRule =
  | "ADD_ONLY_NO_FEE"
  | "SAME_DAY_NOTICE"
  | "SWAP_SAME_DAY_NOTICE";

/** A guest the correction keeps, before and after. */
export interface FinishedStayRemainingGuest {
  readonly stored: {
    readonly stayStart: Date;
    readonly stayEnd: Date;
    readonly nights?: ReadonlyArray<{ readonly stayDate: Date }>;
  };
  readonly proposed: {
    readonly stayStart: Date;
    readonly stayEnd: Date;
    readonly nights?: ReadonlyArray<Date>;
  };
}

function nightKeys(
  stayStart: Date,
  stayEnd: Date,
  nights: ReadonlyArray<Date> | undefined,
): string[] {
  const day = (value: Date) => calendarDateOfDateOnlyInstant(storedDateOnly(value));
  if (nights && nights.length > 0) return nights.map(day).sort();
  return eachCalendarDate(day(stayStart), day(stayEnd));
}

/**
 * The owner's rule, decided from what the correction WILL WRITE rather than from
 * which fields the request happened to carry.
 *
 * That distinction is not pedantry: the member's change-request form sends the
 * same payload as the edit panel, and the edit panel sends `guestStayRanges` for
 * every guest in grid and range modes whether or not their nights moved. A rule
 * keyed on "the request mentions stay ranges" would charge a same-day fee on a
 * request that only added a guest. So: add-only means at least one guest is
 * added, nobody is removed, and every guest already on the booking keeps exactly
 * the nights they had.
 *
 * A swap — a removal with an add — is `SWAP_SAME_DAY_NOTICE`, and anything
 * else — a removal, a trimmed stay, a stay-range or date change — is
 * `SAME_DAY_NOTICE`. Both are charged the same way: the same-day tier's
 * retention on everything the correction removes
 * ({@link finishedStayRemovalFeeCents} over {@link finishedStayRemovedPortion}),
 * never netted against guests or nights added in its place (owner, 6 Oct 2026:
 * "charged fairly"). The label only records which shape it was.
 */
export function classifyFinishedStayChangeFeeRule(plan: {
  readonly addedGuestCount: number;
  readonly removedGuestCount: number;
  readonly remainingGuests: ReadonlyArray<FinishedStayRemainingGuest>;
}): FinishedStayChangeFeeRule {
  if (plan.removedGuestCount > 0) {
    return plan.addedGuestCount > 0 ? "SWAP_SAME_DAY_NOTICE" : "SAME_DAY_NOTICE";
  }
  if (plan.addedGuestCount === 0) return "SAME_DAY_NOTICE";
  const everyKeptGuestUnchanged = plan.remainingGuests.every(({ stored, proposed }) => {
    const before = nightKeys(
      stored.stayStart,
      stored.stayEnd,
      stored.nights?.map((night) => night.stayDate),
    );
    const after = nightKeys(proposed.stayStart, proposed.stayEnd, proposed.nights);
    return before.length === after.length && before.every((key, i) => key === after[i]);
  });
  return everyKeptGuestUnchanged ? "ADD_ONLY_NO_FEE" : "SAME_DAY_NOTICE";
}

/**
 * What the correction takes OFF the stay: every night a guest no longer holds —
 * all of a removed guest's nights, and the nights a kept guest's trimmed or
 * re-ranged stay drops (reviews F3/F4 on #3955) — valued at what was actually
 * charged for them, net of the promotion they received (F5).
 *
 * A stored night's `priceCents` is its sold price before promotions; the
 * promotion is recorded per night (or per guest) in `BookingGuestNightAdjustment`
 * (#3276). Where those rows are complete — every amount known and their sum the
 * booking's recorded `promoAdjustmentCents` — a removed night carries its own
 * adjustment and a removed guest their guest-scope ones (a trimmed guest's
 * guest-scope adjustment in proportion to the nights dropped). Where they are
 * not, the booking's promotion is shared over the removed portion in proportion
 * to its price, which is the most any record supports.
 *
 * A removed night whose sold price is NOT KNOWN (`null`, #3170) cannot be
 * valued, and the correction is refused rather than priced on a guess.
 */
export interface StoredGuestForRemoval {
  readonly id: string;
  readonly priceCents: number;
  readonly stayStart: Date;
  readonly stayEnd: Date;
  readonly nights?: ReadonlyArray<{ readonly stayDate: Date; readonly priceCents?: number | null }>;
}

export interface ProposedStay {
  readonly stayStart: Date;
  readonly stayEnd: Date;
  readonly nights?: ReadonlyArray<Date>;
}

export interface RemovalPromoRows {
  /** Night-scope adjustment amounts (negative = discount), keyed `guestId|YYYY-MM-DD`. */
  readonly byNight: ReadonlyMap<string, number | null>;
  /** Guest-scope adjustment amounts, keyed by guest id. */
  readonly byGuest: ReadonlyMap<string, number | null>;
}

export const FINISHED_STAY_UNKNOWN_NIGHT_PRICE_MESSAGE =
  "A night this change removes has no recorded price, so the same-day charge on it cannot be worked out. Nothing has been applied; the request is still pending.";

/**
 * Owner decision (7 Oct 2026, "Add fee to amount owed"): a correction's fee on a
 * stay with nothing captured is recorded on the booking's payment, so every pay
 * step — the payment page, the card intent, the internet-banking ask and the
 * officer's manual settlement — collects it with the rest through
 * `bookingAmountOwedCents`. The modification row says so, and whether the fee
 * still needs a line on the primary Xero invoice (none had been issued, so no
 * credit note or supplementary invoice carried it).
 */
export type FeeAddedToAmountOwed = {
  readonly modificationId: string;
  readonly changeFeeCents: number;
  readonly onPrimaryInvoice: boolean;
};

const FEE_ADDED_TO_AMOUNT_OWED_PATH = ["finishedStayCorrection", "feeAddedToAmountOwed"];

/** The fees a finished-stay correction added to this booking's amount owed. */
export async function loadFeesAddedToAmountOwed(
  db: PrismaTransactionClient,
  bookingId: string,
): Promise<FeeAddedToAmountOwed[]> {
  const rows = await db.bookingModification.findMany({
    where: {
      bookingId,
      changeFeeCents: { gt: 0 },
      newData: { path: FEE_ADDED_TO_AMOUNT_OWED_PATH, equals: true },
    },
    select: { id: true, changeFeeCents: true, newData: true },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((row) => {
    const correction = (row.newData as { finishedStayCorrection?: { feeOnPrimaryInvoice?: unknown } })
      .finishedStayCorrection;
    return {
      modificationId: row.id,
      changeFeeCents: row.changeFeeCents,
      onPrimaryInvoice: correction?.feeOnPrimaryInvoice === true,
    };
  });
}

export function finishedStayRemovedPortion(args: {
  readonly storedGuests: ReadonlyArray<StoredGuestForRemoval>;
  /** The proposed stay of every guest the correction KEEPS; a guest absent here is removed. */
  readonly keptStays: ReadonlyMap<string, ProposedStay>;
  readonly booking: { readonly totalPriceCents: number; readonly promoAdjustmentCents: number };
  readonly promoRows: RemovalPromoRows;
}): { grossCents: number; netCents: number } {
  const { booking, promoRows } = args;
  let gross = 0;
  let rowPromo = 0;
  const day = (value: Date) => calendarDateOfDateOnlyInstant(storedDateOnly(value));
  for (const guest of args.storedGuests) {
    const kept = args.keptStays.get(guest.id);
    const storedKeys = nightKeys(
      guest.stayStart,
      guest.stayEnd,
      guest.nights?.map((night) => night.stayDate),
    );
    if (storedKeys.length === 0) continue;
    const keptKeys = kept ? new Set(nightKeys(kept.stayStart, kept.stayEnd, kept.nights)) : new Set<string>();
    const removedKeys = storedKeys.filter((key) => !keptKeys.has(key));
    if (removedKeys.length === 0) continue;
    if (guest.nights && guest.nights.length > 0) {
      for (const night of guest.nights) {
        const key = day(night.stayDate);
        if (!removedKeys.includes(key)) continue;
        if (night.priceCents === null || night.priceCents === undefined) {
          throw new ApiError(FINISHED_STAY_UNKNOWN_NIGHT_PRICE_MESSAGE, 409);
        }
        gross += night.priceCents;
        rowPromo += promoRows.byNight.get(`${guest.id}|${key}`) ?? 0;
      }
    } else {
      // A pre-#713 guest with no night rows: their stored price over their nights.
      gross += Math.round((guest.priceCents * removedKeys.length) / storedKeys.length);
    }
    const guestScope = promoRows.byGuest.get(guest.id);
    if (typeof guestScope === "number") {
      rowPromo += Math.round((guestScope * removedKeys.length) / storedKeys.length);
    }
  }
  if (gross === 0) return { grossCents: 0, netCents: 0 };
  if (booking.promoAdjustmentCents === 0) return { grossCents: gross, netCents: gross };
  const amounts = [...promoRows.byNight.values(), ...promoRows.byGuest.values()];
  const rowsKnown =
    amounts.length > 0 &&
    amounts.every((amount) => amount !== null) &&
    amounts.reduce<number>((sum, amount) => sum + (amount as number), 0) ===
      booking.promoAdjustmentCents;
  const promoShare = rowsKnown
    ? rowPromo
    : booking.totalPriceCents > 0
      ? Math.round((gross * booking.promoAdjustmentCents) / booking.totalPriceCents)
      : 0;
  return { grossCents: gross, netCents: Math.max(0, gross + promoShare) };
}

/** Read the promotion rows `finishedStayRemovedPortion` values removed nights with (#3276). */
export async function loadRemovalPromoRows(
  db: PrismaTransactionClient,
  bookingId: string,
): Promise<RemovalPromoRows> {
  const rows = await db.bookingGuestNightAdjustment.findMany({
    where: { bookingId },
    select: { bookingGuestId: true, bookingGuestNightId: true, amountCents: true },
  });
  // A night-scope row names its night by id; resolve those to (guest, day) with
  // a direct read rather than through the relation (`INV-MONEY-028`'s census).
  const nightIds = rows.flatMap((row) => (row.bookingGuestNightId ? [row.bookingGuestNightId] : []));
  const nights = nightIds.length
    ? await db.bookingGuestNight.findMany({
        where: { id: { in: nightIds } },
        select: { id: true, bookingGuestId: true, stayDate: true },
      })
    : [];
  const nightKeyById = new Map(
    nights.map((night) => [
      night.id,
      `${night.bookingGuestId}|${calendarDateOfDateOnlyInstant(storedDateOnly(night.stayDate))}`,
    ]),
  );
  const byNight = new Map<string, number | null>();
  const byGuest = new Map<string, number | null>();
  const add = (map: Map<string, number | null>, key: string, amount: number | null) => {
    const prior = map.get(key);
    map.set(key, prior === undefined ? amount : prior === null || amount === null ? null : prior + amount);
  };
  for (const row of rows) {
    const nightKey = row.bookingGuestNightId ? nightKeyById.get(row.bookingGuestNightId) : undefined;
    if (nightKey) add(byNight, nightKey, row.amountCents);
    else if (row.bookingGuestId) add(byGuest, row.bookingGuestId, row.amountCents);
  }
  return { byNight, byGuest };
}

/**
 * The change fee a correction owes for what it removes: what the club's
 * same-day (0-day) tier would KEEP of the removed portion — the portion less
 * the tier's refund for the chosen method (percentage and fixed fee, card or
 * credit), exactly `calculateDualRefundAmounts`' rule for a same-day removal.
 * Charged as the edit's change fee, for a paid and an unpaid stay alike (owner,
 * 7 Oct 2026: "as if they had paid and then were being refunded less the
 * cancellation fee"); the batch service then returns whatever reduction remains
 * in full, so the tier is applied once, to the removed portion, and never
 * netted against guests added in its place.
 */
export function finishedStayRemovalFeeCents(args: {
  readonly removedPortionCents: number;
  readonly policyRules: CancellationRule[];
  readonly settlementMethod: "card" | "credit";
}): number {
  const portion = Math.max(0, args.removedPortionCents);
  const refunds = calculateDualRefundAmounts(portion, 0, args.policyRules);
  const refunded =
    args.settlementMethod === "credit"
      ? refunds.creditRefundAmountCents
      : refunds.cardRefundAmountCents;
  return Math.max(0, portion - Math.min(portion, refunded));
}

/**
 * Where a correction's reduction goes when the officer did not choose: back the
 * way the booking was paid (P2 on #3955). A booking paid wholly with account
 * credit gets credit back; anything paid in money goes back the way it came
 * (card refund, or the internet-banking hand-back).
 */
export function defaultCorrectionSettlementMethod(
  payment: { readonly amountCents: number; readonly creditAppliedCents: number } | null,
): "card" | "credit" {
  return payment && payment.amountCents <= 0 && payment.creditAppliedCents > 0 ? "credit" : "card";
}

/**
 * The day a finished-stay correction's fees and refund tiers are measured from:
 * the stay's own check-in, so the notice period is exactly 0 days. Passed where
 * the ordinary edit passes the club's today, and only to the three money tiers —
 * the edit policy, the promotion window and every date gate still read the real
 * today.
 */
export function finishedStayNoticeDay(booking: { readonly checkIn: Date }): CalendarDate {
  return calendarDateOfDateOnlyInstant(storedDateOnly(booking.checkIn));
}
