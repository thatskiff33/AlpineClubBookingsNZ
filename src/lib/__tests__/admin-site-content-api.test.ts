import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  siteContentFindMany: vi.fn(),
  siteContentFindUnique: vi.fn(),
  siteContentUpsert: vi.fn(),
  auditLogCreate: vi.fn(),
  revalidatePublicPageContent: vi.fn(),
  buildStructuredAuditLogCreateArgs: vi.fn((event) => ({ data: event })),
  getAuditRequestContext: vi.fn(() => ({
    id: "req-1",
    ipAddress: "127.0.0.1",
    userAgent: "vitest",
  })),
}));

vi.mock("@/lib/auth", () => ({
  auth: mocks.auth,
}));

vi.mock("@/lib/session-guards", async () => ({
  requireAdmin: (await import("./helpers/require-admin-mock"))
    .evaluateRequireAdminMock,
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));

vi.mock("@/lib/audit", () => ({
  buildStructuredAuditLogCreateArgs: mocks.buildStructuredAuditLogCreateArgs,
  getAuditRequestContext: mocks.getAuditRequestContext,
}));

vi.mock("@/lib/public-content-revalidation", () => ({
  revalidatePublicPageContent: mocks.revalidatePublicPageContent,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    siteContent: {
      findMany: mocks.siteContentFindMany,
      findUnique: mocks.siteContentFindUnique,
      upsert: mocks.siteContentUpsert,
    },
    auditLog: {
      create: mocks.auditLogCreate,
    },
  },
}));

import { GET, PUT } from "@/app/api/admin/site-content/route";
import { starterSiteContent } from "../../../prisma/starter-site-content";

const memberSession = {
  user: { id: "member-1", role: "MEMBER", accessRoles: [{ role: "USER" }] },
};
const adminSession = {
  user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] },
};
// Read-only Admin merges to content:view (roles merge max-per-area). This is
// the LWTC role combo that could "edit" Site Contents on-screen while the API
// silently 403'd — pinned here so the split can't regress (#1927).
const contentViewerSession = {
  user: {
    id: "viewer-1",
    role: "MEMBER",
    accessRoles: [{ role: "ADMIN_READONLY" }],
  },
};

function putRequest(body: unknown) {
  return new NextRequest("http://localhost/api/admin/site-content", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireActiveSessionUser.mockResolvedValue(null);
  mocks.siteContentFindMany.mockResolvedValue([]);
  mocks.siteContentFindUnique.mockResolvedValue({ contentHtml: "<p>Old</p>" });
  mocks.siteContentUpsert.mockImplementation(
    async ({
      update,
      where,
    }: {
      update: { contentHtml: string };
      where: { key: string };
    }) => ({
      id: `site-content-${where.key.toLowerCase()}`,
      key: where.key,
      contentHtml: update.contentHtml,
      updatedAt: new Date("2026-07-02T00:00:00Z"),
    }),
  );
  mocks.auditLogCreate.mockResolvedValue({});
});

describe("GET /api/admin/site-content", () => {
  it("denies an unauthenticated request", async () => {
    mocks.auth.mockResolvedValue(null);
    const response = await GET();
    expect(response.status).toBe(401);
  });

  it("denies a non-admin member", async () => {
    mocks.auth.mockResolvedValue(memberSession);
    const response = await GET();
    expect(response.status).toBe(403);
    expect(mocks.siteContentFindMany).not.toHaveBeenCalled();
  });

  it("allows a content:view-only admin to read (GET requires content:view)", async () => {
    mocks.auth.mockResolvedValue(contentViewerSession);
    const response = await GET();
    expect(response.status).toBe(200);
  });

  it("returns all sections with starter fallbacks for missing rows", async () => {
    mocks.auth.mockResolvedValue(adminSession);
    mocks.siteContentFindMany.mockResolvedValue([]);

    const response = await GET();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(
      body.documents.map((doc: { key: string }) => doc.key),
    ).toEqual(["FOOTER_BLURB", "FOOTER_QUICK_LINKS", "FOOTER_AFFILIATIONS"]);

    const blurb = body.documents[0];
    expect(blurb.contentHtml).toBe(starterSiteContent[0].contentHtml);
    expect(blurb.updatedAt).toBeNull();

    // #2490: the starter affiliations column is empty — a fresh install lists
    // no affiliations until the club adds its own — so the fallback is empty
    // too and names no club-specific body.
    const affiliations = body.documents[2];
    expect(affiliations.key).toBe("FOOTER_AFFILIATIONS");
    expect(affiliations.contentHtml).toBe("");
    expect(
      body.documents.map((doc: { contentHtml: string }) => doc.contentHtml).join(""),
    ).not.toMatch(/RMCA|Ruapehu|Federated Mountain Clubs/i);
  });

  it("leaves text tokens unresolved on the editor surface", async () => {
    // Round-trip safety: an admin edits the literal {{facebook-url}}, so the
    // editor must never be served a resolved value it would then save back.
    mocks.auth.mockResolvedValue(adminSession);
    mocks.siteContentFindMany.mockResolvedValue([
      {
        key: "FOOTER_AFFILIATIONS",
        contentHtml:
          '<ul><li><a href="{{facebook-url}}" target="_blank" rel="noopener noreferrer">Facebook</a></li></ul>',
        updatedAt: new Date("2026-07-01T00:00:00Z"),
      },
    ]);

    const response = await GET();
    const body = await response.json();

    expect(body.documents[2].contentHtml).toContain("{{facebook-url}}");
  });

  it("sanitises stored rows again on read", async () => {
    mocks.auth.mockResolvedValue(adminSession);
    mocks.siteContentFindMany.mockResolvedValue([
      {
        key: "FOOTER_BLURB",
        contentHtml: '<p>Hi</p><script>alert("x")</script>',
        updatedAt: new Date("2026-07-01T00:00:00Z"),
      },
    ]);

    const response = await GET();
    const body = await response.json();
    expect(body.documents[0].contentHtml).toBe("<p>Hi</p>");
    expect(body.documents[0].updatedAt).toBe("2026-07-01T00:00:00.000Z");
  });

  it("keeps a stored-but-empty row empty instead of restoring the starter", async () => {
    mocks.auth.mockResolvedValue(adminSession);
    mocks.siteContentFindMany.mockResolvedValue([
      {
        key: "FOOTER_QUICK_LINKS",
        contentHtml: "",
        updatedAt: new Date("2026-07-01T00:00:00Z"),
      },
    ]);

    const response = await GET();
    const body = await response.json();
    expect(body.documents[1].key).toBe("FOOTER_QUICK_LINKS");
    expect(body.documents[1].contentHtml).toBe("");
  });
});

describe("PUT /api/admin/site-content", () => {
  it("rejects non-admin members", async () => {
    mocks.auth.mockResolvedValue(memberSession);
    const response = await PUT(
      putRequest({ key: "FOOTER_BLURB", contentHtml: "<p>Hi</p>" }),
    );
    expect(response.status).toBe(403);
    expect(mocks.siteContentUpsert).not.toHaveBeenCalled();
  });

  it("rejects a content:view-only admin (PUT requires content:edit)", async () => {
    // The gap #1927 closes: a Read-only Admin (content:view) hitting the
    // mutating endpoint must 403, never persist.
    mocks.auth.mockResolvedValue(contentViewerSession);
    const response = await PUT(
      putRequest({ key: "FOOTER_BLURB", contentHtml: "<p>Hi</p>" }),
    );
    expect(response.status).toBe(403);
    expect(mocks.siteContentUpsert).not.toHaveBeenCalled();
  });

  it("rejects unknown section keys", async () => {
    mocks.auth.mockResolvedValue(adminSession);
    const response = await PUT(
      putRequest({ key: "HEADER_BANNER", contentHtml: "<p>Hi</p>" }),
    );
    expect(response.status).toBe(400);
    expect(mocks.siteContentUpsert).not.toHaveBeenCalled();
  });

  it("rejects unexpected extra properties (strict schema)", async () => {
    mocks.auth.mockResolvedValue(adminSession);
    const response = await PUT(
      putRequest({
        key: "FOOTER_BLURB",
        contentHtml: "<p>Hi</p>",
        published: true,
      }),
    );
    expect(response.status).toBe(400);
    expect(mocks.siteContentUpsert).not.toHaveBeenCalled();
  });

  it("rejects invalid JSON", async () => {
    mocks.auth.mockResolvedValue(adminSession);
    const response = await PUT(
      new NextRequest("http://localhost/api/admin/site-content", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: "{not json",
      }),
    );
    expect(response.status).toBe(400);
  });

  it("sanitises content on write and writes an audit entry", async () => {
    mocks.auth.mockResolvedValue(adminSession);
    const response = await PUT(
      putRequest({
        key: "FOOTER_BLURB",
        contentHtml: '<p>Est. 1969</p><script>alert("x")</script>',
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.siteContentUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { key: "FOOTER_BLURB" },
        update: expect.objectContaining({
          contentHtml: "<p>Est. 1969</p>",
          updatedByMemberId: "admin-1",
        }),
      }),
    );
    expect(mocks.auditLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "SITE_CONTENT_UPDATED",
          metadata: expect.objectContaining({ key: "FOOTER_BLURB" }),
        }),
      }),
    );
  });

  it("clears the stored public pages after the audit write (#3852)", async () => {
    mocks.auth.mockResolvedValue(adminSession);
    const response = await PUT(
      putRequest({ key: "FOOTER_QUICK_LINKS", contentHtml: "<p>Links</p>" }),
    );

    expect(response.status).toBe(200);
    expect(mocks.revalidatePublicPageContent).toHaveBeenCalledTimes(1);
    expect(
      mocks.auditLogCreate.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.revalidatePublicPageContent.mock.invocationCallOrder[0]);
  });

  it("does not clear the public pages when the save is refused", async () => {
    mocks.auth.mockResolvedValue(contentViewerSession);
    await PUT(putRequest({ key: "FOOTER_BLURB", contentHtml: "<p>Hi</p>" }));
    expect(mocks.revalidatePublicPageContent).not.toHaveBeenCalled();
  });

  it("strips event-handler attributes on write", async () => {
    mocks.auth.mockResolvedValue(adminSession);
    await PUT(
      putRequest({
        key: "FOOTER_QUICK_LINKS",
        contentHtml: '<ul><li onclick="alert(1)">Links</li></ul>',
      }),
    );

    expect(mocks.siteContentUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          contentHtml: "<ul><li>Links</li></ul>",
        }),
      }),
    );
  });

  it("returns the saved document for the editor to re-sync", async () => {
    mocks.auth.mockResolvedValue(adminSession);
    const response = await PUT(
      putRequest({ key: "FOOTER_AFFILIATIONS", contentHtml: "<p>Links</p>" }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.document).toEqual({
      key: "FOOTER_AFFILIATIONS",
      contentHtml: "<p>Links</p>",
      updatedAt: "2026-07-02T00:00:00.000Z",
    });
  });
});
