// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Route-level guard for #2440: an unpublished (draft) PageContent row must
 * never be served to the public. Unlike the route-parity suite, this file
 * mocks ONLY prisma and runs the real `@/lib/page-content-html` module, so the
 * published filter under test is the one production executes, not a mock of
 * it. Per-route expectations differ on purpose:
 *  - the code-backed routes (/contact, /join, /join/apply) fall back to their
 *    built-in defaults, exactly as when no row exists — the routes carry
 *    functional forms and must keep working;
 *  - the home page and the CMS catch-all 404 (`notFound()`), matching their
 *    missing-row behaviour;
 *  - the root not-found boundary degrades to its hardcoded fallback.
 */

const mocks = vi.hoisted(() => ({
  pageContentFindUnique: vi.fn(),
  buildBody: vi.fn(),
}));

const stubClubIdentity = {
  name: "Club Name",
  socialLinks: {},
  publicUrl: "https://club.example.org",
};

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    pageContent: { findUnique: mocks.pageContentFindUnique },
    lodge: { findUnique: vi.fn(async () => ({ name: "Lodge", address: null })) },
    publicContentSettings: {
      findUnique: vi.fn(async () => ({ contactCommitteeRoleKey: null })),
    },
  },
}));
vi.mock("@/lib/public-layout-config", () => ({
  getCachedClubIdentity: vi.fn(async () => stubClubIdentity),
  getCachedWebsiteThemeRenderState: vi.fn(async () => ({ isComplete: true })),
}));
vi.mock("@/lib/website-setup-metadata", () => ({
  setupInProgressMetadata: vi.fn(async () => null),
}));
vi.mock("@/lib/lodges", () => ({
  getDefaultLodgeId: vi.fn(async () => "lodge-1"),
}));
vi.mock("@/lib/page-content-embeds", () => ({
  buildEmbeddedBody: mocks.buildBody,
}));
vi.mock("@/lib/auth-redirect", () => ({ buildBookingLoginPath: () => "/login" }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("not found");
  },
}));
vi.mock("@/components/website/embedded-page-content-parts", () => ({
  EmbeddedPageContentParts: () => <div>CMS body rendered</div>,
}));
vi.mock("@/components/website/contact-page-client", () => ({
  ContactPageClient: () => <div>Default contact form</div>,
}));
vi.mock("@/components/website/join-apply-page-client", () => ({
  JoinApplyPageClient: () => <div>Default application form</div>,
}));

import HomePage from "@/app/(website)/page";
import DynamicWebsitePage, {
  generateMetadata as dynamicPageMetadata,
} from "@/app/(website)/[...slug]/page";
import ContactPage, {
  generateMetadata as contactMetadata,
} from "@/app/(website)/contact/page";
import JoinPage, {
  generateMetadata as joinMetadata,
} from "@/app/(website)/join/page";
import JoinApplyPage, {
  generateMetadata as joinApplyMetadata,
} from "@/app/(website)/join/apply/page";
import NotFoundPage from "@/app/not-found";

function draftRow(path: string) {
  return {
    id: "page-1",
    slug: path.replace(/^\//, "") || "home",
    caption: "Draft caption",
    menuTitle: "Draft",
    title: "Secret draft title",
    headerText: "<p>Secret draft header</p>",
    path,
    sortOrder: 1,
    contentHtml: "<p>Secret draft body</p>",
    published: false,
  };
}

describe("unpublished CMS pages are not served to the public (#2440)", () => {
  beforeEach(() => {
    mocks.buildBody.mockResolvedValue([
      { type: "html", value: "<p>body</p>" },
    ]);
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("/contact falls back to the default page, hiding every draft field", async () => {
    mocks.pageContentFindUnique.mockResolvedValue(draftRow("/contact"));

    render(await ContactPage());

    expect(screen.getByText("Contact Us")).toBeTruthy();
    expect(screen.getByText("Default contact form")).toBeTruthy();
    expect(screen.queryByText(/Secret draft/)).toBeNull();
    expect(screen.queryByText("Draft caption")).toBeNull();
  });

  it("/contact metadata falls back to the default title and description", async () => {
    mocks.pageContentFindUnique.mockResolvedValue(draftRow("/contact"));

    const metadata = await contactMetadata();

    expect(metadata.title).toBe("Contact Us");
    expect(String(metadata.description)).not.toContain("Secret draft");
  });

  it("/join falls back to the default copy", async () => {
    mocks.pageContentFindUnique.mockResolvedValue(draftRow("/join"));

    render(await JoinPage());

    expect(screen.getByText("Becoming a Member")).toBeTruthy();
    expect(screen.queryByText(/Secret draft/)).toBeNull();
  });

  it("/join metadata falls back to the default title", async () => {
    mocks.pageContentFindUnique.mockResolvedValue(draftRow("/join"));

    const metadata = await joinMetadata();

    expect(metadata.title).toBe("Join the Club");
  });

  it("/join/apply metadata falls back to the default title", async () => {
    mocks.pageContentFindUnique.mockResolvedValue(draftRow("/join/apply"));

    const metadata = await joinApplyMetadata();

    expect(metadata.title).toBe("Apply for Membership");
    expect(String(metadata.description)).not.toContain("Secret draft");
  });

  it("/join/apply falls back to the default application form", async () => {
    mocks.pageContentFindUnique.mockResolvedValue(draftRow("/join/apply"));

    render(await JoinApplyPage());

    expect(screen.getByText("Apply for Membership")).toBeTruthy();
    expect(screen.getByText("Default application form")).toBeTruthy();
    expect(screen.queryByText(/Secret draft/)).toBeNull();
  });

  it("the home page 404s on an unpublished /home row, like a missing one", async () => {
    mocks.pageContentFindUnique.mockResolvedValue(draftRow("/home"));

    await expect(HomePage()).rejects.toThrow("not found");
  });

  it("the CMS catch-all 404s an unpublished admin page, body and metadata", async () => {
    mocks.pageContentFindUnique.mockResolvedValue(draftRow("/trip-reports"));
    const props = { params: Promise.resolve({ slug: ["trip-reports"] }) };

    await expect(DynamicWebsitePage(props)).rejects.toThrow("not found");
    await expect(dynamicPageMetadata(props)).rejects.toThrow("not found");
  });

  it("the not-found boundary degrades to its hardcoded fallback", async () => {
    mocks.pageContentFindUnique.mockResolvedValue(draftRow("/404"));

    render(await NotFoundPage());

    expect(screen.getByText("Page Not Found")).toBeTruthy();
    expect(screen.queryByText(/Secret draft/)).toBeNull();
  });

  it("a published row still renders through the real helper (control case)", async () => {
    mocks.pageContentFindUnique.mockResolvedValue({
      ...draftRow("/contact"),
      published: true,
      title: "Visible contact title",
    });

    render(await ContactPage());

    expect(screen.getByText("Visible contact title")).toBeTruthy();
    expect(screen.getByText("CMS body rendered")).toBeTruthy();
  });
});
