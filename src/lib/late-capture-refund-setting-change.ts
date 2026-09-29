import type { Prisma } from "@prisma/client";
import { DEFAULT_BOOKING_DEFAULTS } from "@/config/club-settings-defaults";
import { hasAdminAreaAccess, type AdminPermissionInput } from "@/lib/admin-permissions";
import { logAudit } from "@/lib/audit";

/**
 * #3639 (review F2, delta D3): who may switch late-capture refunds between
 * automatic and treasurer approval, and the record that they did.
 *
 * The control sits on the Cancellation policy page, beside the other club-wide
 * booking defaults, because it is what happens to money after a cancellation.
 * But it decides whether members' money leaves the club without a treasurer, so
 * CHANGING it needs finance EDIT as well as the page's own bookings edit.
 *
 * ASKED INSIDE THE WRITE TRANSACTION (delta D3). The route's transaction is
 * Serializable, so the stored value read here is the one the write replaces: a
 * treasurer's switch committing in between aborts this save instead of being
 * silently reverted by it. And the page sends the value it LOADED, so a save
 * made against a value that has since changed is refused with a message that
 * says so, rather than overwriting it.
 */
export const LATE_CAPTURE_SETTING_NEEDS_FINANCE_MESSAGE =
  "Changing how late card payments on cancelled bookings are refunded needs finance edit access. Everything else on this page can still be saved; ask a treasurer to change this setting.";
export const LATE_CAPTURE_SETTING_CHANGED_UNDERNEATH_MESSAGE =
  "Someone changed how late card payments on cancelled bookings are refunded while you had this page open. Reload the page to see the current setting, then save again.";

/** A refusal the route turns into a response; thrown to roll the save back. */
export class LateCaptureSettingRefusal extends Error {
  constructor(
    message: string,
    readonly status: 403 | 409,
  ) {
    super(message);
    this.name = "LateCaptureSettingRefusal";
  }
}

export async function checkLateCaptureSettingChange(
  store: Pick<Prisma.TransactionClient, "bookingDefaults">,
  user: AdminPermissionInput,
  requested: boolean | undefined,
  loaded: boolean | undefined,
): Promise<{ before: boolean; changing: boolean }> {
  const stored = await store.bookingDefaults.findUnique({
    where: { id: "default" },
    select: { lateCaptureRefundNeedsApproval: true },
  });
  const before =
    stored?.lateCaptureRefundNeedsApproval ??
    DEFAULT_BOOKING_DEFAULTS.lateCaptureRefundNeedsApproval;
  if (requested !== undefined && loaded !== undefined && loaded !== before) {
    throw new LateCaptureSettingRefusal(LATE_CAPTURE_SETTING_CHANGED_UNDERNEATH_MESSAGE, 409);
  }
  const changing = requested !== undefined && requested !== before;
  if (changing && !hasAdminAreaAccess(user, { area: "finance", level: "edit" })) {
    throw new LateCaptureSettingRefusal(LATE_CAPTURE_SETTING_NEEDS_FINANCE_MESSAGE, 403);
  }
  return { before, changing };
}

/**
 * Its own `payment` entry, beside `late_capture_refund_held` and
 * `refunded_after_cancellation`, so a treasurer filtering the audit log by
 * payment sees who turned the gate on or off and when — from the Cancellation
 * page or a configuration import (delta D8).
 */
export function auditLateCaptureSettingChange(params: {
  actorMemberId: string | null;
  before: boolean;
  after: boolean;
  via: "cancellation-page" | "configuration-import";
}): void {
  logAudit({
    action: "booking-defaults.late_capture_refund_approval.changed",
    category: "payment",
    severity: "important",
    memberId: params.actorMemberId ?? undefined,
    entityType: "BookingDefaults",
    entityId: "default",
    details: JSON.stringify({
      before: params.before ? "treasurer_approves" : "refund_automatically",
      after: params.after ? "treasurer_approves" : "refund_automatically",
      via: params.via,
    }),
  });
}
