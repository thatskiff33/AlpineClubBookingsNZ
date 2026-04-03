import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import Link from "next/link";
import { SignOutButton } from "@/components/sign-out-button";

export default async function AuthenticatedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session) {
    redirect("/login");
  }

  const isAdmin = session.user.role === "ADMIN";

  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="border-b bg-white shadow-sm">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="flex h-16 items-center justify-between">
            <div className="flex items-center gap-8">
              <Link href="/dashboard" className="text-xl font-bold text-gray-900">
                TAC Bookings
              </Link>
              <div className="hidden sm:flex sm:gap-4">
                <Link href="/dashboard" className="text-sm text-gray-600 hover:text-gray-900">
                  Dashboard
                </Link>
                <Link href="/book" className="text-sm text-gray-600 hover:text-gray-900">
                  Book a Stay
                </Link>
                <Link href="/bookings" className="text-sm text-gray-600 hover:text-gray-900">
                  My Bookings
                </Link>
                {isAdmin && (
                  <Link href="/admin/dashboard" className="text-sm font-medium text-blue-600 hover:text-blue-800">
                    Admin
                  </Link>
                )}
              </div>
            </div>
            <div className="flex items-center gap-4">
              <span className="text-sm text-gray-600">{session.user.name}</span>
              <SignOutButton />
            </div>
          </div>
        </div>
      </nav>
      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        {children}
      </main>
    </div>
  );
}
