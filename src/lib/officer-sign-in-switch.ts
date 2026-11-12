/**
 * Officer sign-in (#4615) stays off on main until #4620 flips this.
 * Not a club setting. Listed destructive routes call `requireRecentAuth`,
 * which reads this constant and does nothing while it is false.
 */
export const OFFICER_SIGN_IN_ENFORCED = false;
