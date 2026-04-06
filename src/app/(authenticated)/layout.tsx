import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { NavBar } from "@/components/nav-bar";

export default async function AuthenticatedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();

  if (!session?.user) {
    redirect("/login");
  }

  // Check DB directly for force password change (JWT may be stale)
  const member = await prisma.member.findUnique({
    where: { id: session.user.id },
    select: { forcePasswordChange: true },
  });

  if (member?.forcePasswordChange) {
    redirect("/change-password");
  }

  const user = {
    name: session.user.name ?? "Member",
    email: session.user.email ?? "",
    role: (session.user as { role?: string }).role ?? "MEMBER",
  };

  return (
    <div className="min-h-screen flex flex-col bg-slate-50">
      <NavBar user={user} />
      <main className="flex-1 mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        {children}
      </main>
    </div>
  );
}
