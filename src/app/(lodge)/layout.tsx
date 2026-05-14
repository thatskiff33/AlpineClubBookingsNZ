import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export default async function LodgeLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();

  if (!session?.user) {
    redirect(`/login?callbackUrl=${encodeURIComponent("/lodge/kiosk")}`);
  }

  const member = await prisma.member.findUnique({
    where: { id: session.user.id },
    select: {
      active: true,
      forcePasswordChange: true,
    },
  });

  if (!member?.active) {
    redirect("/login");
  }

  if (member.forcePasswordChange) {
    redirect("/change-password");
  }

  return <>{children}</>;
}
