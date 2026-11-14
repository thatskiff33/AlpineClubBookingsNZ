// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getPage: vi.fn(), buildBody: vi.fn() }));
// The website pages now resolve DB-first club identity (via the tagged
// public-layout cache) and the default lodge address server-side (E3 #1929).
// Neutralise the server-only guard and stub those reads so the pages import and
// render without a database or the unstable_cache runtime.
const stubClubIdentity = {
  name: "Club Name",
  socialLinks: {},
  publicUrl: "https://club.example.org",
};
vi.mock("server-only", () => ({}));
vi.mock("@/lib/public-layout-config", () => ({
  getCachedClubIdentity: vi.fn(async () => stubClubIdentity),
  // `(website)/[...slug]`'s generateMetadata reads the layout's cached theme
  // state to leave a pre-setup site alone (#2405). This file renders the page
  // component rather than its metadata, so the value only has to exist.
  getCachedWebsiteThemeRenderState: vi.fn(async () => ({ isComplete: true })),
}));
vi.mock("@/lib/lodges", () => ({
  getDefaultLodgeId: vi.fn(async () => "lodge-1"),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    lodge: { findUnique: vi.fn(async () => ({ name: "Lodge", address: null })) },
  },
}));
// Shared factory mirrors the real published filter (#2440).
vi.mock("@/lib/page-content-html", async () => {
  const { pageContentHtmlModuleMock } = await import(
    "@/lib/__tests__/helpers/page-content-html-mock"
  );
  return pageContentHtmlModuleMock(mocks.getPage, {
    pageContentHtmlToPlainText: () => "",
  });
});
vi.mock("@/lib/page-content-embeds", () => ({ buildEmbeddedBody: mocks.buildBody }));
vi.mock("@/lib/auth-redirect", () => ({ buildBookingLoginPath: () => "/login" }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("not found"); } }));
vi.mock("@/components/website/contact-page-client", () => ({ ContactPageClient: () => <div>Contact form</div> }));
vi.mock("@/components/website/join-apply-page-client", () => ({ JoinApplyPageClient: () => <div>Join form</div> }));
vi.mock("@/components/website/committee-members-grid", () => ({ CommitteeMembersGrid: () => <div>Committee</div> }));
vi.mock("@/components/website/photo-gallery-token", () => ({ PhotoGalleryToken: () => <div>Gallery</div> }));
vi.mock("@/components/website/skifield-conditions-widget", () => ({ SkifieldConditionsWidget: () => <div>Conditions</div> }));
vi.mock("@/components/website/skifield-whakapapa-widget", () => ({ SkifieldWhakapapaWidget: () => <div>Whakapapa</div> }));

import HomePage from "@/app/(website)/page";
import DynamicWebsitePage from "@/app/(website)/[...slug]/page";
import ContactPage from "@/app/(website)/contact/page";
import NotFoundPage from "@/app/not-found";

const page = {
  id: "page-1", slug: "content", caption: "Info", menuTitle: "Info",
  title: "Public information", headerText: "<p>Header</p>", path: "/content",
  sortOrder: 1, contentHtml: "{{membership-types}}", published: true,
};
const parts = [
  { type: "annual-fees" as const, groups: [{ heading: "Annual membership fees", rows: [{ label: "Public membership", fee: { amountCents: 15000, label: "$150.00" } }] }] },
  { type: "first-year-costs" as const, groups: [{ heading: "Joining fee plus first year's subscription", rows: [{ label: "Adult first year", fee: { amountCents: 39000, label: "$390.00" } }] }] },
  { type: "joining-fees" as const, groups: [{ heading: "Full", rows: [{ label: "Adult", fee: { amountCents: 1000, label: "$10.00" } }] }] },
  { type: "hut-fees" as const, tables: [{ heading: "River Lodge — Winter nightly rates", rowHeading: "Age", columns: ["Full Member"], rows: [{ label: "Adult", cells: [{ amountCents: 4000, label: "$40.00" }] }] }] },
  { type: "booking-policy-summary" as const, policy: { lodge: { name: "River Lodge", slug: "river" }, hold: "Non-member bookings are not held provisionally.", periods: [], minimumStays: [], groupDiscount: null } },
  { type: "cancellation-policy" as const, policy: { lodge: { name: "River Lodge", slug: "river" }, tiers: [{ description: "7 or more days before check-in: 100% refund" }, { description: "After check-in: no refund" }], periods: [] } },
];

describe("public PageContent data-token route parity", () => {
  beforeEach(() => {
    mocks.getPage.mockResolvedValue(page);
    mocks.buildBody.mockResolvedValue(parts);
  });
  afterEach(() => { cleanup(); vi.clearAllMocks(); });

  async function expectPublicBlocks(node: React.ReactNode) {
    render(node);
    expect(screen.getByText("Public membership")).toBeTruthy();
    expect(screen.getByText("Adult first year")).toBeTruthy();
    expect(screen.getByText("$390.00")).toBeTruthy();
    expect(screen.getByText("$10.00")).toBeTruthy();
    expect(screen.getByText(/River Lodge — Winter/)).toBeTruthy();
    expect(screen.getByText("Non-member bookings are not held provisionally.")).toBeTruthy();
    expect(screen.getByText("After check-in: no refund")).toBeTruthy();
  }

  it("renders through home", async () => { await expectPublicBlocks(await HomePage()); });
  it("renders through the catch-all", async () => { await expectPublicBlocks(await DynamicWebsitePage({ params: Promise.resolve({ slug: ["content"] }) })); });
  it("renders through a code-backed route", async () => { await expectPublicBlocks(await ContactPage()); });
  it("renders through the database-backed 404", async () => { await expectPublicBlocks(await NotFoundPage()); });
});
