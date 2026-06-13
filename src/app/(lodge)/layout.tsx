import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AppProviders } from "@/components/app-providers";
import { auth } from "@/lib/auth";
import { clubIdentity } from "@/config/club-identity";
import { CSP_NONCE_HEADER } from "@/lib/csp";
import { getLodgeCapacity } from "@/lib/lodge-capacity";
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

  const lodgeCapacity = await getLodgeCapacity();
  const liveClubIdentity = { ...clubIdentity, lodgeCapacity };
  const nonce = (await headers()).get(CSP_NONCE_HEADER) ?? undefined;

  return (
    <AppProviders clubIdentity={liveClubIdentity} nonce={nonce}>
      <div className="app-theme-scope min-h-screen bg-background text-foreground">
        {children}
      </div>
    </AppProviders>
  );
}
