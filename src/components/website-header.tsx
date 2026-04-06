"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Menu, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
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
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  const isActive = (href: string) => {
    if (href === "/") return pathname === "/";
    return pathname.startsWith(href);
  };

  const bookingsHref = isAuthenticated
    ? "/book"
    : "https://tokoroa-alpine-club.checkfront.com/";
  const dashboardHref = isAuthenticated ? "/dashboard" : "/login";

  return (
    <header className="sticky top-0 z-50 w-full border-b bg-white/95 backdrop-blur shadow-sm">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
        {/* Branding */}
        <Link
          href="/"
          className="flex items-center gap-2 font-bold text-slate-900 hover:opacity-80 transition-opacity"
        >
          <Image
            src="/images/tac-logo.png"
            alt="Tokoroa Alpine Club"
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
                  ? "bg-blue-50 text-blue-700"
                  : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
              )}
            >
              {link.label}
            </Link>
          ))}
        </nav>

        {/* Desktop CTA */}
        <div className="hidden lg:flex items-center gap-3">
          <a
            href="https://tokoroa.org.nz/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm font-medium text-slate-600 hover:text-slate-900 transition-colors"
          >
            TAC Website
          </a>
          {isAuthenticated ? (
            <>
              <Button variant="outline" size="sm" asChild>
                <Link href={dashboardHref}>Dashboard</Link>
              </Button>
              <Button size="sm" asChild>
                <Link href={bookingsHref}>Book Now</Link>
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" size="sm" asChild>
                <Link href="/login">Log In</Link>
              </Button>
              <Button size="sm" asChild>
                <a href={bookingsHref} target="_blank" rel="noopener noreferrer">Book Now</a>
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
              className="lg:hidden"
              aria-label="Open menu"
            >
              <Menu className="h-5 w-5" />
            </Button>
          </SheetTrigger>
          <SheetContent side="right" className="w-72">
            <SheetHeader>
              <SheetTitle className="flex items-center gap-2 text-left">
                <Image
                  src="/images/tac-logo.png"
                  alt="Tokoroa Alpine Club"
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
                      ? "bg-blue-50 text-blue-700"
                      : "text-slate-700 hover:bg-slate-100"
                  )}
                >
                  {link.label}
                </Link>
              ))}
            </div>

            <div className="mt-6 border-t pt-6 flex flex-col gap-2 px-3">
              {isAuthenticated ? (
                <>
                  <Button variant="outline" size="sm" asChild className="w-full">
                    <Link href={dashboardHref} onClick={() => setMobileOpen(false)}>
                      Dashboard
                    </Link>
                  </Button>
                  <Button size="sm" asChild className="w-full">
                    <Link href={bookingsHref} onClick={() => setMobileOpen(false)}>
                      Book Now
                    </Link>
                  </Button>
                </>
              ) : (
                <>
                  <Button variant="outline" size="sm" asChild className="w-full">
                    <Link href="/login" onClick={() => setMobileOpen(false)}>
                      Log In
                    </Link>
                  </Button>
                  <Button size="sm" asChild className="w-full">
                    <a href={bookingsHref} target="_blank" rel="noopener noreferrer" onClick={() => setMobileOpen(false)}>
                      Book Now
                    </a>
                  </Button>
                </>
              )}
              <a
                href="https://tokoroa.org.nz/"
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setMobileOpen(false)}
                className="text-center text-sm font-medium text-slate-600 hover:text-slate-900 py-2 transition-colors"
              >
                Visit TAC Website
              </a>
            </div>
          </SheetContent>
        </Sheet>
      </div>
    </header>
  );
}
