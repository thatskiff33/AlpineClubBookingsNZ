import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { canAccessKiosk } from "@/lib/kiosk-access";
import { hasActiveHutLeaderAssignment } from "@/lib/hut-leader";

export default async function LodgeLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();

  if (!session?.user) {
    redirect("/login");
  }

  // LODGE and ADMIN roles always have access
  if (session.user.role === "LODGE" || session.user.role === "ADMIN") {
    return <>{children}</>;
  }

  // MEMBER role: check for hut leader assignment (current or future) or staying guest (today)
  if (session.user.role === "MEMBER") {
    // Allow access if member has any active/future hut leader assignment
    const isHutLeader = await hasActiveHutLeaderAssignment(session.user.id);
    if (isHutLeader) {
      return <>{children}</>;
    }

    // Also allow if staying guest today
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const hasAccess = await canAccessKiosk(session.user.id, session.user.role, today);
    if (hasAccess) {
      return <>{children}</>;
    }
  }

  redirect("/dashboard");
}
