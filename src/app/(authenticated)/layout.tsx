import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { NavBar } from "@/components/nav-bar";
import { MemberOnboardingWizard } from "@/components/member-onboarding-wizard";
import { hasActiveHutLeaderAssignment } from "@/lib/hut-leader";
import { ReportIssueWidget } from "@/components/report-issue-widget";
import { hasFinanceViewerAccess } from "@/lib/finance-auth";
import {
  MEMBER_ONBOARDING_GATE_SELECT,
  shouldShowMemberOnboarding,
} from "@/lib/member-onboarding";

export default async function AuthenticatedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();

  if (!session?.user) {
    redirect("/login");
  }

  // LODGE accounts can only access /lodge/* routes
  if (session.user.role === "LODGE") {
    redirect("/lodge/kiosk");
  }

  // Check DB directly for force password change and active status (JWT may be stale)
  const member = await prisma.member.findUnique({
    where: { id: session.user.id },
    select: MEMBER_ONBOARDING_GATE_SELECT,
  });

  // Redirect deleted/deactivated accounts even if JWT is still valid
  if (!member || !member.active) {
    redirect("/login");
  }

  if (member.forcePasswordChange) {
    redirect("/change-password");
  }

  const isHutLeaderActive =
    session.user.role === "MEMBER"
      ? await hasActiveHutLeaderAssignment(session.user.id)
      : false;

  // Check if the member is a staying guest (PAID booking where checkIn-1 <= today <= checkOut)
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  let isStayingGuest = false;
  if (session.user.role === "MEMBER" && !isHutLeaderActive) {
    const stayingBooking = await prisma.booking.findFirst({
      where: {
        memberId: session.user.id,
        status: "PAID",
        checkIn: { lte: tomorrow },
        checkOut: { gte: today },
      },
      select: { id: true },
    });
    isStayingGuest = !!stayingBooking;
  }

  const user = {
    name: session.user.name ?? "Member",
    email: session.user.email ?? "",
    role: (session.user as { role?: string }).role ?? "MEMBER",
    canAccessFinance: hasFinanceViewerAccess(member.financeAccessLevel),
    isHutLeader: isHutLeaderActive,
    isStayingGuest,
  };
  const showOnboardingWizard = shouldShowMemberOnboarding(member);

  return (
    <div className="min-h-screen flex flex-col bg-slate-50">
      <NavBar user={user} />
      <main className="flex-1 mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        {children}
      </main>
      <MemberOnboardingWizard initialShouldShow={showOnboardingWizard} />
      <ReportIssueWidget />
    </div>
  );
}
