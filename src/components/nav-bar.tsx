"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
import { useState } from "react";
import { Menu, Mountain, LogOut, User, ChevronDown } from "lucide-react";
import { ThemeSwitcher } from "@/components/theme-switcher";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { useClubIdentity } from "@/components/club-identity-provider";
import type { FeatureFlags } from "@/config/schema";
import { buildProfilePathWithReturnTo } from "@/lib/internal-return-path";
import { cn } from "@/lib/utils";

interface NavBarUser {
  name: string;
  email: string;
  role: string;
  canAccessAdmin?: boolean;
  /**
   * Where the Admin link points for THIS user (#2984). The portal shell admits
   * anyone holding one of the seven admin areas, and that no longer implies
   * `overview` — a finance-only administrator has standing but cannot view
   * `/admin/dashboard`, so a hard-coded dashboard link would bounce them
   * through `guardAdminLayout` on every click. The server computes this with
   * `getFirstAccessibleAdminHref`, which is the very destination that guard
   * would have redirected them to. It is a convenience, never a permission:
   * the target page re-runs the whole admission preamble regardless.
   */
  adminHref?: string;
  canAccessFinance?: boolean;
  isHutLeader?: boolean;
  isStayingGuest?: boolean;
}

interface NavBarProps {
  user: NavBarUser;
  features: FeatureFlags;
}

const memberLinks = [
  { href: "/", label: "Home" },
  { href: "/dashboard", label: "Dashboard" },
  { href: "/book", label: "Book" },
  { href: "/bookings", label: "My Bookings" },
  { href: "/profile", label: "Profile" },
];

const financeLink = { href: "/finance", label: "Finance" };
export const DEFAULT_ADMIN_LINK_HREF = "/admin/dashboard";
const viewLodgeLink = { href: "/lodge/kiosk", label: "View Lodge" };

// test seam
export function getAuthenticatedBrandHref() {
  return "/dashboard";
}

// test seam
export function getNavBarLinks(
  user: NavBarUser,
  features: FeatureFlags,
  hutLeaderLabel = "Hut Leader",
) {
  const hutLeaderLink = { href: "/lodge/kiosk", label: hutLeaderLabel };
  return [
    ...memberLinks,
    ...(user.canAccessFinance && features.financeDashboard ? [financeLink] : []),
    ...(features.kiosk
      ? user.isHutLeader && features.hutLeaders
        ? [hutLeaderLink]
        : user.isStayingGuest
          ? [viewLodgeLink]
          : []
      : []),
    ...(user.canAccessAdmin || user.role === "ADMIN"
      ? [{ href: user.adminHref ?? DEFAULT_ADMIN_LINK_HREF, label: "Admin" }]
      : []),
  ];
}

export function NavBar({ user, features }: NavBarProps) {
  const club = useClubIdentity();
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const profileHref =
    pathname === "/profile"
      ? "/profile"
      : buildProfilePathWithReturnTo(pathname);

  const links = getNavBarLinks(user, features, club.hutLeaderLabel);

  const isActive = (href: string) => {
    if (href === "/") return pathname === "/";
    if (href === "/dashboard") return pathname === "/dashboard";
    // Any admin destination lights the one Admin tab; the href varies by which
    // areas the user holds (#2984), so this matches the section, not a page.
    if (href.startsWith("/admin")) return pathname.startsWith("/admin");
    return pathname.startsWith(href);
  };

  return (
    <header className="sticky top-0 z-50 w-full border-b bg-background shadow-sm print:hidden">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
        {/* Branding */}
        <Link
          href={getAuthenticatedBrandHref()}
          className="flex items-center gap-2 font-bold text-foreground transition-shadow hover:drop-shadow-sm"
        >
          <span className="app-brand-mark h-9 w-9">
            <Mountain className="h-5 w-5" />
          </span>
          <span className="hidden sm:block">{club.bookingsName}</span>
          <span className="sm:hidden text-sm">{club.name}</span>
        </Link>

        {/* Desktop nav links */}
        <nav aria-label="Primary" className="hidden md:flex items-center gap-1">
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={cn(
                "rounded-md px-3 py-2 text-sm font-medium transition-colors",
                isActive(link.href)
                  ? "app-nav-link-active"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              )}
            >
              {link.label}
            </Link>
          ))}
        </nav>

        {/* Desktop user menu */}
        <div className="hidden md:flex items-center gap-3">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="gap-2">
                <User className="h-4 w-4" />
                <span className="max-w-[140px] truncate">{user.name}</span>
                <ChevronDown className="h-3 w-3 opacity-60" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel className="font-normal">
                <div className="flex flex-col space-y-1">
                  <p className="text-sm font-medium leading-none">{user.name}</p>
                  <p className="text-xs leading-none text-muted-foreground">
                    {user.email}
                  </p>
                </div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem asChild>
                <Link href={profileHref}>
                  <User className="mr-2 h-4 w-4" />
                  Profile
                </Link>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <div className="px-2 py-1.5">
                <ThemeSwitcher />
              </div>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="cursor-pointer text-danger-11 focus:bg-danger-3 focus:text-danger-11"
                onClick={() => signOut({ callbackUrl: "/login" })}
              >
                <LogOut className="mr-2 h-4 w-4" />
                Log out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Mobile hamburger */}
        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="md:hidden"
              aria-label="Open menu"
            >
              <Menu className="h-5 w-5" />
            </Button>
          </SheetTrigger>
          <SheetContent side="right" className="w-72">
            <SheetHeader>
              <SheetTitle className="flex items-center gap-2 text-left">
                <span className="app-brand-mark h-8 w-8">
                  <Mountain className="h-4 w-4" />
                </span>
                {club.name}
              </SheetTitle>
            </SheetHeader>

            <div className="mt-6 flex flex-col gap-1">
              {links.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  onClick={() => setMobileOpen(false)}
                  className={cn(
                    "rounded-md px-3 py-2.5 text-sm font-medium transition-colors",
                    isActive(link.href)
                      ? "app-nav-link-active"
                      : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                  )}
                >
                  {link.label}
                </Link>
              ))}
            </div>

            <div className="mt-6 border-t pt-6">
              <div className="mb-3 px-3">
                <p className="text-sm font-medium text-foreground">{user.name}</p>
                <p className="text-xs text-muted-foreground">{user.email}</p>
              </div>
              <Link
                href={profileHref}
                onClick={() => setMobileOpen(false)}
                className="flex items-center gap-2 rounded-md px-3 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
              >
                <User className="h-4 w-4" />
                Profile
              </Link>
              <div className="mt-4 px-3">
                <ThemeSwitcher />
              </div>
              <button
                onClick={() => {
                  setMobileOpen(false);
                  signOut({ callbackUrl: "/login" });
                }}
                className="mt-4 flex w-full items-center gap-2 rounded-md px-3 py-2.5 text-sm font-medium text-danger-11 transition-colors hover:bg-danger-3"
              >
                <LogOut className="h-4 w-4" />
                Log out
              </button>
            </div>
          </SheetContent>
        </Sheet>
      </div>
    </header>
  );
}
