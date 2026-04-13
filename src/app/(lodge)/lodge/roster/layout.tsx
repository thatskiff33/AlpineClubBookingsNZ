import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { hasActiveHutLeaderAssignment } from "@/lib/hut-leader";
import { hasAnyActiveLodgePinSession } from "@/lib/lodge-pin-session";

export default async function LodgeRosterLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();

  if (session?.user) {
    if (session.user.role === "ADMIN" || session.user.role === "LODGE") {
      return <>{children}</>;
    }

    if (
      session.user.role === "MEMBER" &&
      (await hasActiveHutLeaderAssignment(session.user.id))
    ) {
      return <>{children}</>;
    }
  }

  if (await hasAnyActiveLodgePinSession()) {
    return <>{children}</>;
  }

  redirect("/lodge/kiosk");
}
