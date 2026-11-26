/**
 * The subscription lockout modes, in a module with no imports, so the settings
 * route's request schema (`admin-membership-api/config-settings.ts`) and the AI
 * app catalogue can name them without loading the database client that
 * `membership-lockout-settings.ts` reads with. That module re-exports them.
 */

/**
 * The three answers a club can give about a member whose season subscription is
 * required but unpaid (#2543). Mirrors the Prisma `SubscriptionLockoutMode`
 * enum without importing it, so the pure policy modules and the settings layer
 * can name one type.
 */
export type SubscriptionLockoutMode =
  | "NO_BLOCK"
  | "HARD_BLOCK"
  | "NON_MEMBER_PRICING";

export const SUBSCRIPTION_LOCKOUT_MODES = [
  "NO_BLOCK",
  "HARD_BLOCK",
  "NON_MEMBER_PRICING",
] as const satisfies readonly SubscriptionLockoutMode[];

export function isSubscriptionLockoutMode(
  value: unknown,
): value is SubscriptionLockoutMode {
  return (
    typeof value === "string" &&
    (SUBSCRIPTION_LOCKOUT_MODES as readonly string[]).includes(value)
  );
}
