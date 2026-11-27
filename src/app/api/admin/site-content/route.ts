import { NextRequest, NextResponse } from "next/server";
import { parseJsonRequestBody } from "@/lib/api-json";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import { sanitizePageContentHtml } from "@/lib/page-content-html";
import { siteContentUpdateSchema } from "@/lib/admin-content-api/site-content";
import { connectionJson } from "@/lib/mcp-connection-request";
import {
  SITE_CONTENT_LIST_CONNECTION_SHAPE,
  SITE_CONTENT_SAVED_CONNECTION_SHAPE,
} from "@/lib/connection-shapes/content-pages";
import { revalidatePublicPageContent } from "@/lib/public-content-revalidation";
import { getSiteContentForAdmin } from "@/lib/site-content";

/**
 * GET /api/admin/site-content
 * Lists the site content sections (footer columns) for the admin editor.
 */
export async function GET(request: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "content", level: "view" },
  });
  if (!guard.ok) {
    return guard.response;
  }

  // Editor surface: keep tokens unresolved so admins see and can edit the
  // literal {{facebook-url}} placeholders (round-trip safety).
  const documents = await getSiteContentForAdmin();
  return connectionJson(request, { documents }, SITE_CONTENT_LIST_CONNECTION_SHAPE);
}

/**
 * PUT /api/admin/site-content
 * Saves one keyed section. Content is sanitised on write; render paths
 * sanitise again on read.
 */
export async function PUT(request: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "content", level: "edit" },
  });
  if (!guard.ok) {
    return guard.response;
  }

  const jsonBody = await parseJsonRequestBody(request, {
    error: "Invalid JSON",
  });
  if (!jsonBody.ok) return jsonBody.response;
  const body = jsonBody.body;

  const parsed = siteContentUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const safeContentHtml = sanitizePageContentHtml(parsed.data.contentHtml);

  const existing = await prisma.siteContent.findUnique({
    where: { key: parsed.data.key },
    select: { contentHtml: true },
  });

  // Upsert by key: the migration backfills all three rows, but tolerate
  // environments where a row is missing rather than failing the save.
  const updated = await prisma.siteContent.upsert({
    where: { key: parsed.data.key },
    create: {
      key: parsed.data.key,
      contentHtml: safeContentHtml,
      updatedByMemberId: guard.session.user.id,
    },
    update: {
      contentHtml: safeContentHtml,
      updatedByMemberId: guard.session.user.id,
    },
  });

  await prisma.auditLog.create(
    buildStructuredAuditLogCreateArgs({
      action: "SITE_CONTENT_UPDATED",
      actor: { memberId: guard.session.user.id },
      entity: {
        type: "SiteContent",
        id: updated.id,
      },
      category: "admin",
      severity: "important",
      outcome: "success",
      summary: `Site content updated for ${parsed.data.key}`,
      metadata: {
        key: parsed.data.key,
        previousLength: existing?.contentHtml.length ?? 0,
        nextLength: safeContentHtml.length,
      },
      request: getAuditRequestContext(request),
    }),
  );

  // Footer sections render on every public page, stored CMS pages included, so
  // clear the full-route store as well as the tagged caches (#3852).
  revalidatePublicPageContent();

  return connectionJson(
    request,
    {
      document: {
        key: updated.key,
        contentHtml: updated.contentHtml,
        updatedAt: updated.updatedAt.toISOString(),
      },
    },
    SITE_CONTENT_SAVED_CONNECTION_SHAPE,
  );
}
