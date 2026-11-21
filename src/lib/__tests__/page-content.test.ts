import { describe, expect, it } from "vitest";
import {
  canDeletePage,
  canUnpublishPage,
  isBuiltinPageSlug,
  isReservedPageSlug,
  isValidPageSlug,
  normalizePageSlug,
  toPagePath,
} from "@/lib/page-content";
import { isPublicWebsitePath } from "@/lib/public-website-paths";

describe("normalizePageSlug", () => {
  it("trims, lowercases, and strips surrounding slashes", () => {
    expect(normalizePageSlug("  /Trip-Reports/  ")).toBe("trip-reports");
  });

  it("collapses repeated slashes between segments", () => {
    expect(normalizePageSlug("join//apply")).toBe("join/apply");
  });
});

describe("isValidPageSlug", () => {
  it("accepts single-segment slugs", () => {
    expect(isValidPageSlug("trip-reports")).toBe(true);
    expect(isValidPageSlug("about")).toBe(true);
    expect(isValidPageSlug("2026-agm")).toBe(true);
  });

  it("accepts multi-segment slugs", () => {
    expect(isValidPageSlug("join/apply")).toBe(true);
    expect(isValidPageSlug("trips/2026/ruapehu")).toBe(true);
  });

  it("rejects malformed slugs", () => {
    expect(isValidPageSlug("")).toBe(false);
    expect(isValidPageSlug("Trip-Reports")).toBe(false);
    expect(isValidPageSlug("-leading")).toBe(false);
    expect(isValidPageSlug("trailing-")).toBe(false);
    expect(isValidPageSlug("/leading-slash")).toBe(false);
    expect(isValidPageSlug("trailing-slash/")).toBe(false);
    expect(isValidPageSlug("two//slashes")).toBe(false);
    expect(isValidPageSlug("has space")).toBe(false);
    expect(isValidPageSlug("under_score")).toBe(false);
  });
});

describe("isReservedPageSlug", () => {
  it("rejects reserved names as a whole slug", () => {
    expect(isReservedPageSlug("admin")).toBe(true);
    expect(isReservedPageSlug("api")).toBe(true);
    expect(isReservedPageSlug("login")).toBe(true);
  });

  it("rejects reserved names in any segment position", () => {
    expect(isReservedPageSlug("admin/settings")).toBe(true);
    expect(isReservedPageSlug("api/pages")).toBe(true);
    expect(isReservedPageSlug("trips/book")).toBe(true);
  });

  it("allows non-reserved slugs, including code-backed page slugs", () => {
    expect(isReservedPageSlug("about")).toBe(false);
    expect(isReservedPageSlug("join/apply")).toBe(false);
    expect(isReservedPageSlug("contact")).toBe(false);
    expect(isReservedPageSlug("home")).toBe(false);
    expect(isReservedPageSlug("rules")).toBe(false);
    expect(isReservedPageSlug("privacy")).toBe(false);
    expect(isReservedPageSlug("terms")).toBe(false);
    expect(isReservedPageSlug("faq")).toBe(false);
  });

  it("leaves work-parties to the website: the member page lives under /dashboard (#5148)", () => {
    // Owner decision, 15 Nov 2026: the app does not reserve `/work-parties`,
    // so a club can publish (or keep) a working-bee page at that address.
    expect(isReservedPageSlug("work-parties")).toBe(false);
    expect(isReservedPageSlug("work-parties/spring-2026")).toBe(false);
    expect(isPublicWebsitePath("/work-parties")).toBe(true);
    // The member page is under a root the app already owns.
    expect(isReservedPageSlug("dashboard/work-parties/wp-1")).toBe(true);
  });
});

describe("toPagePath", () => {
  it("prefixes the slug with a slash", () => {
    expect(toPagePath("about")).toBe("/about");
    expect(toPagePath("join/apply")).toBe("/join/apply");
  });
});

describe("isBuiltinPageSlug", () => {
  it("recognises seeded, code-linked pages", () => {
    expect(isBuiltinPageSlug("home")).toBe(true);
    expect(isBuiltinPageSlug("about")).toBe(true);
    expect(isBuiltinPageSlug("join/apply")).toBe(true);
    expect(isBuiltinPageSlug("committee")).toBe(true);
    expect(isBuiltinPageSlug("privacy")).toBe(true);
    expect(isBuiltinPageSlug("terms")).toBe(true);
    expect(isBuiltinPageSlug("faq")).toBe(true);
    expect(isBuiltinPageSlug("booking-requests")).toBe(true);
    expect(isBuiltinPageSlug("school-bookings")).toBe(true);
  });

  it.each(["booking-requests", "school-bookings"])(
    "treats %s as a built-in page whose whole namespace is code-owned",
    (slug) => {
      // Code-backed `(website-dynamic)` pages whose seeded bodies are their
      // {{...}} tokens. Built-in keeps the rows from being hidden or deleted;
      // RESERVED keeps an admin from creating a CMS page anywhere in the
      // namespace, because the emailed one-time token links live one segment
      // below (#2818 decision 9).
      expect(isBuiltinPageSlug(slug)).toBe(true);
      expect(isReservedPageSlug(slug)).toBe(true);
      expect(canUnpublishPage(slug)).toBe(false);
      expect(canDeletePage(slug)).toBe(false);
    },
  );

  it.each([
    // The bare addresses.
    "booking-requests",
    "school-bookings",
    // One segment above the emailed credential URLs — the shape the review
    // found creatable, and the reason a WORD is reserved rather than the exact
    // addresses real routes happen to claim.
    "booking-requests/verify",
    "booking-requests/respond",
    "school-bookings/confirm",
    // Deeper still, and in a non-leading position.
    "booking-requests/verify/anything",
    "school-bookings/confirm/anything/else",
    "trips/booking-requests",
  ])("refuses %s as an admin-created CMS page", (slug) => {
    expect(isValidPageSlug(slug), "the slug is otherwise well-formed").toBe(true);
    expect(isReservedPageSlug(slug)).toBe(true);
  });

  it("does not match admin-created pages", () => {
    expect(isBuiltinPageSlug("trip-reports")).toBe(false);
    expect(isBuiltinPageSlug("2026-agm")).toBe(false);
  });
});

describe("canUnpublishPage", () => {
  it("allows hiding only admin-created pages", () => {
    expect(canUnpublishPage("trip-reports")).toBe(true);
    expect(canUnpublishPage("2026-agm")).toBe(true);
  });

  it("never allows hiding system or built-in pages", () => {
    expect(canUnpublishPage("home")).toBe(false);
    expect(canUnpublishPage("404")).toBe(false);
    expect(canUnpublishPage("about")).toBe(false);
    expect(canUnpublishPage("join/apply")).toBe(false);
    expect(canUnpublishPage("contact")).toBe(false);
    expect(canUnpublishPage("privacy")).toBe(false);
    expect(canUnpublishPage("terms")).toBe(false);
    expect(canUnpublishPage("faq")).toBe(false);
    expect(canUnpublishPage("booking-requests")).toBe(false);
    expect(canUnpublishPage("school-bookings")).toBe(false);
  });
});

/*
  #2352 MC-03D, decision D-B3(a). Deletion is defined as "exactly what may be
  hidden", so what needs pinning is not a second list of slugs — it is the
  RELATIONSHIP. The property test below is the one that matters: if a later
  change gives `canDeletePage` a list of its own and that list lets go of one
  protected slug, the property fails even though every hand-written example
  below still passes.
*/
describe("canDeletePage", () => {
  // Every slug either predicate has an opinion about, plus admin-created
  // examples and the shapes a caller might arrive with.
  const EVERY_KNOWN_SLUG = [
    // system
    "home",
    "404",
    // built-in design pages
    "about",
    "join",
    "join/apply",
    "rules",
    "contact",
    "committee",
    "privacy",
    "terms",
    "faq",
    "booking-requests",
    "school-bookings",
    // admin-created
    "trip-reports",
    "2026-agm",
    "trips/hut-leader-instructions",
    "news",
    // odd shapes a caller could pass
    "",
    "HOME",
    "home/",
  ];

  it("is never wider than hiding, for any slug", () => {
    const wider = EVERY_KNOWN_SLUG.filter(
      (slug) => canDeletePage(slug) && !canUnpublishPage(slug),
    );

    expect(
      wider,
      "a page that may be DELETED but not merely HIDDEN would be a hole: " +
        "deleting is the more destructive of the two",
    ).toEqual([]);
  });

  it("allows deleting admin-created pages", () => {
    expect(canDeletePage("trip-reports")).toBe(true);
    expect(canDeletePage("2026-agm")).toBe(true);
  });

  it("refuses the system pages the site itself renders", () => {
    expect(canDeletePage("home")).toBe(false);
    expect(canDeletePage("404")).toBe(false);
  });

  it("refuses every built-in page a code route serves", () => {
    // Not "the sitemap links them": `booking-requests` and `school-bookings`
    // are in neither the sitemap nor the footer, and are unlisted by default
    // (#2818 decision 1). What makes all of these undeletable is that a code
    // route reads each row, so deleting one leaves a live address with nothing
    // behind it.
    for (const slug of [
      "about",
      "join",
      "join/apply",
      "rules",
      "contact",
      "committee",
      "privacy",
      "terms",
      "faq",
      "booking-requests",
      "school-bookings",
    ]) {
      expect(canDeletePage(slug), `${slug} must not be deletable`).toBe(false);
    }
  });
});
