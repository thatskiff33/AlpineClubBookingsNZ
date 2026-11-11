import { getSafeInternalReturnPath } from "@/lib/internal-return-path";
import { isSecondFactorEnrolled } from "@/lib/second-factor-enrolment";

export type TwoFactorSessionUser = {
  id?: string | null;
  twoFactorRequired?: boolean;
  twoFactorVerified?: boolean;
  twoFactorEnrolled?: boolean;
  hasPasskey?: boolean;
};

export type TwoFactorGateMember = {
  forcePasswordChange?: boolean | null;
  twoFactorEnabled?: boolean | null;
};

export function isTwoFactorSessionBlocked(params: {
  sessionUser?: TwoFactorSessionUser | null;
  member?: TwoFactorGateMember | null;
  allowForcePasswordChange?: boolean;
}) {
  const { sessionUser, member, allowForcePasswordChange = false } = params;

  if (!sessionUser?.twoFactorRequired || sessionUser.twoFactorVerified) {
    return false;
  }

  if (allowForcePasswordChange && member?.forcePasswordChange) {
    return false;
  }

  return true;
}

export function buildTwoFactorGatePath(params: {
  sessionUser?: TwoFactorSessionUser | null;
  member?: TwoFactorGateMember | null;
  callbackPath?: string | null;
}) {
  const callbackUrl = getSafeInternalReturnPath(params.callbackPath) ?? "/dashboard";
  const enrolled = isSecondFactorEnrolled({
    twoFactorEnabled: params.member?.twoFactorEnabled,
    hasPasskey: params.sessionUser?.hasPasskey,
    sessionEnrolled: params.sessionUser?.twoFactorEnrolled,
  });
  const destination = enrolled ? "/login/verify" : "/login/enroll";
  const query = new URLSearchParams({ callbackUrl });
  return `${destination}?${query.toString()}`;
}
