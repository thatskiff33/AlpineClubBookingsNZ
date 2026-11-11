/**
 * The three officer claims a session refresh stamps (#4618).
 *
 * Pure: the refresh, the report and the tests all call this. Production
 * passes `OFFICER_SIGN_IN_RELEASE_ENABLED`. `twoFactorRequired` (the
 * club-wide module) is not decided here.
 */

import {
  isOfficerTwoFactorRequired,
  satisfiesOfficerSecondFactor,
  type OfficerTwoFactorAssignment,
} from "@/lib/second-factor-enrolment";
import type { ClubTimeZone } from "@/lib/club-time";
import {
  officerGraceClosedByReset,
  officerGraceHasEnded,
  officerTwoFactorGraceEnd,
} from "@/lib/officer-two-factor-grace";

export type OfficerTwoFactorClaims = {
  officerTwoFactorRequired: boolean;
  twoFactorSatisfiesOfficer: boolean;
  /** Epoch milliseconds, or null when they are not required or they already satisfy. */
  officerTwoFactorGraceEndsAt: number | null;
  /** A guarded set-if-null write is still needed. */
  shouldStampGrace: boolean;
};

export function buildOfficerTwoFactorClaims(input: {
  releaseEnabled: boolean;
  policyEnabled: boolean;
  graceDays: number;
  kiosk: boolean;
  canLogin?: boolean | null;
  assignments: ReadonlyArray<OfficerTwoFactorAssignment>;
  twoFactorEnabled?: boolean | null;
  twoFactorMethod?: string | null;
  hasPasskey?: boolean | null;
  graceStartedAt: Date | null;
  factorsResetAt: Date | null;
  zone: ClubTimeZone | null;
  now: Date;
}): OfficerTwoFactorClaims {
  const officerTwoFactorRequired = isOfficerTwoFactorRequired({
    releaseEnabled: input.releaseEnabled,
    policyEnabled: input.policyEnabled,
    kiosk: input.kiosk,
    canLogin: input.canLogin,
    assignments: input.assignments,
  });
  const twoFactorSatisfiesOfficer = satisfiesOfficerSecondFactor({
    twoFactorEnabled: input.twoFactorEnabled,
    twoFactorMethod: input.twoFactorMethod,
    hasPasskey: input.hasPasskey,
  });
  if (!officerTwoFactorRequired || twoFactorSatisfiesOfficer) {
    return {
      officerTwoFactorRequired,
      twoFactorSatisfiesOfficer,
      officerTwoFactorGraceEndsAt: null,
      shouldStampGrace: false,
    };
  }

  const closedByReset = officerGraceClosedByReset({
    graceStartedAt: input.graceStartedAt,
    factorsResetAt: input.factorsResetAt,
  });
  if (closedByReset && input.factorsResetAt) {
    return {
      officerTwoFactorRequired,
      twoFactorSatisfiesOfficer,
      officerTwoFactorGraceEndsAt: input.factorsResetAt.getTime(),
      shouldStampGrace: false,
    };
  }

  if (!(input.graceStartedAt instanceof Date)) {
    return {
      officerTwoFactorRequired,
      twoFactorSatisfiesOfficer,
      officerTwoFactorGraceEndsAt: null,
      shouldStampGrace: true,
    };
  }

  if (!input.zone) {
    return {
      officerTwoFactorRequired,
      twoFactorSatisfiesOfficer,
      officerTwoFactorGraceEndsAt: null,
      shouldStampGrace: false,
    };
  }

  const end = officerTwoFactorGraceEnd({
    startedAt: input.graceStartedAt,
    graceDays: input.graceDays,
    zone: input.zone,
  });
  // Zero days ends at the stamp. The refresh that wrote it is already gated,
  // even if the database clock is a few milliseconds ahead of this process.
  const endsAt =
    input.graceDays <= 0
      ? Math.min(end.getTime(), input.now.getTime())
      : end.getTime();
  return {
    officerTwoFactorRequired,
    twoFactorSatisfiesOfficer,
    officerTwoFactorGraceEndsAt: endsAt,
    shouldStampGrace: false,
  };
}

export function officerClaimsAreGated(
  claims: Pick<
    OfficerTwoFactorClaims,
    "officerTwoFactorRequired" | "twoFactorSatisfiesOfficer" | "officerTwoFactorGraceEndsAt"
  >,
  now: Date,
): boolean {
  if (!claims.officerTwoFactorRequired || claims.twoFactorSatisfiesOfficer) return false;
  if (claims.officerTwoFactorGraceEndsAt == null) return false;
  return officerGraceHasEnded(now, new Date(claims.officerTwoFactorGraceEndsAt));
}
