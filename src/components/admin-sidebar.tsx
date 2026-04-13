"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useEffect } from "react";
import {
  LayoutDashboard,
  Users,
  CalendarRange,
  BookOpen,
  Clock,
  Tag,
  CheckSquare,
  ClipboardList,
  XCircle,
  BarChart2,
  RefreshCw,
  Menu,
  Mountain,
  CreditCard,
  FileText,
  Shield,
  Activity,
  Mail,
  UserCheck,
  Trash2,
  Sliders,
  House,
  Tablet,
  UsersRound,
  Bell,
  RotateCcw,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

interface NavSection {
  label?: string;
  items: Array<{ href: string; label: string; icon: typeof LayoutDashboard }>;
}

const navSections: NavSection[] = [
  {
    items: [
      { href: "/admin/dashboard", label: "Admin Dashboard", icon: LayoutDashboard },
    ],
  },
  {
    label: "Bookings & Payments",
    items: [
      { href: "/admin/bookings", label: "Bookings", icon: BookOpen },
      { href: "/admin/waitlist", label: "Waitlist", icon: Clock },
      { href: "/admin/payments", label: "Payments", icon: CreditCard },
      { href: "/admin/refund-requests", label: "Refund Appeals", icon: RotateCcw },
      { href: "/admin/reports", label: "Reports", icon: BarChart2 },
    ],
  },
  {
    label: "Lodge Operations",
    items: [
      { href: "/admin/roster", label: "Roster", icon: ClipboardList },
      { href: "/admin/chores", label: "Chores", icon: CheckSquare },
      { href: "/admin/hut-leaders", label: "Hut Leaders", icon: UserCheck },
      { href: "/admin/lodge", label: "Lodge Kiosk", icon: Tablet },
    ],
  },
  {
    label: "Members",
    items: [
      { href: "/admin/member-applications", label: "Applications", icon: ClipboardList },
      { href: "/admin/members", label: "Members", icon: Users },
      { href: "/admin/family-groups", label: "Family Groups", icon: Users },
      { href: "/admin/family-suggestions", label: "Family Suggestions", icon: Users },
      { href: "/admin/subscriptions", label: "Subscriptions", icon: FileText },
      { href: "/admin/communications", label: "Communications", icon: Mail },
    ],
  },
  {
    label: "Configuration",
    items: [
      { href: "/admin/seasons", label: "Hut Fees & Seasons", icon: CalendarRange },
      { href: "/admin/promo-codes", label: "Promo Codes", icon: Tag },
      { href: "/admin/booking-policies", label: "Booking Policies", icon: XCircle },
      { href: "/admin/age-tier-settings", label: "Age Groups", icon: Sliders },
      { href: "/admin/committee", label: "Committee", icon: UsersRound },
      { href: "/admin/xero", label: "Xero", icon: RefreshCw },
    ],
  },
  {
    label: "System",
    items: [
      { href: "/admin/notifications", label: "Notifications", icon: Bell },
      { href: "/admin/audit-log", label: "Audit Log", icon: Shield },
      { href: "/admin/deletion-requests", label: "Deletion Requests", icon: Trash2 },
      { href: "/admin/health", label: "System Health", icon: Activity },
    ],
  },
];

/** Fetch pending family group request count for sidebar badge. */
function usePendingFamilyRequests(): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/admin/family-groups/requests")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && data?.requests) {
          setCount(data.requests.length);
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
  return count;
}

function usePendingApplications(): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/admin/member-applications?status=PENDING_ADMIN")
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!cancelled) {
          setCount(data?.pendingCount ?? 0);
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, []);

  return count;
}

function usePendingRefundAppeals(): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/admin/refund-requests?status=PENDING")
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!cancelled && Array.isArray(data)) {
          setCount(data.length);
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, []);

  return count;
}

function SidebarLinks({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const pendingFamilyRequests = usePendingFamilyRequests();
  const pendingApplications = usePendingApplications();
  const pendingRefundAppeals = usePendingRefundAppeals();

  // Map href -> badge count
  const badges: Record<string, number> = {};
  if (pendingApplications > 0) {
    badges["/admin/member-applications"] = pendingApplications;
  }
  if (pendingFamilyRequests > 0) {
    badges["/admin/family-groups"] = pendingFamilyRequests;
  }
  if (pendingRefundAppeals > 0) {
    badges["/admin/refund-requests"] = pendingRefundAppeals;
  }

  return (
    <nav className="flex flex-col gap-0.5">
      <Link
        href="/dashboard"
        onClick={onNavigate}
        className="flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium transition-colors text-slate-600 hover:bg-slate-100 hover:text-slate-900"
      >
        <House className="h-4 w-4 shrink-0 text-slate-400" />
        Member Dashboard
      </Link>
      <div className="my-1.5 border-t border-slate-100" />
      {navSections.map((section, sIdx) => (
        <div key={sIdx}>
          {section.label && (
            <p className="px-3 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
              {section.label}
            </p>
          )}
          {section.items.map(({ href, label, icon: Icon }) => {
            const active =
              href === "/admin/dashboard"
                ? pathname === "/admin/dashboard"
                : pathname.startsWith(href);
            const badgeCount = badges[href];
            const badgeClasses =
              href === "/admin/refund-requests"
                ? "bg-red-600 text-white"
                : "bg-orange-500 text-white";

            return (
              <Link
                key={href}
                href={href}
                onClick={onNavigate}
                className={cn(
                  "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  active
                    ? "bg-blue-50 text-blue-700"
                    : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                )}
              >
                <Icon
                  className={cn(
                    "h-4 w-4 shrink-0",
                    active ? "text-blue-600" : "text-slate-400"
                  )}
                />
                <span className="flex-1">{label}</span>
                {badgeCount != null && badgeCount > 0 && (
                  <span className={cn("ml-auto inline-flex h-5 min-w-[20px] items-center justify-center rounded-full px-1.5 text-[11px] font-semibold", badgeClasses)}>
                    {badgeCount > 99 ? "99+" : badgeCount}
                  </span>
                )}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

export function AdminSidebar() {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="hidden w-60 shrink-0 flex-col border-r bg-white print:hidden md:flex">
        <div className="flex h-16 items-center gap-2 border-b px-4 font-bold text-slate-900">
          <Mountain className="h-5 w-5 text-blue-600" />
          <span>Admin Panel</span>
        </div>
        <div className="flex-1 overflow-y-auto p-3">
          <SidebarLinks />
        </div>
      </aside>

      {/* Mobile header bar with toggle */}
      <div className="flex h-14 items-center gap-3 border-b bg-white px-4 print:hidden md:hidden">
        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Open admin menu">
              <Menu className="h-5 w-5" />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-64 p-0">
            <SheetHeader className="flex h-16 flex-row items-center gap-2 border-b px-4">
              <Mountain className="h-5 w-5 text-blue-600" />
              <SheetTitle>Admin Panel</SheetTitle>
            </SheetHeader>
            <div className="p-3">
              <SidebarLinks onNavigate={() => setMobileOpen(false)} />
            </div>
          </SheetContent>
        </Sheet>
        <span className="font-semibold text-slate-800">Admin Panel</span>
      </div>
    </>
  );
}
