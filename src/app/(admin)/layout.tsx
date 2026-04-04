import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { AdminSidebar } from "@/components/admin-sidebar";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();

  if (!session?.user) {
    redirect("/login");
  }

  const role = (session.user as { role?: string }).role;
  if (role !== "ADMIN") {
    redirect("/dashboard");
  }

  return (
    <div className="min-h-screen flex flex-col bg-slate-50">
      <div className="flex flex-1">
        <AdminSidebar />
        <div className="flex flex-1 flex-col md:overflow-hidden">
          <main className="flex-1 overflow-y-auto p-6 md:p-8">{children}</main>
        </div>
      </div>
    </div>
  );
}
