// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClubIdentity } from "@/config/club-identity-types";
import { expectNoSkippedHeadingLevels } from "@/lib/__tests__/support/heading-outline";

/**
 * #5217 (`INV-PUB-006`) — `/join/apply` has exactly one level-1 heading in
 * every state, and "Application submitted" is a heading a screen-reader user
 * can jump to.
 *
 * The page's hero carries the h1 and is drawn by the server page, so it stays
 * when the form gives way to the confirmation. Before #5217 the confirmation's
 * title only LOOKED like a heading: someone who had just applied found nothing
 * new in the heading list. It is now level 2 under the page's h1 — and level 1
 * only where the form draws the hero itself, because there the hero's h1 goes
 * away with the form.
 *
 * The real page and the real form are rendered together: the count is a fact
 * about the two combined, which neither shows alone. #5216 added the form's
 * own card title, "Enter your details", at level 2 under whichever h1 the
 * composition draws, and holds every state to an outline with no skipped level.
 */

const mocks = vi.hoisted(() => ({
  getPublishedPageContentByPath: vi.fn(),
  buildEmbeddedBody: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/page-content-html", () => ({
  getPublishedPageContentByPath: mocks.getPublishedPageContentByPath,
  // Parsed, not stripped with a pattern: a tag-stripping regex can leave markup
  // behind (CodeQL js/incomplete-multi-character-sanitization), even in a mock.
  pageContentHtmlToPlainText: (html: string) =>
    new DOMParser().parseFromString(html, "text/html").body.textContent ?? "",
}));
vi.mock("@/lib/page-content-embeds", () => ({
  buildEmbeddedBody: mocks.buildEmbeddedBody,
}));
vi.mock("@/lib/website-setup-metadata", () => ({
  setupInProgressMetadata: async () => null,
}));
vi.mock("@/lib/public-layout-config", () => ({
  getCachedClubIdentity: async () => ({ name: "Example Club" }),
}));
// Address fields are not under test and pull in the autocomplete widget.
vi.mock("@/components/member-address-fields", () => ({
  MemberAddressFields: () => <div data-testid="address-fields" />,
}));

import JoinApplyPage from "@/app/(website)/join/apply/page";
import { JoinApplyPageClient } from "@/components/website/join-apply-page-client";

const club = { name: "Example Club" } as unknown as ClubIdentity;

/** How each composition of the page reaches the screen. */
const COMPOSITIONS: Array<
  [name: string, load: () => Promise<ReactElement>, submittedLevel: 1 | 2]
> = [
  [
    "/join/apply with no stored page body",
    async () => {
      mocks.buildEmbeddedBody.mockResolvedValue([]);
      return JoinApplyPage();
    },
    2,
  ],
  [
    "/join/apply with the form embedded in its stored page body",
    async () => {
      mocks.getPublishedPageContentByPath.mockResolvedValue({
        caption: "Join us",
        title: "Become a member",
        headerText: "",
        contentHtml: "{{member-application-form}}",
      });
      mocks.buildEmbeddedBody.mockResolvedValue([
        { type: "member-application-form" },
      ]);
      return JoinApplyPage();
    },
    2,
  ],
  [
    "the form drawing its own hero",
    async () => <JoinApplyPageClient club={club} />,
    1,
  ],
];

function levelOneHeadings() {
  return screen
    .queryAllByRole("heading", { level: 1 })
    .map((heading) => heading.textContent);
}

function submitForm() {
  fireEvent.click(
    screen.getByRole("button", { name: /submit membership application/i }),
  );
}

function fillValidApplicant() {
  const values: Array<[label: string, value: string]> = [
    ["First name", "Tui"],
    ["Last name", "Kea"],
    ["Email", "tui@example.org"],
    ["Date of birth", "1990-01-15"],
    ["First nominator email", "nom1@example.org"],
    ["Second nominator email", "nom2@example.org"],
  ];
  for (const [label, value] of values) {
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  }
}

describe("/join/apply has one level-1 heading in every state (#5217)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPublishedPageContentByPath.mockResolvedValue(null);
    global.fetch = vi.fn() as unknown as typeof fetch;
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it.each(COMPOSITIONS)("%s: the empty form", async (_name, load) => {
    render(await load());

    expect(levelOneHeadings()).toHaveLength(1);
    expect(
      screen.getByRole("heading", { name: "Enter your details", level: 2 }),
    ).toBeInTheDocument();
    expectNoSkippedHeadingLevels();
  });

  it.each(COMPOSITIONS)("%s: the form refused with errors", async (_name, load) => {
    render(await load());
    const before = levelOneHeadings();

    submitForm();

    await screen.findByRole("alert");
    expect(levelOneHeadings()).toEqual(before);
    expect(before).toHaveLength(1);
    expectNoSkippedHeadingLevels();
  });

  it.each(COMPOSITIONS)("%s: while the application is being sent", async (_name, load) => {
    // Never settles, so the form stays in its sending state.
    vi.mocked(global.fetch).mockReturnValue(new Promise(() => {}));
    render(await load());

    fillValidApplicant();
    submitForm();

    await screen.findByRole("button", { name: /submitting/i });
    expect(levelOneHeadings()).toHaveLength(1);
    expectNoSkippedHeadingLevels();
  });

  it.each(COMPOSITIONS)(
    "%s: Application submitted",
    async (_name, load, submittedLevel) => {
      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ warnings: [] }),
      } as Response);
      render(await load());

      fillValidApplicant();
      submitForm();

      // The confirmation is in the heading list, at the level its page needs.
      await screen.findByRole("heading", {
        name: "Application submitted",
        level: submittedLevel,
      });
      expect(levelOneHeadings()).toHaveLength(1);
      expectNoSkippedHeadingLevels();
    },
  );
});
