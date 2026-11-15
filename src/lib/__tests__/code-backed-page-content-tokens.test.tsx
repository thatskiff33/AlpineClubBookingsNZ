// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type PhotoGalleryTokenMockProps = {
  galleryId: string;
  images: Array<{
    src: string;
    alt: string;
    width: number | null;
    height: number | null;
  }>;
  variant?: "gallery" | "slideshow";
};

const mocks = vi.hoisted(() => ({
  getSanitizedPageContentByPath: vi.fn(),
  buildEmbeddedBody: vi.fn(),
  photoGalleryToken: vi.fn(),
}));

// The contact/join pages now load DB-first club identity + the default lodge
// address server-side (E3 #1929). Neutralise the server-only guard and stub the
// identity reads. The pages read identity through the tagged public-layout cache
// (getCachedClubIdentity), whose real module wraps unstable_cache and cannot run
// under vitest, so stub that accessor directly alongside the raw one.
const stubClubIdentity = {
  name: "Club Name",
  socialLinks: {},
  publicUrl: "https://club.example.org",
};
vi.mock("server-only", () => ({}));
vi.mock("@/lib/club-identity-settings", () => ({
  getClubIdentity: vi.fn(async () => stubClubIdentity),
}));
vi.mock("@/lib/public-layout-config", () => ({
  getCachedClubIdentity: vi.fn(async () => stubClubIdentity),
}));
vi.mock("@/lib/lodges", () => ({
  getDefaultLodgeId: vi.fn(async () => "lodge-1"),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { lodge: { findUnique: vi.fn(async () => ({ name: "Lodge", address: null })) } },
}));

// Shared factory mirrors the real published filter (#2440).
vi.mock("@/lib/page-content-html", async () => {
  const { pageContentHtmlModuleMock } = await import(
    "@/lib/__tests__/helpers/page-content-html-mock"
  );
  return pageContentHtmlModuleMock(mocks.getSanitizedPageContentByPath, {
    pageContentHtmlToPlainText: () => "",
  });
});

vi.mock("@/lib/page-content-embeds", () => ({
  buildEmbeddedBody: mocks.buildEmbeddedBody,
}));

vi.mock("@/components/website/contact-page-client", () => ({
  ContactPageClient: () => <div>Contact form rendered</div>,
}));

vi.mock("@/components/website/join-apply-page-client", () => ({
  JoinApplyPageClient: () => <div>Membership form rendered</div>,
}));

vi.mock("@/components/website/committee-members-grid", () => ({
  CommitteeMembersGrid: () => <div>Committee members rendered</div>,
}));

vi.mock("@/components/website/skifield-conditions-widget", () => ({
  SkifieldConditionsWidget: () => <div>Skifield conditions rendered</div>,
}));

vi.mock("@/components/website/skifield-whakapapa-widget", () => ({
  SkifieldWhakapapaWidget: () => <div>Whakapapa widget rendered</div>,
}));

vi.mock("@/components/website/photo-gallery-token", () => ({
  PhotoGalleryToken: (props: PhotoGalleryTokenMockProps) => {
    mocks.photoGalleryToken(props);
    return (
      <div data-testid={`photo-${props.variant ?? "gallery"}`}>
        {props.galleryId}:{props.images.length}
      </div>
    );
  },
}));

import ContactPage from "@/app/(website)/contact/page";
import JoinPage from "@/app/(website)/join/page";
import JoinApplyPage from "@/app/(website)/join/apply/page";

function pageContent(path: string, contentHtml: string) {
  return {
    id: `page-${path}`,
    path,
    slug: path.replace(/^\//, ""),
    title: `Title ${path}`,
    caption: `Caption ${path}`,
    menuTitle: null,
    menuOrder: null,
    headerText: `<p>Header ${path}</p>`,
    contentHtml,
    published: true,
  };
}

describe("code-backed PageContent photo tokens", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders photo galleries and the contact form token on /contact", async () => {
    const contentHtml =
      '<p>Contact intro</p>{{photo-gallery}}<p>Before form</p>{{contact-form}}';
    mocks.getSanitizedPageContentByPath.mockResolvedValue(
      pageContent("/contact", contentHtml),
    );
    mocks.buildEmbeddedBody.mockResolvedValue([
      { type: "html", value: "<p>Contact intro</p>" },
      {
        type: "photo-gallery",
        images: [
          {
            src: "/api/images/uploaded/contact.jpg",
            alt: "Contact lodge",
            width: 640,
            height: 480,
          },
        ],
      },
      { type: "html", value: "<p>Before form</p>" },
      { type: "contact-form" },
    ]);

    render(await ContactPage());

    expect(mocks.buildEmbeddedBody).toHaveBeenCalledWith(contentHtml);
    expect(screen.getByText("Contact intro")).toBeTruthy();
    expect(screen.getByTestId("photo-gallery").textContent).toBe(
      "photo-gallery-contact-1:1",
    );
    expect(screen.getByText("Contact form rendered")).toBeTruthy();
    expect(screen.queryByText("{{photo-gallery}}")).toBeNull();
    expect(mocks.photoGalleryToken).toHaveBeenCalledWith(
      expect.objectContaining({
        galleryId: "photo-gallery-contact-1",
        variant: "gallery",
        images: [
          {
            src: "/api/images/uploaded/contact.jpg",
            alt: "Contact lodge",
            width: 640,
            height: 480,
          },
        ],
      }),
    );
  });

  it("renders photo slideshows inside /join PageContent", async () => {
    const contentHtml = "<p>Join intro</p>{{photo-slideshow}}";
    mocks.getSanitizedPageContentByPath.mockResolvedValue(
      pageContent("/join", contentHtml),
    );
    mocks.buildEmbeddedBody.mockResolvedValue([
      { type: "html", value: "<p>Join intro</p>" },
      {
        type: "photo-slideshow",
        images: [
          {
            src: "/api/images/uploaded/join.jpg",
            alt: "Join lodge",
            width: 800,
            height: 600,
          },
        ],
      },
    ]);

    render(await JoinPage());

    expect(mocks.buildEmbeddedBody).toHaveBeenCalledWith(contentHtml);
    expect(screen.getByText("Join intro")).toBeTruthy();
    expect(screen.getByTestId("photo-slideshow").textContent).toBe(
      "photo-slideshow-join-1:1",
    );
    expect(screen.queryByText("{{photo-slideshow}}")).toBeNull();
    expect(mocks.photoGalleryToken).toHaveBeenCalledWith(
      expect.objectContaining({
        galleryId: "photo-slideshow-join-1",
        variant: "slideshow",
        images: [
          {
            src: "/api/images/uploaded/join.jpg",
            alt: "Join lodge",
            width: 800,
            height: 600,
          },
        ],
      }),
    );
  });

  it("keeps rendering /join PageContent when no token is present", async () => {
    const contentHtml = "<p>Plain join content</p>";
    mocks.getSanitizedPageContentByPath.mockResolvedValue(
      pageContent("/join", contentHtml),
    );
    mocks.buildEmbeddedBody.mockResolvedValue([
      { type: "html", value: contentHtml },
    ]);

    render(await JoinPage());

    expect(mocks.buildEmbeddedBody).toHaveBeenCalledWith(contentHtml);
    expect(screen.getByText("Plain join content")).toBeTruthy();
    expect(mocks.photoGalleryToken).not.toHaveBeenCalled();
  });

  it("renders photo tokens and the application form token on /join/apply", async () => {
    const contentHtml =
      "<p>Apply intro</p>{{photo-gallery}}{{member-application-form}}";
    mocks.getSanitizedPageContentByPath.mockResolvedValue(
      pageContent("/join/apply", contentHtml),
    );
    mocks.buildEmbeddedBody.mockResolvedValue([
      { type: "html", value: "<p>Apply intro</p>" },
      {
        type: "photo-gallery",
        images: [
          {
            src: "/api/images/uploaded/apply.jpg",
            alt: "Apply lodge",
            width: 1024,
            height: 768,
          },
        ],
      },
      { type: "member-application-form" },
    ]);

    render(await JoinApplyPage());

    expect(mocks.buildEmbeddedBody).toHaveBeenCalledWith(contentHtml);
    expect(screen.getByText("Apply intro")).toBeTruthy();
    expect(screen.getByTestId("photo-gallery").textContent).toBe(
      "photo-gallery-join-apply-1:1",
    );
    expect(screen.getByText("Membership form rendered")).toBeTruthy();
    expect(screen.queryByText("{{member-application-form}}")).toBeNull();
    expect(mocks.photoGalleryToken).toHaveBeenCalledWith(
      expect.objectContaining({
        galleryId: "photo-gallery-join-apply-1",
        variant: "gallery",
        images: [
          {
            src: "/api/images/uploaded/apply.jpg",
            alt: "Apply lodge",
            width: 1024,
            height: 768,
          },
        ],
      }),
    );
  });
});
