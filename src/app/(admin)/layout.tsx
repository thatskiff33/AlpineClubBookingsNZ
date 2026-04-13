import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { AdminSidebar } from "@/components/admin-sidebar";
import { ReportIssueWidget } from "@/components/report-issue-widget";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();

  if (!session?.user) {
    redirect("/login");
  }

  if (session.user.role !== "ADMIN") {
    redirect("/dashboard");
  }

  // Check DB directly for force password change and active status (JWT may be stale)
  const member = await prisma.member.findUnique({
    where: { id: session.user.id },
    select: { forcePasswordChange: true, active: true },
  });

  if (!member || !member.active) {
    redirect("/login");
  }

  if (member.forcePasswordChange) {
    redirect("/change-password");
  }

  return (
    <div className="min-h-screen flex flex-col bg-slate-50">
      <div className="flex flex-1">
        <AdminSidebar />
        <div className="flex flex-1 flex-col md:overflow-hidden">
          <main className="flex-1 overflow-y-auto p-6 print:overflow-visible print:p-0 md:p-8">
            {children}
          </main>
        </div>
      </div>
      <ReportIssueWidget />
    </div>
  );
}
