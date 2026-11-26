/**
 * ALP-723 (`INV-MCP-006`): the page, footer section and site banner actions
 * an officer's AI app connection may run, each held to its contract
 * (`expectActionContract`): the connection gets exactly the action's
 * `returns` fields and the browser's answer is unchanged. The HTML an app
 * sends goes through the route's own sanitiser, the same one the website's
 * editor relies on.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  prisma: {
    pageContent: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    publicContentSettings: { updateMany: vi.fn() },
    siteContent: { findMany: vi.fn(), findUnique: vi.fn(), upsert: vi.fn() },
    siteBanner: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/session-guards", async () => ({
  requireAdmin: (await import("./helpers/require-admin-mock")).evaluateRequireAdminMock,
  requireActiveSessionUser: vi.fn(async () => null),
}));
vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));
vi.mock("@/lib/audit", async () => {
  const actual = (await vi.importActual("@/lib/audit")) as typeof import("@/lib/audit");
  return {
    buildStructuredAuditLogCreateArgs: (event: unknown) => ({ data: event }),
    getAuditRequestContext: () => ({ id: "req-1", ipAddress: "203.0.113.9", userAgent: "vitest" }),
    sanitizeAuditMetadata: actual.sanitizeAuditMetadata,
    buildStoredMetadata: actual.buildStoredMetadata,
  };
});
vi.mock("@/lib/public-content-revalidation", () => ({
  revalidatePublicPageContent: vi.fn(),
  revalidatePublicSite: vi.fn(),
}));
vi.mock("@/lib/club-time/server", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/club-time/server")),
  clubTodayDateOnlyInstant: vi.fn(async () => new Date("2026-07-01T00:00:00.000Z")),
}));

import { DELETE as deletePage, GET as listPages, PATCH as publishPage, POST as createPage, PUT as updatePage } from "@/app/api/admin/page-content/route";
import { GET as listFooter, PUT as updateFooter } from "@/app/api/admin/site-content/route";
import { GET as listBanners, POST as createBanner } from "@/app/api/admin/site-banners/route";
import { DELETE as deleteBanner, PATCH as updateBanner } from "@/app/api/admin/site-banners/[id]/route";
import { expectActionContract, officerMemberSession } from "@/lib/__tests__/helpers/mcp-action-contract";

const UPDATED_AT = new Date("2026-06-20T01:00:00.000Z");

/** A page row as Prisma returns it, with a column no action returns. */
const pageRow = {
  id: "page-1",
  slug: "trip-reports",
  path: "/trip-reports",
  caption: "Recent trips",
  menuTitle: "Trips",
  title: "Trip reports",
  headerText: "<p>Our trips</p>",
  sortOrder: 120,
  contentHtml: "<p>Body</p>",
  published: true,
  updatedByMemberId: "officer-1",
  createdAt: new Date("2026-06-01T00:00:00.000Z"),
  updatedAt: UPDATED_AT,
};

const pageFields = {
  caption: "Recent trips",
  menuTitle: "Trips",
  title: "Trip reports",
  headerText: "<p>Our trips</p>",
  slug: "trip-reports",
  sortOrder: 120,
};

/** A banner row, with a column no action returns. */
const bannerRow = {
  id: "banner-1",
  message: "Road closed above the lodge",
  priority: "URGENT" as const,
  startDate: new Date("2026-07-01T00:00:00.000Z"),
  endDate: new Date("2026-07-03T00:00:00.000Z"),
  active: true,
  createdByMemberId: "officer-1",
  updatedByMemberId: "officer-1",
  createdAt: UPDATED_AT,
  updatedAt: UPDATED_AT,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue(officerMemberSession());
  h.prisma.$transaction.mockImplementation(async (run: (tx: typeof h.prisma) => unknown) => run(h.prisma));
  h.prisma.pageContent.findFirst.mockResolvedValue(null);
  h.prisma.pageContent.findMany.mockResolvedValue([pageRow]);
  h.prisma.publicContentSettings.updateMany.mockResolvedValue({ count: 0 });
  h.prisma.siteContent.findMany.mockResolvedValue([]);
});

describe("page actions", () => {
  it("list_site_pages sends every page with its stored HTML", async () => {
    const { connection } = await expectActionContract({ actionId: "list_site_pages", handler: listPages });

    expect(connection).toEqual({
      pages: [expect.objectContaining({ id: "page-1", contentHtml: "<p>Body</p>", updatedAt: UPDATED_AT.toISOString() })],
    });
  });

  it("create_site_page adds the page at its slug", async () => {
    h.prisma.pageContent.create.mockResolvedValue({ ...pageRow, contentHtml: "" });

    const { connection } = await expectActionContract({
      actionId: "create_site_page",
      handler: createPage,
      args: pageFields,
    });

    expect(connection).toMatchObject({ page: { slug: "trip-reports", path: "/trip-reports" } });
    expect(h.prisma.pageContent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ slug: "trip-reports", contentHtml: "" }) }),
    );
  });

  it("update_site_page saves the app's HTML only after the site's sanitiser cleans it", async () => {
    h.prisma.pageContent.findUnique.mockResolvedValue(pageRow);
    h.prisma.pageContent.update.mockResolvedValue(pageRow);

    await expectActionContract({
      actionId: "update_site_page",
      handler: updatePage,
      args: {
        id: "page-1",
        ...pageFields,
        headerText: '<p onclick="steal()">Our trips</p>',
        contentHtml: '<p>Body</p><script>steal()</script><img src="x" onerror="steal()">',
      },
    });

    const [{ data }] = h.prisma.pageContent.update.mock.calls[0] as [{ data: { contentHtml: string; headerText: string } }];
    expect(data.contentHtml).toContain("<p>Body</p>");
    expect(data.contentHtml).not.toMatch(/script|onerror|steal/);
    expect(data.headerText).not.toMatch(/onclick|steal/);
  });

  it("set_site_page_published hides an added page", async () => {
    h.prisma.pageContent.findUnique.mockResolvedValue(pageRow);
    h.prisma.pageContent.update.mockResolvedValue({ ...pageRow, published: false });

    const { connection } = await expectActionContract({
      actionId: "set_site_page_published",
      handler: publishPage,
      args: { id: "page-1", published: false },
    });

    expect(connection).toMatchObject({ page: { id: "page-1", published: false } });
  });

  it("delete_site_page deletes the page and says what still links to it", async () => {
    h.prisma.pageContent.findUnique.mockResolvedValue(pageRow);
    h.prisma.pageContent.findMany.mockResolvedValue([{ slug: "about" }]);
    h.prisma.siteContent.findMany.mockResolvedValue([{ key: "FOOTER_QUICK_LINKS" }]);
    h.prisma.pageContent.delete.mockResolvedValue(pageRow);

    const { connection } = await expectActionContract({
      actionId: "delete_site_page",
      handler: deletePage,
      args: { id: "page-1" },
    });

    expect(connection).toMatchObject({
      ok: true,
      page: { id: "page-1", slug: "trip-reports" },
      referencedBySlugs: ["about"],
      referencedByFooterSections: ["FOOTER_QUICK_LINKS"],
    });
    expect(h.prisma.pageContent.delete).toHaveBeenCalledWith({ where: { id: "page-1" } });
  });
});

describe("footer section actions", () => {
  it("list_footer_sections sends each section with what it is for", async () => {
    h.prisma.siteContent.findMany.mockResolvedValue([
      { key: "FOOTER_BLURB", contentHtml: "<p>Call us</p>", updatedAt: UPDATED_AT },
    ]);

    const { connection } = await expectActionContract({ actionId: "list_footer_sections", handler: listFooter });

    expect(connection).toMatchObject({
      documents: expect.arrayContaining([
        expect.objectContaining({ key: "FOOTER_BLURB", contentHtml: "<p>Call us</p>", title: expect.any(String) }),
      ]),
    });
  });

  it("update_footer_section saves the app's HTML only after the site's sanitiser cleans it", async () => {
    h.prisma.siteContent.findUnique.mockResolvedValue({ contentHtml: "<p>Old</p>" });
    h.prisma.siteContent.upsert.mockImplementation(async ({ update }: { update: { contentHtml: string } }) => ({
      id: "section-1",
      key: "FOOTER_BLURB",
      contentHtml: update.contentHtml,
      updatedByMemberId: "officer-1",
      updatedAt: UPDATED_AT,
    }));

    const { connection } = await expectActionContract({
      actionId: "update_footer_section",
      handler: updateFooter,
      args: { key: "FOOTER_BLURB", contentHtml: "<p>Call us</p><script>steal()</script>" },
    });

    expect(connection).toEqual({
      document: { key: "FOOTER_BLURB", contentHtml: "<p>Call us</p>", updatedAt: UPDATED_AT.toISOString() },
    });
  });
});

describe("site banner actions", () => {
  it("list_site_banners sends the current, upcoming and past banners", async () => {
    h.prisma.siteBanner.findMany.mockResolvedValue([
      bannerRow,
      { ...bannerRow, id: "banner-2", startDate: new Date("2026-08-01T00:00:00.000Z"), endDate: new Date("2026-08-02T00:00:00.000Z") },
      { ...bannerRow, id: "banner-3", startDate: new Date("2026-05-01T00:00:00.000Z"), endDate: new Date("2026-05-02T00:00:00.000Z") },
    ]);

    const { connection } = await expectActionContract({ actionId: "list_site_banners", handler: listBanners });

    expect(connection).toMatchObject({
      current: [{ id: "banner-1", startDate: "2026-07-01", endDate: "2026-07-03" }],
      upcoming: [{ id: "banner-2" }],
      past: [{ id: "banner-3" }],
    });
  });

  it("create_site_banner adds a banner for its New Zealand days", async () => {
    h.prisma.siteBanner.create.mockResolvedValue(bannerRow);

    const { connection } = await expectActionContract({
      actionId: "create_site_banner",
      handler: createBanner,
      args: { message: "Road closed above the lodge", priority: "URGENT", startDate: "2026-07-01", endDate: "2026-07-03" },
    });

    expect(connection).toMatchObject({ banner: { id: "banner-1", active: true } });
    expect(h.prisma.siteBanner.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ active: true, createdByMemberId: "officer-1" }) }),
    );
  });

  it("update_site_banner changes only the fields sent", async () => {
    h.prisma.siteBanner.findUnique.mockResolvedValue(bannerRow);
    h.prisma.siteBanner.update.mockResolvedValue({ ...bannerRow, active: false });

    const { connection } = await expectActionContract({
      actionId: "update_site_banner",
      handler: updateBanner,
      args: { id: "banner-1", active: false },
    });

    expect(connection).toMatchObject({ banner: { id: "banner-1", active: false } });
    expect(h.prisma.siteBanner.update).toHaveBeenCalledWith({
      where: { id: "banner-1" },
      data: { active: false, updatedByMemberId: "officer-1" },
    });
  });

  it("delete_site_banner deletes the banner named in the address", async () => {
    h.prisma.siteBanner.findUnique.mockResolvedValue(bannerRow);

    const { connection } = await expectActionContract({
      actionId: "delete_site_banner",
      handler: deleteBanner,
      args: { id: "banner-1" },
    });

    expect(connection).toEqual({ ok: true });
    expect(h.prisma.siteBanner.delete).toHaveBeenCalledWith({ where: { id: "banner-1" } });
  });
});
