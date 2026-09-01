import { buildHrefWithReturnTo } from "@/lib/internal-return-path";

/**
 * The local records a Xero row can be anchored to AND opened from the admin
 * Xero screens. A `localModel` missing from this list is not a broken link - it
 * renders as plain text and its record page 404s - so an anchor added to the
 * outbox belongs here in the same change.
 *
 * `ManualRefundTask` is #3193's second ask: one settled review share's own small
 * supplementary invoice, anchored on the task rather than on the booking change
 * so the change's own reads cannot raise it. That anchor is what makes it safe,
 * and it is also what made it invisible to the operator - a second ask that
 * failed in Xero had no page to open and no row an officer could recognise,
 * while the booking's audit trail already said the amount was being billed
 * (#3193 fix round).
 */
const XERO_LOCAL_MODELS = [
  "Member",
  "Booking",
  "Payment",
  "BookingModification",
  "ManualRefundTask",
  "MemberSubscription",
  "MembershipCancellationRequest",
  "MembershipCancellationRequestParticipant",
] as const;

export type XeroLocalModel = (typeof XERO_LOCAL_MODELS)[number];

export function isXeroLocalModel(value: string): value is XeroLocalModel {
  return (XERO_LOCAL_MODELS as readonly string[]).includes(value);
}

export function buildXeroRecordActivityUrl(
  localModel: XeroLocalModel | string,
  localId: string,
  returnTo?: string | null
): string {
  const href = `/admin/xero/records/${encodeURIComponent(localModel)}/${encodeURIComponent(localId)}`;
  return returnTo ? buildHrefWithReturnTo(href, returnTo) : href;
}

export function buildLocalAdminUrl(localModel: string | null, localId: string | null): string | null {
  if (!localModel || !localId) {
    return null;
  }

  switch (localModel) {
    case "Member":
      return `/admin/members/${encodeURIComponent(localId)}`;
    case "Booking":
    case "Payment":
    case "BookingModification":
    case "ManualRefundTask":
    case "MemberSubscription":
      return buildXeroRecordActivityUrl(localModel, localId);
    case "MembershipCancellationRequest":
    case "MembershipCancellationRequestParticipant":
      return buildXeroRecordActivityUrl(localModel, localId, "/admin/membership-cancellations?status=ALL");
    default:
      return null;
  }
}
