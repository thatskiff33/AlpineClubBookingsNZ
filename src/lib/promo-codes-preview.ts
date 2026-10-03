import { prisma } from "@/lib/prisma";
import { bookingFinalPriceCents } from "@/lib/booking-final-price";
import { applyBookingPromotions, type PromotionGuest } from "@/lib/booking-promotions";
import type { CalendarDate } from "@/lib/club-time";
import { multiPromoCodesEnabled } from "@/lib/promo-redemption-slot";

// The several-code half of `/api/promo-codes/validate` (#3827), kept out of the
// route handler so the route stays a thin door over the one orchestrator.
/**
 * The several-code preview (#3827): the working bee first, then each code in
 * the booker's order, each over the nights no earlier one claimed — the
 * orchestrator the save runs, unlocked and read-only. Per code it answers what
 * the single-code preview answers; the totals are the booking's.
 */
export async function validateSeveralPromoCodes(params: {
  codes: Array<{ code: string; promoGuestIndexes?: number[] }>;
  workPartyPromo:
    | (NonNullable<Awaited<ReturnType<typeof prisma.promoCode.findUnique>>> & {
        assignments: { memberId: string }[];
        lodges: { lodgeId: string }[];
      })
    | null;
  workPartyEvent: { id: string; name: string; discountPercent: number } | null;
  memberId: string;
  checkIn: Date;
  totalPriceCents: number;
  guests: PromotionGuest[];
  lodgeId: string;
  /** The club's day, resolved by the route (`INV-CONFIG-002`). */
  todayAtClub: CalendarDate;
}) {
  const typed = params.codes.map((entry) => entry.code.toUpperCase().trim());
  const sources = (params.workPartyPromo ? 1 : 0) + typed.length;
  const refusal =
    new Set(typed).size !== typed.length
      ? "The same promo code was entered more than once."
      : sources > 1 && !(await multiPromoCodesEnabled(prisma))
        ? "Only one promo code can be used on a booking."
        : null;
  const finalPrice = (promoAdjustmentCents: number) =>
    bookingFinalPriceCents({ totalPriceCents: params.totalPriceCents, promoAdjustmentCents });
  if (refusal) {
    return {
      valid: false,
      error: refusal,
      codes: [],
      discountCents: 0,
      promoAdjustmentCents: 0,
      totalPriceCents: params.totalPriceCents,
      finalPriceCents: finalPrice(0),
    };
  }
  const rows = await prisma.promoCode.findMany({
    where: { code: { in: typed } },
    include: {
      assignments: { select: { memberId: true } },
      lodges: { select: { lodgeId: true } },
    },
  });
  type Row = (typeof rows)[number];
  const toApplication = (promoCode: Row, selectedGuestIndexes?: number[]) => ({
    code: promoCode.code,
    promoCode,
    assignedMemberIds: promoCode.assignments.length
      ? promoCode.assignments.map((assignment) => assignment.memberId)
      : null,
    selectedGuestIndexes,
    capOverflow: "reject" as const,
  });
  const notFound: string[] = [];
  const applications = [];
  if (params.workPartyPromo) applications.push(toApplication(params.workPartyPromo));
  params.codes.forEach((entry, index) => {
    // Internal promos (work party events) are system-applied only; a typed one
    // behaves like a nonexistent code.
    const row = rows.find((candidate) => candidate.code === typed[index] && !candidate.internal);
    if (row) applications.push(toApplication(row, entry.promoGuestIndexes));
    else notFound.push(typed[index]!);
  });
  const priced = await applyBookingPromotions(applications, {
    memberId: params.memberId,
    bookingCheckIn: params.checkIn,
    totalPriceCents: params.totalPriceCents,
    guests: params.guests,
    db: prisma,
    lodgeId: params.lodgeId,
    todayAtClub: params.todayAtClub,
  });
  const perCode = [
    ...priced.outcomes
      .filter(({ application }) => !application.promoCode.internal)
      .map(({ application, result }) =>
        result.error || !result.discount
          ? {
              code: application.code,
              valid: false,
              error: result.error ?? "Promo code could not be applied",
              ...(result.requiresGuestSelection
                ? {
                    requiresGuestSelection: true,
                    selectableGuestIndexes: result.selectableGuestIndexes ?? [],
                  }
                : {}),
            }
          : {
              code: application.code,
              valid: true,
              description: application.promoCode.description,
              type: application.promoCode.type,
              discountCents: result.discount.discountCents,
              promoAdjustmentCents: result.discount.priceAdjustmentCents,
              freeNightsUsed: result.discount.freeNightsUsed,
              eligibleGuestCount: result.discount.eligibleGuestCount,
              remainingFreeNights: result.remainingFreeNights,
              selectedGuestIndexes: result.selectedGuestIndexes,
            },
      ),
    ...notFound.map((code) => ({ code, valid: false, error: "Promo code not found" })),
  ];
  const workParty = priced.outcomes.find(({ application }) => application.promoCode.internal);
  return {
    valid:
      perCode.every((entry) => entry.valid) &&
      (!workParty || (!workParty.result.error && Boolean(workParty.result.discount))),
    ...(workParty?.result.error ? { error: workParty.result.error } : {}),
    workPartyEvent: params.workPartyEvent,
    codes: perCode,
    discountCents: priced.discountCents,
    promoAdjustmentCents: priced.priceAdjustmentCents,
    totalPriceCents: params.totalPriceCents,
    finalPriceCents: finalPrice(priced.priceAdjustmentCents),
  };
}
