import type { Metadata } from "next";
import { describe, expect, it, vi } from "vitest";

// Importing a server page loads its auth and database modules, which reach for
// the Next.js runtime and a DATABASE_URL. The titles are static exports, so
// nothing here needs a session or a database.
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

/**
 * #4951 — each member-facing route names its own browser tab.
 *
 * The root layout's `generateMetadata` supplies a default (`<Club> — <Lodge>`)
 * and a template (`%s | <Club>`). A route that sets no title of its own falls
 * back to the default, so with a payment link, a login and a dashboard open, a
 * screen reader reads three identical tabs. Every route here sets a fixed
 * `title` string, which the root template turns into "<Page> | <Club>".
 *
 * Client-component pages cannot export metadata, so theirs comes from a small
 * server `layout.tsx` in the same folder.
 *
 * A fixed string, not a template object or a function of the route's data:
 * tab titles land in history and screenshots, so a token page's title never
 * carries the member's name, an amount or the token.
 */
const ROUTES: Array<[route: string, load: () => Promise<{ metadata?: Metadata }>, title: string]> = [
  ["/pay/[token]", () => import("../(public)/pay/[token]/layout"), "Pay for your booking"],
  ["/reset-password", () => import("../(public)/reset-password/layout"), "Reset your password"],
  ["/change-password", () => import("../(public)/change-password/layout"), "Change your password"],
  ["/verify-email", () => import("../(public)/verify-email/layout"), "Verify your email"],
  [
    "/confirm-email-change",
    () => import("../(public)/confirm-email-change/layout"),
    "Confirm your new email",
  ],
  ["/family-invite/[token]", () => import("../(public)/family-invite/[token]/page"), "Family group invitation"],
  [
    "/membership-cancellation/[token]",
    () => import("../(public)/membership-cancellation/[token]/page"),
    "Membership cancellation request",
  ],
  ["/nominations/[token]", () => import("../(authenticated)/nominations/[token]/page"), "Confirm a nomination"],
  ["/login", () => import("../(public)/login/page"), "Sign in"],
  ["/login/magic", () => import("../(public)/login/magic/layout"), "Sign in with your email link"],
  ["/dashboard", () => import("../(authenticated)/dashboard/page"), "Dashboard"],
  ["/bookings", () => import("../(authenticated)/bookings/page"), "My bookings"],
  ["/bookings/[id]", () => import("../(authenticated)/bookings/[id]/page"), "Booking details"],
  ["/notices/[id]", () => import("../(authenticated)/notices/[id]/page"), "Notice"],
  [
    "/lodge-instructions",
    () => import("../(authenticated)/lodge-instructions/layout"),
    "Lodge instructions",
  ],
  [
    "/booking-requests/respond/[token]",
    () => import("../(website-dynamic)/booking-requests/respond/[token]/page"),
    "Your booking quote",
  ],
  [
    "/bookings/consent/[guestId]",
    () => import("../(authenticated)/bookings/consent/[guestId]/page"),
    "Guest consent request",
  ],
  [
    "/school-bookings/confirm/[token]",
    () => import("../(website-dynamic)/school-bookings/confirm/[token]/page"),
    "Confirm your attendee list",
  ],
  [
    "/booking-requests/verify/[token]",
    () => import("../(website-dynamic)/booking-requests/verify/[token]/page"),
    "Confirm your booking request",
  ],
];

describe("member-facing routes set their own tab title (#4951)", () => {
  it.each(ROUTES)("%s is titled by the root template", async (_route, load, title) => {
    const { metadata } = await load();
    // A plain string is what the root `%s | <Club>` template wraps; anything
    // else (absent, `absolute`, a `default`) would bypass it.
    expect(metadata?.title).toBe(title);
    // The first server-page import pulls in a large module graph, which can
    // outrun the default timeout on a loaded CI shard.
  }, 30_000);

  it("no two routes share a title", () => {
    const titles = ROUTES.map(([, , title]) => title);
    expect(new Set(titles).size).toBe(titles.length);
  });
});
