import Link from "next/link";
import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { WebsiteLogo } from "@/components/website-logo";
import { CLUB_NAME } from "@/config/club-identity";
import { buildBookingLoginPath } from "@/lib/auth-redirect";
import { listWebsiteMenuPages } from "@/lib/page-content-html";

interface WebsiteHeaderProps {
  isAuthenticated: boolean;
  logoDataUrl?: string | null;
}

const staticNavLinks = [{ href: "/contact", label: "Contact" }];

export async function WebsiteHeader({
  isAuthenticated,
  logoDataUrl,
}: WebsiteHeaderProps) {
  const dynamicPages = await listWebsiteMenuPages();
  const dynamicNavLinks = dynamicPages.map((page) => ({
    href: page.path,
    label: page.menuTitle.trim(),
  }));
  const navLinks = [
    { href: "/", label: "Home" },
    ...dynamicNavLinks,
    ...staticNavLinks,
  ];
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
          <WebsiteLogo
            label={CLUB_NAME}
            logoDataUrl={logoDataUrl}
            className="max-h-10 max-w-40"
            textClassName="max-w-48 text-brand-snow"
          />
        </Link>

        {/* Desktop nav links */}
        <nav className="hidden lg:flex items-center gap-1">
          {navLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="rounded-md px-3 py-2 text-sm font-medium text-brand-snow/80 transition-colors hover:bg-brand-snow/10 hover:text-brand-snow"
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
              <Button
                size="sm"
                asChild
                className="shadow-lg shadow-brand-gold/20"
              >
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
              <Button
                size="sm"
                asChild
                className="shadow-lg shadow-brand-gold/20"
              >
                <Link href={bookingsHref}>Book Now</Link>
              </Button>
            </>
          )}
        </div>

        {/* Mobile menu */}
        <details className="group relative lg:hidden">
          <summary
            aria-label="Open menu"
            className="flex h-9 w-9 cursor-pointer list-none items-center justify-center rounded-md text-brand-snow transition-colors hover:bg-brand-snow/10 hover:text-brand-snow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-gold [&::-webkit-details-marker]:hidden"
          >
            <Menu className="h-5 w-5" aria-hidden="true" />
          </summary>
          <div className="website-mobile-menu absolute right-0 top-12 w-72 rounded-md border border-brand-ridge/25 bg-brand-charcoal p-5 text-brand-snow shadow-2xl">
            <div className="mb-5">
              <WebsiteLogo
                label={CLUB_NAME}
                logoDataUrl={logoDataUrl}
                className="max-h-8 max-w-36"
                textClassName="text-brand-snow"
              />
            </div>
            <nav className="flex max-h-72 flex-col gap-1 overflow-y-auto">
              {navLinks.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  className="rounded-md px-3 py-2.5 text-sm font-medium text-brand-snow/85 transition-colors hover:bg-brand-snow/10 hover:text-brand-snow"
                >
                  {link.label}
                </Link>
              ))}
            </nav>
            <div className="mt-6 flex flex-col gap-2 border-t border-brand-snow/10 px-3 pt-6">
              {isAuthenticated ? (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    asChild
                    className="w-full border-brand-snow/20 bg-brand-snow/5 text-brand-snow hover:bg-brand-snow/10 hover:text-brand-snow"
                  >
                    <Link href={dashboardHref}>Dashboard</Link>
                  </Button>
                  <Button
                    size="sm"
                    asChild
                    className="w-full shadow-lg shadow-brand-gold/20"
                  >
                    <Link href={bookingsHref}>Book Now</Link>
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
                    <Link href="/login">Log In</Link>
                  </Button>
                  <Button
                    size="sm"
                    asChild
                    className="w-full shadow-lg shadow-brand-gold/20"
                  >
                    <Link href={bookingsHref}>Book Now</Link>
                  </Button>
                </>
              )}
            </div>
          </div>
        </details>
      </div>
    </header>
  );
}
