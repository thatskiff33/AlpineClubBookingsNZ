import { DEFAULT_BOOKING_DEFAULTS } from "@/config/club-settings-defaults";
import { hasAdminAreaAccess, type AdminPermissionInput } from "@/lib/admin-permissions";
import { logAudit } from "@/lib/audit";
import { prisma } from "@/lib/prisma";

/**
 * #3639 (review F2): who may switch late-capture refunds between automatic and
 * treasurer approval, and the record that they did.
 *
 * The control sits on the Cancellation policy page, beside the other club-wide
 * booking defaults, because it is what happens to money after a cancellation.
 * But it decides whether members' money leaves the club without a treasurer, so
 * CHANGING it needs finance EDIT as well as the page's own bookings edit. A save
 * that re-sends the stored value unchanged needs nothing extra, so a bookings
 * officer editing the refund tiers is not refused over a field they left alone.
 */
export const LATE_CAPTURE_SETTING_NEEDS_FINANCE_MESSAGE =
  "Changing how late card payments on cancelled bookings are refunded needs finance edit access. Everything else on this page can still be saved; ask a treasurer to change this setting.";

export async function checkLateCaptureSettingChange(
  user: AdminPermissionInput,
  requested: boolean | undefined,
): Promise<{ refused: boolean; before: boolean; changing: boolean }> {
  const stored = await prisma.bookingDefaults.findUnique({
    where: { id: "default" },
    select: { lateCaptureRefundNeedsApproval: true },
  });
  const before =
    stored?.lateCaptureRefundNeedsApproval ??
    DEFAULT_BOOKING_DEFAULTS.lateCaptureRefundNeedsApproval;
  const changing = requested !== undefined && requested !== before;
  return {
    before,
    changing,
    refused: changing && !hasAdminAreaAccess(user, { area: "finance", level: "edit" }),
  };
}

/**
 * Its own `payment` entry, beside `late_capture_refund_held` and
 * `refunded_after_cancellation`, so a treasurer filtering the audit log by
 * payment sees who turned the gate on or off and when.
 */
export function auditLateCaptureSettingChange(params: {
  actorMemberId: string;
  before: boolean;
  after: boolean;
}): void {
  logAudit({
    action: "booking-defaults.late_capture_refund_approval.changed",
    category: "payment",
    severity: "important",
    memberId: params.actorMemberId,
    entityType: "BookingDefaults",
    entityId: "default",
    details: JSON.stringify({
      before: params.before ? "treasurer_approves" : "refund_automatically",
      after: params.after ? "treasurer_approves" : "refund_automatically",
    }),
  });
}
