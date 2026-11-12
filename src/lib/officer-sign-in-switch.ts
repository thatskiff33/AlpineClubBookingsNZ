/**
 * Officer sign-in (#4615) stays off on main until #4620 flips this.
 * Not a club setting. Listed destructive routes call `requireRecentAuth`,
 * which reads this constant and does nothing while it is false.
 *
 * The officer two-factor requirement (#4618) reads it too: while it is false
 * nobody is required, no grace is stamped, the admin controls are hidden, the
 * reset route answers 404 and the break-glass command writes nothing. The
 * policy's database default is already on, so flipping this is the only edit
 * #4620 makes for #4618; do not also change that column default.
 */
export const OFFICER_SIGN_IN_ENFORCED = false;
