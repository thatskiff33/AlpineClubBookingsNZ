import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requireActiveSessionUser } from "@/lib/session-guards";
import {
  MEMBER_ONBOARDING_PROFILE_SELECT,
  getMemberOnboardingStatus,
} from "@/lib/member-onboarding";
import { getMissingMemberProfileFieldDetails } from "@/lib/member-profile-completeness";

export async function POST() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const member = await prisma.member.findUnique({
    where: { id: session.user.id },
    select: MEMBER_ONBOARDING_PROFILE_SELECT,
  });

  if (!member) {
    return NextResponse.json({ error: "Member not found" }, { status: 404 });
  }

  if (!member.active || !member.canLogin || member.role === "LODGE") {
    return NextResponse.json(
      { error: "Onboarding confirmation is only available to active login-capable members" },
      { status: 403 }
    );
  }

  const status = getMemberOnboardingStatus(member);
  if (!status.isProfileComplete) {
    return NextResponse.json(
      {
        error: "Complete your required profile details before confirming",
        missingFields: status.missingFields,
        missingFieldDetails: getMissingMemberProfileFieldDetails(status.missingFields),
      },
      { status: 422 }
    );
  }

  const now = new Date();
  const hasSelfDetailsConfirmation = status.isDetailsConfirmed;

  const updated = await prisma.member.update({
    where: { id: member.id },
    data: {
      profileCompletedAt: member.profileCompletedAt ?? now,
      detailsConfirmedAt: hasSelfDetailsConfirmation
        ? member.detailsConfirmedAt
        : now,
      detailsConfirmedByMemberId: hasSelfDetailsConfirmation
        ? member.detailsConfirmedByMemberId
        : member.id,
      onboardingConfirmedAt: member.onboardingConfirmedAt ?? now,
    },
    select: MEMBER_ONBOARDING_PROFILE_SELECT,
  });

  const updatedStatus = getMemberOnboardingStatus(updated);

  return NextResponse.json({
    ok: true,
    shouldShow: updatedStatus.requiresWizard,
    currentMember: {
      id: updated.id,
      status: {
        ...updatedStatus,
        missingFieldDetails: getMissingMemberProfileFieldDetails(
          updatedStatus.missingFields
        ),
      },
    },
  });
}
