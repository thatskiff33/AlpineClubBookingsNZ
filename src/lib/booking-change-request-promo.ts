import { z } from "zod";

import { BOOKING_PARTY_GUESTS_MAX } from "@/lib/booking-guest-stay-range-input";
import type { BatchModifyInput } from "@/lib/booking-modify-validation";
import { requestedPromoCodeList } from "@/lib/booking-modify-promo-request";

/**
 * #4533: the promo change a LOCKED_PERIOD change request can carry on a
 * FINISHED stay — the one place its shape, its stored record and its mapping to
 * the batch edit live (`INV-SSOT-001`).
 *
 * WHY IT EXISTS. A member's assigned promo (committee free nights, say) was
 * missed on a stay an officer booked for them, and once the stay finished
 * nothing in the app could apply it: Edit Booking locks a finished stay, and the
 * finished-stay correction (#3750) applies only what a change request carries,
 * which was dates and guests. Every workaround left the free night counted as
 * unused, so it could be claimed again.
 *
 * WHAT IT IS. The same promo fields Edit Booking sends (`promoCode` with its
 * guests, or the plural `promoCodes` list), entered by an officer — on the
 * member's behalf — either when raising the request from Edit Booking or when
 * approving one. Approval passes them to `modifyBookingBatch` under
 * `finishedStayCorrection`, so pricing, eligibility, caps, the redemption,
 * settlement, Xero and the ledger keep their one home. No member sends one: a
 * member's own finished stay stays locked, and an in-progress stay refuses promo
 * changes outright.
 *
 * WHAT IT IS NOT. A removal. Taking a code off a finished stay would bill the
 * member more after the event, which is not the correction this exists for, so
 * the shape cannot say "no codes".
 */

const promoCodeField = z.string().trim().min(1).max(50);
const promoGuestIdsField = z.array(z.string().trim().min(1)).max(BOOKING_PARTY_GUESTS_MAX);

const promoChangeShape = {
  /** Edit Booking's one-code field: the booking's code becomes this one. */
  promoCode: promoCodeField.optional(),
  /** The one code's guests, for a code the booker applies to chosen guests. */
  promoGuestIds: promoGuestIdsField.optional(),
  /** Edit Booking's plural field: every code the booking carries afterwards (#3827). */
  promoCodes: z
    .array(z.object({ code: promoCodeField, promoGuestIds: promoGuestIdsField.optional() }).strict())
    .min(1)
    .max(20)
    .optional(),
};

export const PROMO_CHANGE_SHAPE_MESSAGE =
  "Name the promo code to apply: one code, or the full list of codes the booking should carry.";

type PromoChangeFields = {
  promoCode?: string;
  promoGuestIds?: string[];
  promoCodes?: Array<{ code: string; promoGuestIds?: string[] }>;
};

/** Exactly one of the two shapes, and guests only beside the one code. */
function wellShaped(change: PromoChangeFields): boolean {
  if ((change.promoCode === undefined) === (change.promoCodes === undefined)) return false;
  return !(change.promoCodes && change.promoGuestIds);
}

/**
 * The promo change as a request carries it — from Edit Booking's correction
 * card (`POST /api/bookings/[id]/change-requests`) or the officer's approval
 * (`PATCH /api/admin/booking-change-requests/[id]` and its quote).
 */
export const changeRequestPromoChangeSchema = z
  .object(promoChangeShape)
  .strict()
  .refine(wellShaped, { message: PROMO_CHANGE_SHAPE_MESSAGE });

export type ChangeRequestPromoChange = z.infer<typeof changeRequestPromoChangeSchema>;

/**
 * Who entered the change, written beside it. Always an officer, on the member's
 * behalf; `enteredOn` says whether it came with the request (Edit Booking) or
 * with the approval (the queue card).
 */
const promoChangeStampSchema = z.object({
  onMemberBehalf: z.literal(true),
  officerMemberId: z.string(),
  enteredAt: z.string(),
  enteredOn: z.enum(["request", "approval"]),
});

export type PromoChangeStamp = z.infer<typeof promoChangeStampSchema>;

/**
 * `requestedChanges.requested.promoChange` read back. Not `.strict()`: the
 * column is JSON, and a key added later must not make an older row unreadable.
 */
export const storedPromoChangeSchema = z
  .object({ ...promoChangeShape, enteredBy: promoChangeStampSchema })
  .refine(wellShaped, { message: PROMO_CHANGE_SHAPE_MESSAGE });

/** The batch edit's own promo fields for a change — nothing else travels. */
export function promoChangeBatchFields(
  change: PromoChangeFields,
): Pick<BatchModifyInput, "promoCode" | "promoGuestIds" | "promoCodes"> {
  if (change.promoCodes) {
    return {
      promoCodes: change.promoCodes.map((entry) => ({
        code: entry.code,
        ...(entry.promoGuestIds?.length ? { promoGuestIds: entry.promoGuestIds } : {}),
      })),
    };
  }
  return {
    ...(change.promoCode ? { promoCode: change.promoCode } : {}),
    ...(change.promoGuestIds?.length ? { promoGuestIds: change.promoGuestIds } : {}),
  };
}

/** The codes a change asks for, in the stored spelling, through the edit's own reader. */
export function promoChangeCodes(change: PromoChangeFields): string[] {
  return (requestedPromoCodeList(promoChangeBatchFields(change)) ?? []).map((entry) => entry.code);
}

/** The booking's codes now, sorted: what a request's snapshot is compared with. */
export function bookingPromoCodeSnapshot(
  redemptions: ReadonlyArray<{ promoCode: { code: string } | null }>,
): string[] {
  return redemptions.flatMap((redemption) => (redemption.promoCode ? [redemption.promoCode.code] : [])).sort();
}

/**
 * Whether the booking's codes moved since the request was written. A request
 * stored before #4533, or with no promo change, recorded no snapshot and is not
 * judged on its codes.
 */
export function promoCodesDriftedFromRequest(
  snapshot: ReadonlyArray<string> | null | undefined,
  current: ReadonlyArray<string>,
): boolean {
  if (!snapshot) return false;
  const before = [...snapshot].sort();
  return before.length !== current.length || before.some((code, index) => code !== current[index]);
}

/**
 * Whether a change asks for anything the booking does not already carry. A
 * list naming exactly the codes the booking holds, with no guest choice, would
 * only re-price them: there is nothing to correct.
 */
export function promoChangeChangesCodes(change: PromoChangeFields, current: ReadonlyArray<string>): boolean {
  const namesGuests =
    Boolean(change.promoGuestIds?.length) || Boolean(change.promoCodes?.some((entry) => entry.promoGuestIds?.length));
  if (namesGuests) return true;
  const asked = promoChangeCodes(change).sort();
  return asked.length !== current.length || asked.some((code, index) => code !== current[index]);
}

/** The words a promo change adds to a request's summary. */
export function describePromoChange(change: PromoChangeFields): string {
  const codes = promoChangeCodes(change);
  return codes.length === 1 ? `apply promo code ${codes[0]}` : `promo codes ${codes.join(", ")}`;
}

/** Said beside the summary, so the queue and the member's page say whose change it is. */
export const PROMO_CHANGE_SUMMARY_SUFFIX = "(promo entered by a booking officer on the member's behalf)";

/**
 * The request's stored `requestedChanges` with an officer's promo change written
 * in: `requested.promoChange` (the change and its stamp), the summary extended,
 * and `original.promoCodes`, the booking's codes the change was entered
 * against. Everything else is kept exactly.
 */
export function withPromoChange(
  requestedChanges: unknown,
  change: ChangeRequestPromoChange,
  stamp: { officerMemberId: string; enteredAt: Date; enteredOn: PromoChangeStamp["enteredOn"] },
  currentCodes: ReadonlyArray<string>,
): Record<string, unknown> {
  const stored = isRecord(requestedChanges) ? requestedChanges : {};
  const original = isRecord(stored.original) ? stored.original : {};
  const requested = isRecord(stored.requested) ? stored.requested : {};
  const priorSummary = typeof requested.summary === "string" ? requested.summary.trim() : "";
  const promoSummary = `${describePromoChange(change)} ${PROMO_CHANGE_SUMMARY_SUFFIX}`;
  const enteredBy: PromoChangeStamp = {
    onMemberBehalf: true,
    officerMemberId: stamp.officerMemberId,
    enteredAt: stamp.enteredAt.toISOString(),
    enteredOn: stamp.enteredOn,
  };
  return {
    ...stored,
    original: { ...original, promoCodes: [...currentCodes].sort() },
    requested: {
      ...requested,
      promoChange: { ...promoChangeBatchFields(change), enteredBy },
      summary:
        priorSummary && priorSummary !== NO_STRUCTURED_SUMMARY ? `${priorSummary}; ${promoSummary}` : promoSummary,
    },
  };
}

/** `buildChangeRequestSummary`'s answer for a request that names nothing. */
const NO_STRUCTURED_SUMMARY = "Locked-period booking change";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** #4533: a promo change is entered by an officer, and only for a finished stay. */
export const PROMO_CHANGE_OFFICER_FINISHED_STAY_ONLY_MESSAGE =
  "A promo code can be added to a change request only by a booking officer, for a stay that has finished. Change the promo code in Edit Booking instead.";

/** #4533: the correction request carries the promo change and nothing else. */
export const PROMO_CHANGE_ALONE_MESSAGE =
  "A promo correction request carries only the promo code. Undo the other changes, or send them separately.";

/** #4533: the booking already carries exactly these codes. */
export const PROMO_CHANGE_ALREADY_APPLIED_MESSAGE =
  "This booking already carries that promo code, so there is nothing to correct.";

/** #4533: the officer's promo entry on a request that already carries one. */
export const OFFICER_PROMO_ON_PROMO_REQUEST_MESSAGE =
  "This request already names a promo code, so another cannot be entered for it. Reload the queue; nothing has been changed and the request is still pending.";

/** #4533: an officer's promo entry outside an approval that applies the request. */
export const OFFICER_PROMO_NEEDS_EXECUTION_MESSAGE =
  "A promo code can be entered only when approving a request on a finished stay, which applies it. Nothing has been changed.";

/**
 * #4533: the officer may withhold the change email only on a promo correction.
 * A guest or date change keeps #4030's decision: the member is always told.
 */
export const NOTIFY_CHOICE_PROMO_ONLY_MESSAGE =
  "The member is always emailed when guests or dates change. Only a promo-code-only correction can be applied without the email. Nothing has been changed; the request is still pending.";
