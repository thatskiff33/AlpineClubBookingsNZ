/**
 * Officer sign-in (#4618) stays off until #4620 sets this to true.
 *
 * The database default of the policy is already on. Flipping this constant is
 * the only edit that starts the requirement, the grace period, and the
 * recovery paths. Do not also change that column default.
 */
export const OFFICER_SIGN_IN_RELEASE_ENABLED = false;
