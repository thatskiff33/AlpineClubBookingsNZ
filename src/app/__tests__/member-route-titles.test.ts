import { existsSync } from "node:fs";
import type { Metadata } from "next";
import { describe, expect, it, vi } from "vitest";
import {
  filesUnder,
  MEMBER_FACING_ROOTS,
  read,
} from "@/components/ui/__tests__/support/card-title-source";
import { blankLiterals } from "@/lib/__tests__/support/strip-comments";

// Importing a server page loads its auth and database modules, which reach for
// the Next.js runtime and a DATABASE_URL. The titles are static exports, so
// nothing here needs a session or a database.
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

/**
 * #4951, #5217 — each member-facing route names its own browser tab.
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
  ["/profile", () => import("../(authenticated)/profile/layout"), "Profile"],
  ["/book", () => import("../(authenticated)/book/layout"), "Book a stay"],
  ["/induction", () => import("../(authenticated)/induction/layout"), "Lodge induction"],
  [
    "/maintenance-report",
    () => import("../(authenticated)/maintenance-report/layout"),
    "Report a maintenance issue",
  ],
  ["/forgot-password", () => import("../(public)/forgot-password/layout"), "Forgot your password"],
  ["/register", () => import("../(public)/register/page"), "Register"],
  ["/login/verify", () => import("../(public)/login/verify/page"), "Verify your sign-in"],
  [
    "/login/enroll",
    () => import("../(public)/login/enroll/page"),
    "Set up two-factor authentication",
  ],
  ["/chores/[token]", () => import("../(public)/chores/[token]/layout"), "Your chores"],
];

describe("member-facing routes set their own tab title (#4951, #5217)", () => {
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

/**
 * The table above pins what each title SAYS; this pins that none is MISSING.
 * A page that sets no title falls back to the club's default, the defect #4951
 * and #5217 swept out of these roots, and nothing else fails when a new page
 * forgets one. A layout counts only when it sits beside the page: one further
 * up would give several screens the same title.
 *
 * It reads source, so it cannot tell that a `generateMetadata` returns a title
 * on every path. A page that needs one adds a `ROUTES` row or its own test.
 *
 * It reads source with comments and string contents blanked (INV-SSOT-004), so
 * an example in a docblock never counts. A `title:` counts only at the top
 * level of the `metadata` object: `openGraph: { title }` is not a tab title,
 * and a nested object ahead of the real `title:` (`robots: { index: false }`)
 * does not hide it.
 */
function setsATitle(source: string): boolean {
  const code = blankLiterals(source);
  if (/^export (?:async )?function generateMetadata\b/m.test(code)) return true;
  const start = /^export const metadata\b[^=]*=\s*\{/m.exec(code);
  if (!start) return false;
  // Keep only the characters at the object's own depth, so nested objects drop out.
  let depth = 1;
  let topLevel = "";
  for (let i = start.index + start[0].length; i < code.length && depth > 0; i++) {
    const ch = code[i];
    if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") depth--;
    else if (depth === 1) topLevel += ch;
  }
  return /(?:^|[\s,])title\s*:/.test(topLevel);
}

describe("no member-facing page falls back to the default tab title (#5217)", () => {
  const pages = MEMBER_FACING_ROOTS.flatMap((root) =>
    filesUnder(root.replace(/\/$/, ""), /^page\.tsx$/, true)
  );

  it("every page sets a title itself or through a layout beside it", () => {
    const untitled = pages.filter((page) => {
      const layout = page.replace(/page\.tsx$/, "layout.tsx");
      return (
        !setsATitle(read(page)) &&
        !(existsSync(layout) && setsATitle(read(layout)))
      );
    });
    expect(
      untitled,
      "Give each of these pages a fixed tab title: `export const metadata` " +
        "with a `title` string in the page, or in a server `layout.tsx` " +
        "beside it when the page is a client component (INV-PUB-006):\n" +
        untitled.join("\n")
    ).toEqual([]);
  });

  // The check above is only as good as `setsATitle`, so each way a raw-source
  // scan used to be wrong is pinned here against synthetic source.
  it.each([
    ["a plain metadata title", 'export const metadata = { title: "Profile" };', true],
    [
      "a typed, multi-line metadata block",
      'export const metadata: Metadata = {\n  title: "Profile",\n};',
      true,
    ],
    [
      "a title after a nested object",
      'export const metadata = { robots: { index: false }, title: "Profile" };',
      true,
    ],
    ["generateMetadata", "export async function generateMetadata() { return {}; }", true],
    [
      "a title only inside openGraph",
      'export const metadata = { openGraph: { title: "Profile" } };',
      false,
    ],
    [
      "a metadata line that sits inside a block comment",
      '/*\nexport const metadata = { title: "Profile" };\n*/\nexport default function Page() {}',
      false,
    ],
    [
      "a title that appears only in a string value",
      'export const metadata = { description: "title: not a key" };',
      false,
    ],
    ["no metadata at all", "export default function Page() { return null; }", false],
  ])("setsATitle: %s", (_name, source, expected) => {
    expect(setsATitle(source)).toBe(expected);
  });

  it("scans a tree that actually contains member pages", () => {
    // A census that silently finds nothing passes for the wrong reason.
    for (const root of MEMBER_FACING_ROOTS) {
      expect(pages.some((page) => page.startsWith(root))).toBe(true);
    }
  });
});
