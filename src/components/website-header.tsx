"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useClubIdentity } from "@/components/club-identity-provider";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { buildBookingLoginPath } from "@/lib/auth-redirect";
import { cn } from "@/lib/utils";

interface WebsiteHeaderProps {
  isAuthenticated: boolean;
}

const navLinks = [
  { href: "/", label: "Home" },
  { href: "/about", label: "About" },
  { href: "/join", label: "Join" },
  { href: "/rules", label: "Rules" },
  { href: "/committee", label: "Committee" },
  { href: "/contact", label: "Contact" },
];

export function WebsiteHeader({ isAuthenticated }: WebsiteHeaderProps) {
  const club = useClubIdentity();
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  const isActive = (href: string) => {
    if (href === "/") return pathname === "/";
    return pathname.startsWith(href);
  };

  const bookingsHref = isAuthenticated ? "/book" : buildBookingLoginPath();
  const dashboardHref = isAuthenticated ? "/dashboard" : "/login";

  return (
    <header className="sticky top-0 z-50 w-full border-b border-brand-gold/15 bg-brand-charcoal/95 text-brand-snow shadow-[0_16px_40px_-28px_rgba(47,47,43,0.9)] backdrop-blur">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
        {/* Branding */}
        <Link
          href="/"
          className="flex items-center gap-2 font-bold text-brand-snow transition-opacity hover:opacity-85"
        >
          <Image
            src="/branding/logo.png"
            alt={club.name}
            width={140}
            height={48}
            className="h-10 w-auto"
            priority
          />
        </Link>

        {/* Desktop nav links */}
        <nav className="hidden lg:flex items-center gap-1">
          {navLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={cn(
                "rounded-md px-3 py-2 text-sm font-medium transition-colors",
                isActive(link.href)
                  ? "bg-brand-gold text-brand-charcoal shadow-sm"
                  : "text-brand-snow/80 hover:bg-brand-snow/10 hover:text-brand-snow"
              )}
            >
              {link.label}
            </Link>
          ))}
        </nav>

        {/* Desktop CTA */}
        <div className="hidden lg:flex items-center gap-3">
          {isAuthenticated ? (
            <>
              <Button
                variant="outline"
                size="sm"
                asChild
                className="border-brand-snow/20 bg-brand-snow/5 text-brand-snow hover:bg-brand-snow/10 hover:text-brand-snow"
              >
                <Link href={dashboardHref}>Dashboard</Link>
              </Button>
              <Button size="sm" asChild className="shadow-lg shadow-brand-gold/20">
                <Link href={bookingsHref}>Book Now</Link>
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="outline"
                size="sm"
                asChild
                className="border-brand-snow/20 bg-brand-snow/5 text-brand-snow hover:bg-brand-snow/10 hover:text-brand-snow"
              >
                <Link href="/login">Log In</Link>
              </Button>
              <Button size="sm" asChild className="shadow-lg shadow-brand-gold/20">
                <Link href={bookingsHref}>Book Now</Link>
              </Button>
            </>
          )}
        </div>

        {/* Mobile hamburger */}
        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="lg:hidden text-brand-snow hover:bg-brand-snow/10 hover:text-brand-snow"
              aria-label="Open menu"
            >
              <Menu className="h-5 w-5" />
            </Button>
          </SheetTrigger>
          <SheetContent
            side="right"
            className="website-theme website-mobile-menu w-72 border-brand-ridge/25"
          >
            <SheetHeader>
              <SheetTitle className="flex items-center gap-2 text-left font-heading text-brand-snow">
                <Image
                  src="/branding/logo.png"
                  alt={club.name}
                  width={120}
                  height={40}
                  className="h-8 w-auto"
                />
              </SheetTitle>
            </SheetHeader>

            <div className="mt-6 flex flex-col gap-1">
              {navLinks.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  onClick={() => setMobileOpen(false)}
                  className={cn(
                    "rounded-md px-3 py-2.5 text-sm font-medium transition-colors",
                    isActive(link.href)
                      ? "bg-brand-gold text-brand-charcoal"
                      : "text-brand-snow/85 hover:bg-brand-snow/10 hover:text-brand-snow"
                  )}
                >
                  {link.label}
                </Link>
              ))}
            </div>

            <div className="mt-6 flex flex-col gap-2 border-t border-brand-snow/10 px-3 pt-6">
              {isAuthenticated ? (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    asChild
                    className="w-full border-brand-snow/20 bg-brand-snow/5 text-brand-snow hover:bg-brand-snow/10 hover:text-brand-snow"
                  >
                    <Link href={dashboardHref} onClick={() => setMobileOpen(false)}>
                      Dashboard
                    </Link>
                  </Button>
                  <Button size="sm" asChild className="w-full shadow-lg shadow-brand-gold/20">
                    <Link href={bookingsHref} onClick={() => setMobileOpen(false)}>
                      Book Now
                    </Link>
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    asChild
                    className="w-full border-brand-snow/20 bg-brand-snow/5 text-brand-snow hover:bg-brand-snow/10 hover:text-brand-snow"
                  >
                    <Link href="/login" onClick={() => setMobileOpen(false)}>
                      Log In
                    </Link>
                  </Button>
                  <Button size="sm" asChild className="w-full shadow-lg shadow-brand-gold/20">
                    <Link href={bookingsHref} onClick={() => setMobileOpen(false)}>
                      Book Now
                    </Link>
                  </Button>
                </>
              )}
            </div>
          </SheetContent>
        </Sheet>
      </div>
    </header>
  );
}
