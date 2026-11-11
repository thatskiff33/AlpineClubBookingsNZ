/**
 * The one enrolment rule for a second sign-in step (#4617, INV-AUTH-009).
 *
 * `twoFactorEnabled` stays what it was: an authenticator app or an emailed
 * code. A passkey does not set that flag. Callers that used to read the flag
 * alone now call this, so a passkey-only member is enrolled.
 */

export function isSecondFactorEnrolled(input: {
  twoFactorEnabled?: boolean | null;
  hasPasskey?: boolean | null;
  sessionEnrolled?: boolean | null;
}): boolean {
  return (
    input.twoFactorEnabled === true ||
    input.hasPasskey === true ||
    input.sessionEnrolled === true
  );
}

/**
 * What may stand as an officer's second factor (#4618, INV-AUTH-010).
 *
 * A stored passkey qualifies. An authenticator app qualifies only while the
 * flag is on and the method is the app. Email never does. This is the only
 * "does this factor count" check.
 */
export function satisfiesOfficerSecondFactor(input: {
  twoFactorEnabled?: boolean | null;
  twoFactorMethod?: string | null;
  hasPasskey?: boolean | null;
}): boolean {
  if (input.hasPasskey === true) return true;
  return input.twoFactorEnabled === true && input.twoFactorMethod === "TOTP";
}

/**
 * One assignment the officer rule reads. `requiresTwoFactor` null is Default.
 * Levels are the role definition's, or the seeded default when the row has
 * no definition yet.
 */
export type OfficerTwoFactorAssignment = {
  role: string | null;
  requiresTwoFactor?: boolean | null;
  financeLevel?: string | null;
  supportLevel?: string | null;
};

/**
 * Whether this member must use an authenticator app or a passkey (#4618).
 *
 * True only when the release is on, the club policy is on, the member is not
 * the lodge kiosk, they can still sign in, and any held role requires it.
 * Full Admin always does, whatever a definition says. Not required drops only
 * that role. The club-wide two-factor module is a separate fact and is not
 * an input here.
 */
export function isOfficerTwoFactorRequired(input: {
  releaseEnabled: boolean;
  policyEnabled: boolean;
  kiosk: boolean;
  canLogin?: boolean | null;
  assignments: ReadonlyArray<OfficerTwoFactorAssignment>;
}): boolean {
  if (!input.releaseEnabled || !input.policyEnabled || input.kiosk) return false;
  if (input.canLogin === false) return false;
  if (input.assignments.some((row) => row.role === "ADMIN")) return true;
  return input.assignments.some(assignmentRequiresOfficerTwoFactor);
}

function assignmentRequiresOfficerTwoFactor(row: OfficerTwoFactorAssignment): boolean {
  if (
    row.role === "ADMIN" ||
    row.role === "LODGE" ||
    row.role === "USER" ||
    row.role === "ORG"
  ) {
    return false;
  }
  if (row.requiresTwoFactor === false) return false;
  if (row.requiresTwoFactor === true) return true;
  return row.financeLevel === "EDIT" || row.supportLevel === "EDIT";
}

/**
 * A required officer may start authenticator-app enrolment from profile even
 * when the club-wide module is off. Someone already on the app may not start
 * it again. The module challenge, when one is still owed, is a separate gate.
 */
export function officerMayEnrolAuthenticatorApp(user: {
  officerTwoFactorRequired?: boolean | null;
  twoFactorSatisfiesOfficer?: boolean | null;
  twoFactorEnabled?: boolean | null;
  twoFactorMethod?: string | null;
}): boolean {
  if (user.officerTwoFactorRequired !== true) return false;
  if (user.twoFactorSatisfiesOfficer === true) return false;
  // Already on the authenticator app. Email may be replaced; a switched-off
  // app (method stored, flag off) may be enrolled again.
  return !(user.twoFactorEnabled === true && user.twoFactorMethod === "TOTP");
}
