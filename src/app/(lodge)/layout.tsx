import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { isHutLeader } from "@/lib/hut-leader";

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

  // MEMBER role: check for active hut leader assignment (today)
  if (session.user.role === "MEMBER") {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const hasAccess = await isHutLeader(session.user.id, today);
    if (hasAccess) {
      return <>{children}</>;
    }
  }

  redirect("/dashboard");
}
