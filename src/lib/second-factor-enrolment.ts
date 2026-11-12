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
 * What may stand as an officer's second factor (#4618 will enforce it).
 *
 * A stored passkey qualifies. An authenticator app qualifies only while the
 * flag is on and the method is the app. Email never does.
 */
export function satisfiesOfficerSecondFactor(input: {
  twoFactorEnabled?: boolean | null;
  twoFactorMethod?: string | null;
  hasPasskey?: boolean | null;
}): boolean {
  if (input.hasPasskey === true) return true;
  return input.twoFactorEnabled === true && input.twoFactorMethod === "TOTP";
}
