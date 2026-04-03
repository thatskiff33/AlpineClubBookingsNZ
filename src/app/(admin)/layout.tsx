import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import Link from "next/link"

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const session = await auth()

  if (!session?.user) {
    redirect("/login")
  }

  if ((session.user as any).role !== "ADMIN") {
    redirect("/dashboard")
  }

  return (
    <div className="min-h-screen bg-background">
      <nav className="border-b bg-card">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex h-16 items-center justify-between">
            <div className="flex items-center space-x-8">
              <Link href="/admin/dashboard" className="text-lg font-bold">
                TAC Admin
              </Link>
              <div className="hidden md:flex space-x-4">
                <Link
                  href="/admin/seasons"
                  className="text-sm text-muted-foreground hover:text-foreground"
                >
                  Seasons & Rates
                </Link>
                <Link
                  href="/admin/cancellation-policy"
                  className="text-sm text-muted-foreground hover:text-foreground"
                >
                  Cancellation Policy
                </Link>
                <Link
                  href="/admin/members"
                  className="text-sm text-muted-foreground hover:text-foreground"
                >
                  Members
                </Link>
                <Link
                  href="/admin/bookings"
                  className="text-sm text-muted-foreground hover:text-foreground"
                >
                  Bookings
                </Link>
              </div>
            </div>
            <div className="text-sm text-muted-foreground">
              {session.user.name}
            </div>
          </div>
        </div>
      </nav>
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {children}
      </main>
    </div>
  )
}
