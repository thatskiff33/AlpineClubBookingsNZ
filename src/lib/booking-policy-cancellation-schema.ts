import type { BookingDefaults } from "@prisma/client"
import { z } from "zod"
import { DEFAULT_BOOKING_DEFAULTS } from "@/config/club-settings-defaults"

/**
 * The Cancellation policy page's request shape and its club-wide defaults echo,
 * lifted out of the route (#3639) so the route stays a door: guard, validate,
 * write, audit.
 */
const CLUB_WIDE_ONLY_FIELDS = [
  ["nonMemberHoldDays", "Hold days are club-wide and cannot be set per lodge"],
  ["nonMemberHoldEnabled", "Hold enablement is club-wide and cannot be set per lodge"],
  ["waitlistCrossLodgeOrder", "Waitlist queue order is club-wide and cannot be set per lodge"],
  ["linkedMoveChargesBothChangeFees", "The linked-move change-fee setting is club-wide and cannot be set per lodge"],
  ["lateCaptureRefundNeedsApproval", "The late-payment refund setting is club-wide and cannot be set per lodge"],
] as const

export const policySchema = z
  .object({
    rules: z.array(
      z.object({
        daysBeforeStay: z.number().int().min(0),
        refundPercentage: z.number().int().min(0).max(100),
        creditRefundPercentage: z.number().int().min(0).max(100).optional(),
        fixedFeeCents: z.number().int().min(0).optional(),
        creditFixedFeeCents: z.number().int().min(0).optional(),
      })
    ),
    nonMemberHoldEnabled: z.boolean().optional(),
    nonMemberHoldDays: z.number().int().min(1).max(365).optional(),
    // Cross-lodge waitlist queue order (ADR-004 owner decision 1).
    // Club-wide, like hold days: queue fairness is a club policy.
    waitlistCrossLodgeOrder: z.enum(["OWN_LODGE_FIRST", "MERGED"]).optional(),
    // #3232 D2: whether the LINKED MOVE charges the change fee on both bookings.
    // Club-wide like the two above, and for the same kind of reason: the change-fee
    // TIERS price a lodge's own cancellation risk and are per lodge, but whether a
    // second fee is fair when the club's own supervision rule compelled the move is
    // a question about how the club treats its members, which does not differ
    // between its lodges.
    linkedMoveChargesBothChangeFees: z.boolean().optional(),
    // #3639 (owner decision 26 Sep 2026): hold a late capture for a treasurer.
    lateCaptureRefundNeedsApproval: z.boolean().optional(),
    // Per-lodge override partition (ADR-001 resolved question 3). Omitted =
    // the club-wide (null lodgeId) rules. A lodge's rows REPLACE the
    // club-wide set at runtime; an empty rules array for a lodge removes the
    // override so the lodge reverts to club-wide.
    lodgeId: z.string().min(1).optional(),
  })
  .superRefine((data, ctx) => {
    if (!data.lodgeId && data.rules.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rules"],
        message: "At least one rule is required",
      })
    }
    // The club-wide fields a lodge override may not carry (#3639: one table).
    if (data.lodgeId) {
      for (const [field, message] of CLUB_WIDE_ONLY_FIELDS) {
        if (data[field] !== undefined) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message })
        }
      }
    }
  })

// The club-wide defaults for the GET and the PUT's echo; an absent row means each
// effective default, read from the one home rather than restated (`INV-SSOT-001`).
export function clubWideDefaults(defaults: Partial<BookingDefaults> | null) {
  return {
    nonMemberHoldEnabled: defaults?.nonMemberHoldEnabled ?? DEFAULT_BOOKING_DEFAULTS.nonMemberHoldEnabled,
    nonMemberHoldDays: defaults?.nonMemberHoldDays ?? DEFAULT_BOOKING_DEFAULTS.nonMemberHoldDays,
    waitlistCrossLodgeOrder:
      defaults?.waitlistCrossLodgeOrder ?? DEFAULT_BOOKING_DEFAULTS.waitlistCrossLodgeOrder,
    linkedMoveChargesBothChangeFees:
      defaults?.linkedMoveChargesBothChangeFees ??
      DEFAULT_BOOKING_DEFAULTS.linkedMoveChargesBothChangeFees,
    lateCaptureRefundNeedsApproval:
      defaults?.lateCaptureRefundNeedsApproval ??
      DEFAULT_BOOKING_DEFAULTS.lateCaptureRefundNeedsApproval,
  }
}
