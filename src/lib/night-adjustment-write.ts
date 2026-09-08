import type { Prisma } from "@prisma/client";

import { addDaysDateOnly, formatDateOnly } from "@/lib/date-only";
import logger from "@/lib/logger";

/**
 * #3276 (stage 2 of programme #3272): THE ONE WRITER of a night's adjustment
 * build-up — `BookingGuestNightAdjustment` rows and
 * `BookingGuestNight.adjustmentsState`. Nothing else in `src/` may write either;
 * `booking-guest-night-adjustment-census.test.ts` is the census that holds it.
 *
 * ## What is recorded
 *
 * One row per adjustment per target, at the grain the pricing engine decided
 * it (D1 on #3272, refined 8 Sep 2026): a NIGHT for a percentage, free-night or
 * fixed-nightly promotion, whose arithmetic is per night; the GUEST for a
 * fixed-amount promotion, which is `min(value, guest total)` with no per-night
 * rule. The amount is the engine's own figure — never translated to a finer
 * grain by a rule that would have to be invented — and it is a signed delta in
 * integer cents like `priceAdjustmentCents`. `0` is a real value. `null` means
 * NOT KNOWN, and is written only where the engine genuinely has no per-target
 * figure (the per-member safety-cap rescale); `?? 0` on it is prohibited.
 *
 * Account credit is NOT here. It has one home already — the `MemberCredit`
 * ledger entry with its booking link — and there is no per-night rule for it.
 *
 * ## The invariant, and where it is enforced
 *
 * `INV-MONEY-029`: the rows of one redemption sum, per beneficiary, to that
 * member's `PromoRedemptionAllocation.priceAdjustmentCents` (an absent
 * allocation row means the member received nothing, which is what
 * `normalizeAllocations` dropping a zero-benefit entry means) and, overall, to
 * `PromoRedemption.priceAdjustmentCents`. `recordBookingNightAdjustments`
 * reads those STORED figures inside the writer's own transaction and refuses
 * before writing a single row when they do not reconcile — so a mismatch rolls
 * the whole edit back rather than recording a build-up that lies. Rows whose
 * amount is NOT KNOWN are excluded from the sums they would make meaningless,
 * and only from those.
 *
 * ## `adjustmentsState`
 *
 * Every night writer leaves the column at its default, UNKNOWN — exactly what
 * a colour compiled before the column existed writes. This module flips a
 * night to RECORDED only AFTER its rows are in place in the same transaction,
 * so a failure anywhere between leaves the night honestly UNKNOWN, and RECORDED
 * with zero rows means "nothing was taken off this night". Three writer classes
 * never reach RECORDED and are meant not to: a night an officer priced, a night
 * that is a mechanical even split of a total, and a night a PARKED edit wrote
 * while its money waits for a person.
 *
 * ## Mechanical rewrites
 *
 * A night row is delete-and-recreated by every night writer, which cascades its
 * adjustment rows away. Where the pricing engine re-runs, the rows are simply
 * rewritten from its output. Where it does NOT run and no money moves — a
 * name-only correction, an in-progress extension, an admin date shift —
 * `snapshotBookingNightAdjustments` before the rewrite and
 * `restoreBookingNightAdjustments` after it carry the recorded rows across by
 * (guest, stay date), byte for byte, exactly as those paths already echo the
 * stored price. That is preservation, not derivation: no amount is computed.
 *
 * ## Ordering
 *
 * Call `recordBookingNightAdjustments` AFTER THE LAST NIGHT WRITE of the
 * transaction, and after the redemption/allocation write. The batch path and the
 * waitlist reprice write their promotion BEFORE they rewrite nights, so the
 * rows cannot be attached earlier than that. One `createMany` per transaction,
 * inside Prisma's interactive-transaction budget.
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

function nightKey(bookingGuestId: string, stayDate: Date): string {
  return `${bookingGuestId}|${formatDateOnly(stayDate)}`;
}

/**
 * The pure half of the guard: do these targets reconcile to these recorded
 * promo totals? Exported so a writer that cannot roll back (the waitlist
 * reprice degrades to the stored snapshot instead) can ask BEFORE its first
 * write, and so the guard can be mutation-tested without a database.
 */
export function reconcilePromoAdjustmentTargets(params: {
  targets: ReadonlyArray<PromoAdjustmentTarget>;
  allocations: ReadonlyArray<{ memberId: string; priceAdjustmentCents: number }>;
  priceAdjustmentCents: number;
  context: string;
}): void {
  const { targets, allocations, priceAdjustmentCents, context } = params;
  const sums = new Map<string, number>();
  const unknown = new Set<string>();
  for (const target of targets) {
    if (target.amountCents === null) {
      unknown.add(target.beneficiaryMemberId);
      continue;
    }
    if (!Number.isInteger(target.amountCents)) {
      refuse(`${context}: an adjustment amount is not integer cents (${target.amountCents})`);
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
    // No allocation row means the member received nothing: `normalizeAllocations`
    // drops a zero-benefit entry at write time (INV-MONEY-005), so the recorded
    // total for that member IS zero. This is the meaning of an absent row, not a
    // default over a missing amount.
    const recorded = allocationByMember.has(memberId)
      ? allocationByMember.get(memberId)!
      : 0;
    const summed = sums.get(memberId) ?? 0;
    if (summed !== recorded) {
      refuse(
        `${context}: adjustment rows for member ${memberId} sum to ${summed} cents but the recorded allocation is ${recorded} cents`,
      );
    }
  }
  if (unknown.size === 0) {
    const total = [...sums.values()].reduce((sum, cents) => sum + cents, 0);
    if (total !== priceAdjustmentCents) {
      refuse(
        `${context}: adjustment rows sum to ${total} cents but the recorded redemption adjustment is ${priceAdjustmentCents} cents`,
      );
    }
  }
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
 * of `bookingId`, and mark the nights of every guest the engine saw RECORDED.
 *
 * `guestIds` is the caller's guest list in the order the engine saw it, with the
 * `BookingGuest.id` of each (created guests included — this runs after they
 * exist). `targets` is `PromoApplicationResult.adjustmentTargets`, or `[]` when
 * the booking carries no promotion: RECORDED with no rows is then the true
 * statement that nothing was taken off. The redemption and its allocations are
 * read from the database, not trusted from the caller, because the invariant is
 * about what is RECORDED.
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

  // Delete-and-rewrite: the rows are a function of the engine's latest run.
  await tx.bookingGuestNightAdjustment.deleteMany({ where: { bookingId } });

  const redemption = await tx.promoRedemption.findUnique({
    where: { bookingId },
    select: {
      id: true,
      promoCodeId: true,
      priceAdjustmentCents: true,
      allocations: { select: { memberId: true, priceAdjustmentCents: true } },
    },
  });

  if (!redemption) {
    if (resolved.length > 0) {
      refuse(`${writer}: the engine attributed a promotion but the booking has no stored redemption`);
    }
  } else {
    reconcilePromoAdjustmentTargets({
      targets,
      allocations: redemption.allocations,
      priceAdjustmentCents: redemption.priceAdjustmentCents,
      context: writer,
    });

    const nights = await tx.bookingGuestNight.findMany({
      where: { bookingGuestId: { in: engineGuestIds } },
      select: { id: true, bookingGuestId: true, stayDate: true },
    });
    const nightIdByKey = new Map(
      nights.map((night) => [nightKey(night.bookingGuestId, night.stayDate), night.id]),
    );
    const rows = resolved.map((target) => {
      if (target.scope === "guest") {
        return {
          kind: "PROMO" as const,
          amountCents: target.amountCents,
          bookingGuestNightId: null,
          bookingGuestId: target.bookingGuestId,
          bookingId,
          promoRedemptionId: redemption.id,
          promoCodeId: redemption.promoCodeId,
          beneficiaryMemberId: target.beneficiaryMemberId,
        };
      }
      const bookingGuestNightId = nightIdByKey.get(
        nightKey(target.bookingGuestId, target.stayDate!),
      );
      if (!bookingGuestNightId) {
        refuse(
          `${writer}: the engine attributed the night of ${formatDateOnly(target.stayDate!)} for guest ${target.bookingGuestId}, but that guest holds no such night row`,
        );
      }
      return {
        kind: "PROMO" as const,
        amountCents: target.amountCents,
        bookingGuestNightId,
        bookingGuestId: null,
        bookingId,
        promoRedemptionId: redemption.id,
        promoCodeId: redemption.promoCodeId,
        beneficiaryMemberId: target.beneficiaryMemberId,
      };
    });
    if (rows.length > 0) {
      await tx.bookingGuestNightAdjustment.createMany({ data: rows });
    }
  }

  // Only now, with the rows in place: these nights' build-up is recorded.
  if (engineGuestIds.length > 0) {
    await tx.bookingGuestNight.updateMany({
      where: { bookingGuestId: { in: engineGuestIds } },
      data: { adjustmentsState: "RECORDED" },
    });
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
  recordedNights: Array<{ bookingGuestId: string; stayDate: Date }>;
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
      where: { bookingGuest: { bookingId } },
      select: {
        bookingGuestId: true,
        stayDate: true,
        adjustmentsState: true,
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
  return {
    bookingId,
    rows,
    recordedNights: nights
      .filter((night) => night.adjustmentsState === "RECORDED")
      .map((night) => ({ bookingGuestId: night.bookingGuestId, stayDate: night.stayDate })),
  };
}

/**
 * Re-attach a snapshot to the rewritten night rows by (guest, stay date),
 * shifted by `shiftDays` where the rewrite moved every night by the same delta
 * (the admin date shift). Amounts are copied byte for byte; nothing is computed.
 *
 * If a recorded row's night no longer exists after the rewrite, the build-up
 * can no longer be stated coherently: NO rows are restored and every night is
 * left UNKNOWN, which is the honest answer, and the edit is not refused over
 * bookkeeping. Returns whether the carry-forward held.
 */
export async function restoreBookingNightAdjustments(
  tx: Tx,
  params: { snapshot: CarriedNightAdjustments; shiftDays?: number; writer: string },
): Promise<{ carried: boolean }> {
  const { snapshot, writer } = params;
  const shiftDays = params.shiftDays ?? 0;
  if (snapshot.rows.length === 0 && snapshot.recordedNights.length === 0) {
    return { carried: true };
  }
  const shifted = (stayDate: Date) =>
    shiftDays === 0 ? stayDate : addDaysDateOnly(stayDate, shiftDays);

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

  // The rewrite cascaded most of these away already; a guest whose night rows
  // were left alone still holds its rows, so clear and re-insert uniformly.
  await tx.bookingGuestNightAdjustment.deleteMany({
    where: { bookingId: snapshot.bookingId },
  });

  const rows: Array<Prisma.BookingGuestNightAdjustmentCreateManyInput> = [];
  for (const row of snapshot.rows) {
    if (row.stayDate === null) {
      if (!guestIds.has(row.bookingGuestId)) {
        return abandonCarry(writer, snapshot.bookingId, `guest ${row.bookingGuestId} is gone`);
      }
      rows.push({
        kind: row.kind,
        amountCents: row.amountCents,
        bookingGuestNightId: null,
        bookingGuestId: row.bookingGuestId,
        bookingId: snapshot.bookingId,
        promoRedemptionId: row.promoRedemptionId,
        promoCodeId: row.promoCodeId,
        beneficiaryMemberId: row.beneficiaryMemberId,
      });
      continue;
    }
    const target = shifted(row.stayDate);
    const bookingGuestNightId = nightIdByKey.get(nightKey(row.bookingGuestId, target));
    if (!bookingGuestNightId) {
      return abandonCarry(
        writer,
        snapshot.bookingId,
        `guest ${row.bookingGuestId} no longer holds the night of ${formatDateOnly(target)}`,
      );
    }
    rows.push({
      kind: row.kind,
      amountCents: row.amountCents,
      bookingGuestNightId,
      bookingGuestId: null,
      bookingId: snapshot.bookingId,
      promoRedemptionId: row.promoRedemptionId,
      promoCodeId: row.promoCodeId,
      beneficiaryMemberId: row.beneficiaryMemberId,
    });
  }
  if (rows.length > 0) {
    await tx.bookingGuestNightAdjustment.createMany({ data: rows });
  }

  const recordedIds = snapshot.recordedNights
    .map((night) => nightIdByKey.get(nightKey(night.bookingGuestId, shifted(night.stayDate))))
    .filter((id): id is string => Boolean(id));
  if (recordedIds.length > 0) {
    await tx.bookingGuestNight.updateMany({
      where: { id: { in: recordedIds } },
      data: { adjustmentsState: "RECORDED" },
    });
  }
  return { carried: true };
}

function abandonCarry(writer: string, bookingId: string, reason: string): { carried: false } {
  logger.warn(
    { bookingId, writer, reason },
    `${NIGHT_ADJUSTMENT_INVARIANT}: the recorded promotion build-up could not be carried across this rewrite; the booking's nights are left UNKNOWN`,
  );
  return { carried: false };
}
