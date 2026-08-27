import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  getContextualHelp,
  getContextualHelpPaths,
} from "@/lib/contextual-help";
import { getHelpForPage, getHelpPaths } from "@/lib/help";
import { buildHelpGrounding } from "@/lib/help/grounding";
import { BOOK_WIZARD_STEP_IDS } from "@/lib/help/member-help";
import type { HelpPageContent, HelpSurface } from "@/lib/help/types";

function collectText(content: HelpPageContent): string {
  const parts: string[] = [content.title, content.summary, ...content.actions];
  for (const field of content.fields ?? []) {
    parts.push(field.name, field.description);
  }
  for (const section of content.sections ?? []) {
    parts.push(section.title, ...section.details);
  }
  parts.push(...(content.notes ?? []));
  for (const question of content.questions ?? []) {
    parts.push(question.q, question.a);
    if (question.link) {
      parts.push(question.link.label, question.link.href);
    }
  }
  return parts.join("\n");
}

describe("admin/finance parity with the existing registry", () => {
  it("returns the identical content object for every admin path", () => {
    for (const path of getContextualHelpPaths("admin")) {
      expect(getHelpForPage("admin", path)).toBe(
        getContextualHelp(path, "admin"),
      );
    }
  });

  it("returns the identical content object for every finance path", () => {
    for (const path of getContextualHelpPaths("finance")) {
      expect(getHelpForPage("finance", path)).toBe(
        getContextualHelp(path, "finance"),
      );
    }
  });

  it("exposes the same paths through getHelpPaths", () => {
    expect(getHelpPaths("admin")).toEqual(getContextualHelpPaths("admin"));
    expect(getHelpPaths("finance")).toEqual(getContextualHelpPaths("finance"));
  });
});

describe("member guide parity", () => {
  const MEMBER_GUIDE_DIR = join(process.cwd(), "docs", "user-guide");

  // Every member guide is distilled into at least one corpus entry, and this is
  // where each one says which. docs/user-guide/README.md is the standing
  // instruction: change a guide, review the matching corpus entry in the same
  // pull request.
  const GUIDE_TO_MEMBER_PATH: Record<string, string> = {
    "booking-a-stay.md": "/book",
    "paying-for-your-stay.md": "/bookings/abc123",
    "waitlist-and-offers.md": "/bookings",
    "changing-or-cancelling-a-booking.md": "/bookings/abc123",
    "your-account.md": "/profile",
    "managing-your-family.md": "/profile",
    "joining-the-club.md": "/dashboard",
    // "+ Add Member Guest" (epic #2305, MG2 #2307): the consent card lives on
    // the booking's own page, so the answers are distilled into that entry.
    "being-added-to-a-booking.md": "/bookings/abc123",
    "the-message-board.md": "/message-board",
  };

  // Files in docs/user-guide/ that are deliberately NOT member guides. Keep this
  // list tiny and justify each entry — everything not named here must be mapped.
  const NOT_A_GUIDE = new Set([
    // The folder's own index page: it explains how the guides are written and
    // links to them, and distils into no single help entry.
    "README.md",
  ]);

  function memberGuideFiles(): string[] {
    return readdirSync(MEMBER_GUIDE_DIR)
      .filter((name) => name.endsWith(".md"))
      .filter((name) => !NOT_A_GUIDE.has(name))
      .sort();
  }

  // THE GUARD ONLY WORKS IF IT ENUMERATES THE FOLDER. Iterating the hand-written
  // map alone can never notice a guide that was added without a row — which is
  // exactly what happened when being-added-to-a-booking.md landed — so the map is
  // checked against what is actually on disk before it is used.
  it("has a row for every member guide in docs/user-guide, and no stale rows", () => {
    const onDisk = memberGuideFiles();
    const mapped = Object.keys(GUIDE_TO_MEMBER_PATH).sort();
    expect(
      mapped,
      "add the new guide to GUIDE_TO_MEMBER_PATH (or to NOT_A_GUIDE, with a reason) " +
        "and distil it into a member help entry in the same pull request",
    ).toEqual(onDisk);
  });

  it("maps every guide to an existing member entry with at least 3 questions", () => {
    for (const guide of memberGuideFiles()) {
      const helpPath = GUIDE_TO_MEMBER_PATH[guide];
      expect(helpPath, `${guide} has no GUIDE_TO_MEMBER_PATH row`).toBeDefined();
      const content = getHelpForPage("member", helpPath);
      expect(
        content.title,
        `${guide} -> ${helpPath} should not be the fallback`,
      ).not.toBe("Member help");
      expect(
        content.questions?.length ?? 0,
        `${guide} -> ${helpPath} needs >= 3 questions`,
      ).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("question integrity across all surfaces", () => {
  const surfaces: HelpSurface[] = ["public", "member", "admin", "finance"];

  it("every question has non-empty q and a", () => {
    for (const surface of surfaces) {
      const paths = [...getHelpPaths(surface), "/definitely-not-a-real-page"];
      for (const path of paths) {
        const content = getHelpForPage(surface, path);
        for (const question of content.questions ?? []) {
          expect(question.q.trim().length, `${surface} ${path}`).toBeGreaterThan(0);
          expect(question.a.trim().length, `${surface} ${path}`).toBeGreaterThan(0);
        }
      }
    }
  });

  it("every /book question is tagged with a real wizard step id", () => {
    const content = getHelpForPage("member", "/book");
    const groups = (content.questions ?? []).map((question) => question.group);
    expect(groups.length).toBeGreaterThan(0);
    for (const group of groups) {
      expect(group, "each /book question needs a group").toBeDefined();
      expect(BOOK_WIZARD_STEP_IDS).toContain(group);
    }
  });
});

describe("public corpus hygiene", () => {
  const CLUB_PROPER_NOUNS = /tokoroa|LWTC|hoppers|example mountain/i;
  const AI_WORDING = /\bAI\b|assistant/i;
  // #2421, and it SURVIVES the form becoming a real editable page (#2818
  // decision 1). Advertising the guest request form is opt-in per club: the page
  // ships with an empty menu title, so by default nothing links to it and search
  // engines are told to ignore it. This corpus is the same text for every
  // deployment and cannot know which choice a club made — so naming the form
  // would be wrong for every club that left the default, and redundant for a
  // club that opted in, since the form is then in its own site menu. Whether the
  // club hosts non-members at all is its own policy either way, so the copy
  // defers to the club's FAQ/rules/policy pages. The FAQ question "Can I stay
  // without being a member?" is deliberately still allowed: asking the question
  // is not advertising an answer.
  const ADVERTISES_GUEST_BOOKING =
    /without an account|booking-requests|request a booking/i;

  it("never names a specific club and never mentions AI or an assistant", () => {
    const contents = [
      getHelpForPage("public", "/"),
      getHelpForPage("public", "/an-unknown-public-page"),
    ];
    for (const content of contents) {
      const text = collectText(content);
      expect(text).not.toMatch(CLUB_PROPER_NOUNS);
      expect(text).not.toMatch(AI_WORDING);
    }
  });

  it("never advertises the guest request form, whose listing is the club's choice", () => {
    const paths = [...getHelpPaths("public"), "/an-unknown-public-page"];
    for (const path of paths) {
      const text = collectText(getHelpForPage("public", path));
      expect(text, `public ${path}`).not.toMatch(ADVERTISES_GUEST_BOOKING);
    }
  });
});

describe("/x/* detail matcher", () => {
  it("routes a detail path to the /bookings/* entry", () => {
    expect(getHelpForPage("member", "/bookings/abc123").title).toBe("Your booking");
  });

  it("routes the bare list path to the /bookings entry", () => {
    expect(getHelpForPage("member", "/bookings").title).toBe("My Bookings");
  });

  it("keeps distinguishing list from detail after trailing-slash normalisation", () => {
    expect(getHelpForPage("member", "/bookings/").title).toBe("My Bookings");
    expect(getHelpForPage("member", "/bookings/abc123?tab=guests").title).toBe(
      "Your booking",
    );
  });

  it("does not treat a shared string prefix as a path prefix", () => {
    expect(getHelpForPage("member", "/bookingsfoo").title).toBe("Member help");
  });

  it("routes nested detail paths to the /bookings/* entry", () => {
    expect(getHelpForPage("member", "/bookings/a/b").title).toBe("Your booking");
  });
});

describe("buildHelpGrounding", () => {
  const ARTIFACTS = /=>|function\s|<\/|className|React\.|\[object Object\]|undefined/;
  const CASES: Array<{ surface: HelpSurface; path: string; title: string }> = [
    { surface: "public", path: "/", title: "Welcome" },
    { surface: "member", path: "/book", title: "Book a Stay" },
    { surface: "member", path: "/bookings/abc123", title: "Your booking" },
    { surface: "admin", path: "/admin/bookings", title: "Bookings" },
    { surface: "finance", path: "/finance", title: "Finance Dashboard" },
  ];

  for (const { surface, path, title } of CASES) {
    it(`serializes ${surface} ${path} as clean labelled text`, () => {
      const grounding = buildHelpGrounding(surface, path);
      expect(grounding.startsWith(`# ${title}`)).toBe(true);
      expect(grounding).toContain("## Questions and answers");
      expect(grounding).toContain("Q: ");
      expect(grounding).toContain("A: ");
      expect(grounding).not.toMatch(ARTIFACTS);
    });
  }

  it("emits a stable, readable grounding for the public home page", () => {
    expect(buildHelpGrounding("public", "/")).toMatchInlineSnapshot(`
      "# Welcome

      This is the club's booking website. Members sign in to book a stay and manage their account; if you are not a member yet, you can apply to join. Whether non-members can stay at all is up to the club — check the club's own pages.

      ## What you can do
      - Members: use Log In, then open Book to reserve lodge nights.
      - Not a member yet: use the Join or Apply link to start a membership application.
      - Not a member and hoping to stay: look for any FAQ, rules, or policy pages the club publishes in the site menu or footer, or use the club's contact page.

      ## Questions and answers
      Q: How do I book a stay?
      A: If you are a member, sign in and open Book to choose your nights and confirm. If you are not a member, apply to join first. Whether non-members can stay is the club's decision — see the club's own pages.

      Q: How do I become a member?
      A: Use the Join or Apply link to fill in a membership application. Applying does not create a login — the club reviews and approves applications before you can sign in.

      Q: Can I stay without being a member?
      A: That is up to the club. Many clubs only host non-members as guests accompanied by a member, if at all. Look for any FAQ, rules, or policy pages the club publishes in the site menu or footer, or contact the club before planning a stay.

      Q: Where do I find fees, dates, or the cancellation policy?
      A: Those are set by the club. Check the club's own pages in the site menu or footer, or use the club's contact page to ask directly."
    `);
  });
});

describe("fallbacks for unknown paths", () => {
  it("returns each surface's fallback for an unmapped path", () => {
    expect(getHelpForPage("admin", "/admin/not-a-page").title).toBe("Admin Help");
    // A path outside the single "/finance" prefix falls back (a "/finance/..."
    // path would still longest-prefix-match the Finance Dashboard entry).
    expect(getHelpForPage("finance", "/reporting-workspace").title).toBe(
      "Finance Help",
    );
    expect(getHelpForPage("member", "/not-a-member-page").title).toBe(
      "Member help",
    );
    expect(getHelpForPage("public", "/not-a-public-page").title).toBe("Help");
  });
});
