export const XERO_LOCAL_MODELS = [
  "Member",
  "Booking",
  "Payment",
  "BookingModification",
  "MemberSubscription",
] as const;

export type XeroLocalModel = (typeof XERO_LOCAL_MODELS)[number];

export function isXeroLocalModel(value: string): value is XeroLocalModel {
  return (XERO_LOCAL_MODELS as readonly string[]).includes(value);
}

export function buildXeroRecordActivityUrl(localModel: XeroLocalModel | string, localId: string): string {
  return `/admin/xero/records/${encodeURIComponent(localModel)}/${encodeURIComponent(localId)}`;
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
    case "MemberSubscription":
      return buildXeroRecordActivityUrl(localModel, localId);
    default:
      return null;
  }
}
