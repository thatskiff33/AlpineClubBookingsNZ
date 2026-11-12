"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
import { useState } from "react";
import { Menu, Mountain, LogOut, User, ChevronDown } from "lucide-react";
import { ThemeMenuItems, ThemeSwitcher } from "@/components/theme-switcher";
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
import { isFeatureHrefVisible } from "@/config/feature-routes";
import type { FeatureFlags } from "@/config/schema";
import { FINANCE_WORKSPACE_PATH } from "@/lib/admin-permissions";
import { servedAdminPathname } from "@/lib/admin-hubs";
import { buildProfilePathWithReturnTo } from "@/lib/internal-return-path";
import { cn } from "@/lib/utils";

interface NavBarUser {
  name: string;
  email: string;
  role: string;
  canAccessAdmin?: boolean;
  canAccessFinance?: boolean;
  isHutLeader?: boolean;
  isStayingGuest?: boolean;
  /**
   * The account's User Type is Admin (`classifyAccountRecord`, the Edit Member
   * page's classification) and it is not also a club member (no `USER`): its
   * holder books from their own member login, so the bar leaves out My
   * Bookings. An Admin who is also a club member keeps it.
   */
  isAdminOnlyAccount?: boolean;
}

/**
 * Which shell is drawing the bar (#108). The staff shells — `/admin` and the
 * `/finance` workspace — leave out the member-journey links (Book, My
 * Bookings): an administrator at work reaches booking through "Book on Behalf"
 * in the sidebar. The bar never carries Who's at the lodge: it is a button on
 * the member dashboard's Lodge Kiosk card.
 */
export type NavBarSurface = "member" | "staff";

interface NavBarProps {
  user: NavBarUser;
  features: FeatureFlags;
  surface?: NavBarSurface;
}

interface NavBarLink {
  href: string;
  label: string;
  /** Left out of the bar on the staff shells (#108). */
  memberSurfaceOnly?: boolean;
  /** Left out for an Admin account that is not also a club member. */
  hiddenForAdminOnlyAccount?: boolean;
}

const memberLinks: NavBarLink[] = [
  { href: "/", label: "Home" },
  { href: "/dashboard", label: "Dashboard" },
  { href: "/book", label: "Book", memberSurfaceOnly: true },
  {
    href: "/bookings",
    label: "My Bookings",
    memberSurfaceOnly: true,
    hiddenForAdminOnlyAccount: true,
  },
  { href: "/profile", label: "Profile" },
];

const financeLink: NavBarLink = {
  href: FINANCE_WORKSPACE_PATH,
  label: "Finance",
};

/*
  The Admin link is the SHELL entrance, not a page this user is known to hold
  (#2984). Portal standing is any one of the seven areas, so a finance-only
  administrator sees this link and does not hold `overview`: `guardAdminLayout`
  refuses /admin/dashboard for them and redirects to the first area they do
  hold, which for them is /admin/payments.

  That extra hop was measured against pointing the link at
  `getFirstAccessibleAdminHref` instead, and the redirect WON. This bar is
  rendered by the member-facing shell and by the finance shell, so computing the
  destination here means BOTH of them resolve an admin destination — and
  `admin-layout-guard-adoption.test.ts` forbids exactly that symbol in a layout
  by name: admin admission logic belongs to `admin-layout-guard.ts` alone, and
  evading the census with a differently-named wrapper would be worse than the
  hop it saves.

  That reasoning was HALF WRONG when it was written, and the correction is worth
  keeping rather than quietly fixing. The census discovered `(group)/layout.tsx`
  files only, and the finance shell is `(finance)/finance/layout.tsx` — a nested
  layout it could not see at all, so the rule it was cited for did not in fact
  reach the finance half. #2975 widened the discovery to every layout under
  `src/app`, which is what makes the sentence above true of both shells instead
  of one. `admin-route-authorization-proof.test.ts` proves the hop always lands
  somewhere the same grid may actually open, for every single-area grid and
  every admin page.
*/
const adminLink = { href: "/admin/dashboard", label: "Admin" };
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
  surface: NavBarSurface = "member",
): NavBarLink[] {
  const hutLeaderLink = { href: "/lodge/kiosk", label: hutLeaderLabel };
  const links: NavBarLink[] = [
    ...memberLinks,
    ...(user.canAccessFinance &&
    isFeatureHrefVisible(FINANCE_WORKSPACE_PATH, features)
      ? [financeLink]
      : []),
    ...(features.kiosk
      ? user.isHutLeader && features.hutLeaders
        ? [hutLeaderLink]
        : user.isStayingGuest
          ? [viewLodgeLink]
          : []
      : []),
    ...(user.canAccessAdmin || user.role === "ADMIN" ? [adminLink] : []),
  ];
  return links.filter(
    (link) =>
      !(surface === "staff" && link.memberSurfaceOnly) &&
      !(user.isAdminOnlyAccount && link.hiddenForAdminOnlyAccount),
  );
}

export function NavBar({ user, features, surface = "member" }: NavBarProps) {
  const club = useClubIdentity();
  // The served form of a moved admin page's URL, the same on the server and in
  // the browser (C3 #4800): the profile link returns here. Not an admin path,
  // unchanged.
  const pathname = servedAdminPathname(usePathname());
  const [mobileOpen, setMobileOpen] = useState(false);
  const profileHref =
    pathname === "/profile"
      ? "/profile"
      : buildProfilePathWithReturnTo(pathname);

  const links = getNavBarLinks(user, features, club.hutLeaderLabel, surface);

  const isActive = (href: string) => {
    if (href === "/") return pathname === "/";
    if (href === "/dashboard") return pathname === "/dashboard";
    if (href === "/admin/dashboard") return pathname.startsWith("/admin");
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
              <DropdownMenuLabel>Theme</DropdownMenuLabel>
              <ThemeMenuItems />
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
