import type { Prisma } from "@prisma/client";

import {
  addCalendarDays,
  calendarDateOfDateOnlyInstant,
  dateOnlyInstantOf,
} from "@/lib/club-time";
import logger from "@/lib/logger";

/**
 * #3276 (stage 2 of programme #3272): THE ONE WRITER OF AN AMOUNT into
 * `BookingGuestNightAdjustment` — a member merge (`member-merge.ts`) moves or
 * deletes rows and never invents one — and the one home of the rule a reader
 * uses to decide whether a booking's recorded build-up can be trusted
 * (`deriveNightAdjustmentState`). `booking-guest-night-adjustment-census.test.ts`
 * holds both.
 *
 * The rule itself — the grain a row attaches at, the signed integer-cent amount
 * with NULL meaning not known, the reconciliation to the recorded promo totals,
 * and derived (never stored) validity — is stated once, as `INV-MONEY-029` in
 * `docs/invariants/money.md`. This file implements it and does not restate it.
 *
 * ## Refuse before mutate
 *
 * `recordBookingNightAdjustments` resolves every target, reads the stored
 * redemption and allocations, reconciles, and resolves every night row BEFORE
 * its first write. Every refusal therefore leaves the transaction exactly as it
 * found it; the only failures that can follow the first write are database
 * errors, which abort the transaction themselves. The waitlist reprice relies on
 * this: it degrades to the stored snapshot instead of rolling back, so it calls
 * the recorder OUTSIDE that degrade path, where a refusal fails the sweep like
 * any other post-mutation error.
 *
 * ## Mechanical rewrites
 *
 * Every night writer delete-and-recreates its rows, which cascades the
 * adjustment rows attached to them. Where the pricing engine re-runs, the rows
 * are rewritten from its output. Where it does not and no money moves — a
 * name-only correction, an in-progress extension, an admin date shift —
 * `snapshotBookingNightAdjustments` before the rewrite and
 * `restoreBookingNightAdjustments` after it carry the rows across by (guest,
 * stay date), byte for byte. Preservation, not derivation: no amount is
 * computed. Where a row's night no longer exists the carry is abandoned and
 * the booking's rows are left absent, which a reader derives as not known.
 *
 * ## Ordering
 *
 * Call `recordBookingNightAdjustments` AFTER THE LAST NIGHT WRITE of the
 * transaction and after the redemption/allocation write. The batch path and the
 * waitlist reprice write their promotion before they rewrite nights, so the rows
 * cannot be attached earlier than that. One `createMany` per transaction.
 */
export const NIGHT_ADJUSTMENT_INVARIANT = "INV-MONEY-029";

/**
 * One adjustment the engine decided, resolved by `promo.ts` to the position of
 * the guest in the caller's own guest list. `stayDate` is the night's calendar
 * day for a night-scope target; a night-scope target without one is a wiring
 * defect the writer refuses (a caller that priced without dates).
 */
export type PromoAdjustmentTarget = {
  guestIndex: number;
  scope: "night" | "guest";
  stayDate: Date | null;
  beneficiaryMemberId: string;
  amountCents: number | null;
};

type Tx = Prisma.TransactionClient;

function refuse(message: string): never {
  throw new Error(`${NIGHT_ADJUSTMENT_INVARIANT}: ${message}`);
}

/**
 * A night is matched by GUEST and CALENDAR DAY. `stayDate` is a `@db.Date`
 * value — a calendar day encoded at UTC midnight — so it is decoded through the
 * club-time kernel (INV-CONFIG-002, INV-DATE-019), never projected through a
 * zone and never formatted by hand.
 */
function nightKey(bookingGuestId: string, stayDate: Date): string {
  return `${bookingGuestId}|${calendarDateOfDateOnlyInstant(stayDate)}`;
}

/**
 * The pure half of the guard: do these rows reconcile to these recorded promo
 * totals? Per beneficiary to that member's allocation (an absent allocation row
 * means the member received nothing — `normalizeAllocations` drops a
 * zero-benefit entry at write time, INV-MONEY-005 — so the recorded total for
 * that member IS zero; this is the meaning of an absent row, not a default over
 * a missing amount), and overall to the redemption. A beneficiary with any NOT
 * KNOWN row is excluded from both sums, and only from those.
 */
export function reconcilePromoAdjustmentTargets(params: {
  targets: ReadonlyArray<{ beneficiaryMemberId: string; amountCents: number | null }>;
  allocations: ReadonlyArray<{ memberId: string; priceAdjustmentCents: number }>;
  priceAdjustmentCents: number;
  context: string;
}): void {
  const mismatch = findReconciliationMismatch(params);
  if (mismatch) refuse(`${params.context}: ${mismatch}`);
}

function findReconciliationMismatch(params: {
  targets: ReadonlyArray<{ beneficiaryMemberId: string; amountCents: number | null }>;
  allocations: ReadonlyArray<{ memberId: string; priceAdjustmentCents: number }>;
  priceAdjustmentCents: number;
}): string | null {
  const { targets, allocations, priceAdjustmentCents } = params;
  const sums = new Map<string, number>();
  const unknown = new Set<string>();
  for (const target of targets) {
    if (target.amountCents === null) {
      unknown.add(target.beneficiaryMemberId);
      continue;
    }
    if (!Number.isInteger(target.amountCents)) {
      return `an adjustment amount is not integer cents (${target.amountCents})`;
    }
    sums.set(
      target.beneficiaryMemberId,
      (sums.get(target.beneficiaryMemberId) ?? 0) + target.amountCents,
    );
  }
  const allocationByMember = new Map(
    allocations.map((allocation) => [allocation.memberId, allocation.priceAdjustmentCents]),
  );
  const members = new Set([...sums.keys(), ...unknown, ...allocationByMember.keys()]);
  for (const memberId of members) {
    if (unknown.has(memberId)) continue;
    const recorded = allocationByMember.has(memberId) ? allocationByMember.get(memberId)! : 0;
    const summed = sums.get(memberId) ?? 0;
    if (summed !== recorded) {
      return `adjustment rows for member ${memberId} sum to ${summed} cents but the recorded allocation is ${recorded} cents`;
    }
  }
  if (unknown.size === 0) {
    const total = [...sums.values()].reduce((sum, cents) => sum + cents, 0);
    if (total !== priceAdjustmentCents) {
      return `adjustment rows sum to ${total} cents but the recorded redemption adjustment is ${priceAdjustmentCents} cents`;
    }
  }
  return null;
}

/**
 * Whether a booking's recorded build-up can be trusted — DERIVED from its rows
 * every time it is asked, never stored (owner decision, 10 Sep 2026): a flag
 * could be left asserting a state that a draining colour or a rollback had since
 * made false, and a sum cannot.
 *
 * - `NO_PROMOTION`: the booking carries no redemption, so nothing was taken off
 *   any of its nights. Rows without a redemption cannot exist (the FK cascades).
 * - `KNOWN`: the rows reconcile to the recorded totals — the INV-MONEY-029
 *   identity the writer enforced, re-run by the reader.
 * - `NOT_KNOWN`: anything else — rows missing, rows that do not sum (a parked
 *   removal that deleted a guest without re-running the promotion, an
 *   old-colour promotion edit), or a NOT KNOWN amount somewhere in them.
 *
 * Stage 3 calls this and nothing else; it is the one home.
 */
export type NightAdjustmentState = "KNOWN" | "NOT_KNOWN" | "NO_PROMOTION";

export function deriveNightAdjustmentState(params: {
  rows: ReadonlyArray<{ beneficiaryMemberId: string; amountCents: number | null }>;
  redemption: {
    priceAdjustmentCents: number;
    allocations: ReadonlyArray<{ memberId: string; priceAdjustmentCents: number }>;
  } | null;
}): NightAdjustmentState {
  const { rows, redemption } = params;
  if (redemption === null) return "NO_PROMOTION";
  if (rows.some((row) => row.amountCents === null)) return "NOT_KNOWN";
  return findReconciliationMismatch({
    targets: rows,
    allocations: redemption.allocations,
    priceAdjustmentCents: redemption.priceAdjustmentCents,
  }) === null
    ? "KNOWN"
    : "NOT_KNOWN";
}

type ResolvedTarget = {
  scope: "night" | "guest";
  bookingGuestId: string;
  stayDate: Date | null;
  beneficiaryMemberId: string;
  amountCents: number | null;
};

/** Exactly one target each, and a night-scope target always dated. */
function resolveTargets(
  targets: ReadonlyArray<PromoAdjustmentTarget>,
  guestIds: ReadonlyArray<string | null | undefined>,
  context: string,
): ResolvedTarget[] {
  return targets.map((target) => {
    const bookingGuestId = guestIds[target.guestIndex];
    if (!bookingGuestId) {
      refuse(`${context}: a target names guest #${target.guestIndex}, which has no booking guest id`);
    }
    if (target.scope === "night" && !target.stayDate) {
      refuse(`${context}: a night-scope target for guest #${target.guestIndex} carries no stay date`);
    }
    if (target.scope === "guest" && target.stayDate) {
      refuse(`${context}: a guest-scope target for guest #${target.guestIndex} carries a stay date`);
    }
    return {
      scope: target.scope,
      bookingGuestId,
      stayDate: target.scope === "night" ? target.stayDate : null,
      beneficiaryMemberId: target.beneficiaryMemberId,
      amountCents: target.amountCents,
    };
  });
}

/**
 * Record what the promotion the engine just ran took off each night and guest
 * of `bookingId`.
 *
 * `guestIds` is the caller's guest list in the order the engine saw it, with the
 * `BookingGuest.id` of each (created guests included — this runs after they
 * exist). `targets` is `application.discount.adjustmentTargets`, or `[]` when
 * the booking carries no promotion. The redemption and its allocations are read
 * from the database, not trusted from the caller, because the invariant is about
 * what is RECORDED. Nothing is written until every refusal has had its chance.
 *
 * A guest that holds NO night rows at all (a pre-#713 strand priced from its
 * stay envelope) cannot carry night-scope rows: those targets are dropped with a
 * warning rather than refused, so an edit that succeeds today keeps succeeding,
 * and the booking's build-up derives as not known — which it is. A date missing
 * from a guest that DOES hold night rows is still a wiring defect and refuses.
 */
export async function recordBookingNightAdjustments(
  tx: Tx,
  params: {
    bookingId: string;
    guestIds: ReadonlyArray<string | null | undefined>;
    targets: ReadonlyArray<PromoAdjustmentTarget>;
    writer: string;
  },
): Promise<void> {
  const { bookingId, guestIds, targets, writer } = params;
  const engineGuestIds = guestIds.filter((id): id is string => Boolean(id));
  if (engineGuestIds.length !== guestIds.length) {
    refuse(`${writer}: a guest the engine priced has no booking guest id`);
  }
  const resolved = resolveTargets(targets, guestIds, writer);

  const redemption = await tx.promoRedemption.findUnique({
    where: { bookingId },
    select: {
      id: true,
      promoCodeId: true,
      priceAdjustmentCents: true,
      allocations: { select: { memberId: true, priceAdjustmentCents: true } },
    },
  });
  if (!redemption && resolved.length > 0) {
    refuse(`${writer}: the engine attributed a promotion but the booking has no stored redemption`);
  }

  let rows: Prisma.BookingGuestNightAdjustmentCreateManyInput[] = [];
  if (redemption) {
    reconcilePromoAdjustmentTargets({
      targets,
      allocations: redemption.allocations,
      priceAdjustmentCents: redemption.priceAdjustmentCents,
      context: writer,
    });

    const nights =
      engineGuestIds.length > 0
        ? await tx.bookingGuestNight.findMany({
            where: { bookingGuestId: { in: engineGuestIds } },
            select: { id: true, bookingGuestId: true, stayDate: true },
          })
        : [];
    const nightIdByKey = new Map(
      nights.map((night) => [nightKey(night.bookingGuestId, night.stayDate), night.id]),
    );
    const guestsHoldingNights = new Set(nights.map((night) => night.bookingGuestId));
    const guestsWithoutNights = new Set<string>();

    for (const target of resolved) {
      const base = {
        kind: "PROMO" as const,
        amountCents: target.amountCents,
        bookingId,
        promoRedemptionId: redemption.id,
        promoCodeId: redemption.promoCodeId,
        beneficiaryMemberId: target.beneficiaryMemberId,
      };
      if (target.scope === "guest") {
        rows.push({ ...base, bookingGuestNightId: null, bookingGuestId: target.bookingGuestId });
        continue;
      }
      if (!guestsHoldingNights.has(target.bookingGuestId)) {
        guestsWithoutNights.add(target.bookingGuestId);
        continue;
      }
      const bookingGuestNightId = nightIdByKey.get(nightKey(target.bookingGuestId, target.stayDate!));
      if (!bookingGuestNightId) {
        refuse(
          `${writer}: the engine attributed the night of ${calendarDateOfDateOnlyInstant(target.stayDate!)} for guest ${target.bookingGuestId}, but that guest holds no such night row`,
        );
      }
      rows.push({ ...base, bookingGuestNightId, bookingGuestId: null });
    }
    if (guestsWithoutNights.size > 0) {
      logger.warn(
        { bookingId, writer, guestIds: [...guestsWithoutNights] },
        `${NIGHT_ADJUSTMENT_INVARIANT}: a guest holds no night rows, so the promotion's per-night rows for that guest are not recorded; the booking's build-up derives as not known`,
      );
    }
  } else {
    rows = [];
  }

  // Every refusal above has had its chance. From here only the database can
  // fail, and a database error aborts the transaction itself.
  await tx.bookingGuestNightAdjustment.deleteMany({ where: { bookingId } });
  if (rows.length > 0) {
    await tx.bookingGuestNightAdjustment.createMany({ data: rows });
  }
}

/**
 * What a booking's nights currently record, captured BEFORE a mechanical
 * rewrite deletes the night rows (and, through the cascade, the adjustment rows
 * attached to them).
 */
export type CarriedNightAdjustments = {
  bookingId: string;
  rows: Array<{
    kind: "PROMO";
    amountCents: number | null;
    promoRedemptionId: string;
    promoCodeId: string;
    beneficiaryMemberId: string;
    bookingGuestId: string;
    /** `null` for a guest-scope row. */
    stayDate: Date | null;
  }>;
};

export async function snapshotBookingNightAdjustments(
  tx: Tx,
  bookingId: string,
): Promise<CarriedNightAdjustments> {
  // Night-scope rows are read THROUGH their nights and guest-scope rows on
  // their own, so this module never touches a night delegate it is not
  // writing (the INV-MONEY-028 census counts every `.bookingGuestNight`
  // access that is not a direct write as an alias to be refused).
  const [nights, guestRows] = await Promise.all([
    tx.bookingGuestNight.findMany({
      where: { bookingGuest: { bookingId }, adjustments: { some: {} } },
      select: {
        bookingGuestId: true,
        stayDate: true,
        adjustments: {
          select: {
            kind: true,
            amountCents: true,
            promoRedemptionId: true,
            promoCodeId: true,
            beneficiaryMemberId: true,
          },
        },
      },
    }),
    tx.bookingGuestNightAdjustment.findMany({
      where: { bookingId, bookingGuestNightId: null },
      select: {
        kind: true,
        amountCents: true,
        promoRedemptionId: true,
        promoCodeId: true,
        beneficiaryMemberId: true,
        bookingGuestId: true,
      },
    }),
  ]);
  const rows: CarriedNightAdjustments["rows"] = [];
  for (const night of nights) {
    for (const row of night.adjustments) {
      rows.push({ ...row, bookingGuestId: night.bookingGuestId, stayDate: night.stayDate });
    }
  }
  for (const row of guestRows) {
    if (!row.bookingGuestId) {
      refuse(`booking ${bookingId} holds an adjustment row attached to neither a night nor a guest`);
    }
    rows.push({ ...row, bookingGuestId: row.bookingGuestId, stayDate: null });
  }
  return { bookingId, rows };
}

/**
 * Re-attach a snapshot to the rewritten night rows by (guest, stay date),
 * shifted by `shiftDays` where the rewrite moved every night by the same delta
 * (the admin date shift). Amounts are copied byte for byte; nothing is computed.
 *
 * If a recorded row's night no longer exists after the rewrite, the build-up
 * can no longer be stated coherently: NO rows are restored (a reader then
 * derives not known) and the edit is not refused over bookkeeping. Returns
 * whether the carry-forward held. Every lookup precedes the first write.
 */
export async function restoreBookingNightAdjustments(
  tx: Tx,
  params: { snapshot: CarriedNightAdjustments; shiftDays?: number; writer: string },
): Promise<{ carried: boolean }> {
  const { snapshot, writer } = params;
  const shiftDays = params.shiftDays ?? 0;
  if (snapshot.rows.length === 0) return { carried: true };
  // Whole calendar days through the kernel: decode the stored day, add, re-encode.
  const shifted = (stayDate: Date) =>
    shiftDays === 0
      ? stayDate
      : dateOnlyInstantOf(addCalendarDays(calendarDateOfDateOnlyInstant(stayDate), shiftDays));

  const [nights, guests] = await Promise.all([
    tx.bookingGuestNight.findMany({
      where: { bookingGuest: { bookingId: snapshot.bookingId } },
      select: { id: true, bookingGuestId: true, stayDate: true },
    }),
    tx.bookingGuest.findMany({
      where: { bookingId: snapshot.bookingId },
      select: { id: true },
    }),
  ]);
  const nightIdByKey = new Map(
    nights.map((night) => [nightKey(night.bookingGuestId, night.stayDate), night.id]),
  );
  const guestIds = new Set(guests.map((guest) => guest.id));

  const rows: Prisma.BookingGuestNightAdjustmentCreateManyInput[] = [];
  for (const row of snapshot.rows) {
    const base = {
      kind: row.kind,
      amountCents: row.amountCents,
      bookingId: snapshot.bookingId,
      promoRedemptionId: row.promoRedemptionId,
      promoCodeId: row.promoCodeId,
      beneficiaryMemberId: row.beneficiaryMemberId,
    };
    if (row.stayDate === null) {
      if (!guestIds.has(row.bookingGuestId)) {
        return abandonCarry(writer, snapshot.bookingId, `guest ${row.bookingGuestId} is gone`);
      }
      rows.push({ ...base, bookingGuestNightId: null, bookingGuestId: row.bookingGuestId });
      continue;
    }
    const target = shifted(row.stayDate);
    const bookingGuestNightId = nightIdByKey.get(nightKey(row.bookingGuestId, target));
    if (!bookingGuestNightId) {
      return abandonCarry(
        writer,
        snapshot.bookingId,
        `guest ${row.bookingGuestId} no longer holds the night of ${calendarDateOfDateOnlyInstant(target)}`,
      );
    }
    rows.push({ ...base, bookingGuestNightId, bookingGuestId: null });
  }

  // The rewrite cascaded most of these away already; a guest whose night rows
  // were left alone still holds its rows, so clear and re-insert uniformly.
  await tx.bookingGuestNightAdjustment.deleteMany({
    where: { bookingId: snapshot.bookingId },
  });
  await tx.bookingGuestNightAdjustment.createMany({ data: rows });
  return { carried: true };
}

function abandonCarry(writer: string, bookingId: string, reason: string): { carried: false } {
  logger.warn(
    { bookingId, writer, reason },
    `${NIGHT_ADJUSTMENT_INVARIANT}: the recorded promotion build-up could not be carried across this rewrite; the booking's build-up derives as not known`,
  );
  return { carried: false };
}
