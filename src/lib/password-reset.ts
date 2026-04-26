export const SELF_SERVICE_PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;

export const ADMIN_PASSWORD_RESET_EXPIRY_WINDOWS = ["1h", "1d", "3d"] as const;

export const ADMIN_PASSWORD_RESET_EXPIRY_OPTIONS = [
  {
    value: "1h",
    label: "1 hour",
    durationMs: SELF_SERVICE_PASSWORD_RESET_TTL_MS,
  },
  {
    value: "1d",
    label: "1 day",
    durationMs: 24 * 60 * 60 * 1000,
  },
  {
    value: "3d",
    label: "3 days",
    durationMs: 3 * 24 * 60 * 60 * 1000,
  },
] as const;

export type AdminPasswordResetExpiryWindow =
  (typeof ADMIN_PASSWORD_RESET_EXPIRY_WINDOWS)[number];

export const DEFAULT_ADMIN_PASSWORD_RESET_EXPIRY_WINDOW: AdminPasswordResetExpiryWindow = "1h";

export function getAdminPasswordResetExpiryDurationMs(
  expiryWindow: AdminPasswordResetExpiryWindow = DEFAULT_ADMIN_PASSWORD_RESET_EXPIRY_WINDOW
) {
  return (
    ADMIN_PASSWORD_RESET_EXPIRY_OPTIONS.find((option) => option.value === expiryWindow)?.durationMs ??
    SELF_SERVICE_PASSWORD_RESET_TTL_MS
  );
}

export function getAdminPasswordResetExpiryDate(
  expiryWindow: AdminPasswordResetExpiryWindow = DEFAULT_ADMIN_PASSWORD_RESET_EXPIRY_WINDOW
) {
  return new Date(Date.now() + getAdminPasswordResetExpiryDurationMs(expiryWindow));
}

export function getAdminPasswordResetExpiryLabel(
  expiryWindow: AdminPasswordResetExpiryWindow = DEFAULT_ADMIN_PASSWORD_RESET_EXPIRY_WINDOW
) {
  return (
    ADMIN_PASSWORD_RESET_EXPIRY_OPTIONS.find((option) => option.value === expiryWindow)?.label ??
    "1 hour"
  );
}

export function hasMemberCompletedAccountSetup(member: {
  passwordChangedAt?: Date | string | null;
  lastLoginAt?: Date | string | null;
}) {
  return Boolean(member.passwordChangedAt || member.lastLoginAt);
}
