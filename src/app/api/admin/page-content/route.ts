import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import {
  isReservedPageSlug,
  isValidPageSlug,
  normalizePageSlug,
  toPagePath,
} from "@/lib/page-content";
import {
  listEditablePageContent,
  sanitizePageContentHtml,
} from "@/lib/page-content-html";

const createSchema = z
  .object({
    caption: z.string().trim().max(120),
    menuTitle: z.string().trim().max(120),
    title: z.string().trim().min(1).max(120),
    headerText: z.string().max(20000),
    slug: z.string().trim().min(1).max(80),
    sortOrder: z.number().int().min(0).max(9999),
  })
  .strict();

const updateSchema = z
  .object({
    id: z.string().trim().min(1),
    caption: z.string().trim().max(120),
    menuTitle: z.string().trim().max(120),
    title: z.string().trim().min(1).max(120),
    headerText: z.string().max(20000),
    slug: z.string().trim().min(1).max(80),
    sortOrder: z.number().int().min(0).max(9999),
    contentHtml: z.string().max(200000),
  })
  .strict();

const deleteSchema = z
  .object({
    id: z.string().trim().min(1),
  })
  .strict();

function unauthorizedResponse() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

const adminGuardOptions = {
  forbiddenResponse: unauthorizedResponse,
};

const SYSTEM_404_SLUG = "404";
const SYSTEM_404_PATH = "/404";
const SYSTEM_HOME_SLUG = "home";
const SYSTEM_HOME_PATH = "/home";

export async function GET() {
  const guard = await requireAdmin(adminGuardOptions);
  if (!guard.ok) {
    return guard.response;
  }

  const pages = await listEditablePageContent();
  return NextResponse.json({ pages });
}

export async function POST(request: NextRequest) {
  const guard = await requireAdmin(adminGuardOptions);
  if (!guard.ok) {
    return guard.response;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const slug = normalizePageSlug(parsed.data.slug);
  if (!isValidPageSlug(slug)) {
    return NextResponse.json(
      {
        error:
          "Slug must use lowercase letters, numbers, and hyphens, with optional forward slashes between segments (for example: trip-reports or join/apply)",
      },
      { status: 400 },
    );
  }

  if (isReservedPageSlug(slug)) {
    return NextResponse.json(
      { error: "This slug is reserved and cannot be used" },
      { status: 400 },
    );
  }

  const path = toPagePath(slug);
  const safeHeaderText = sanitizePageContentHtml(parsed.data.headerText);

  if (slug === SYSTEM_404_SLUG || path === SYSTEM_404_PATH) {
    return NextResponse.json(
      {
        error:
          "The 404 page already exists as a system page. Edit it from Page Content instead of creating a new record.",
      },
      { status: 409 },
    );
  }

  if (slug === SYSTEM_HOME_SLUG || path === SYSTEM_HOME_PATH) {
    return NextResponse.json(
      {
        error:
          "The home page already exists as a system page. Edit it from Page Content instead of creating a new record.",
      },
      { status: 409 },
    );
  }

  const existing = await prisma.pageContent.findFirst({
    where: {
      OR: [{ slug }, { path }],
    },
    select: { id: true },
  });

  if (existing) {
    return NextResponse.json(
      { error: "A page with that slug already exists" },
      { status: 409 },
    );
  }

  const created = await prisma.pageContent.create({
    data: {
      slug,
      path,
      caption: parsed.data.caption,
      menuTitle: parsed.data.menuTitle,
      title: parsed.data.title,
      headerText: safeHeaderText,
      sortOrder: parsed.data.sortOrder,
      contentHtml: "",
      updatedByMemberId: guard.session.user.id,
    },
  });

  await prisma.auditLog.create(
    buildStructuredAuditLogCreateArgs({
      action: "PAGE_CONTENT_CREATED",
      actor: { memberId: guard.session.user.id },
      entity: {
        type: "PageContent",
        id: created.id,
      },
      category: "admin",
      severity: "important",
      outcome: "success",
      summary: `Page created for ${slug}`,
      metadata: {
        slug,
        path,
        caption: created.caption,
        menuTitle: created.menuTitle,
        title: created.title,
        headerText: created.headerText,
        sortOrder: created.sortOrder,
      },
      request: getAuditRequestContext(request),
    }),
  );

  return NextResponse.json(
    {
      page: {
        id: created.id,
        slug: created.slug,
        path: created.path,
        caption: created.caption,
        menuTitle: created.menuTitle,
        title: created.title,
        headerText: created.headerText,
        sortOrder: created.sortOrder,
        contentHtml: created.contentHtml,
        updatedAt: created.updatedAt.toISOString(),
        updatedByMemberId: created.updatedByMemberId,
      },
    },
    { status: 201 },
  );
}

export async function PUT(request: NextRequest) {
  const guard = await requireAdmin(adminGuardOptions);
  if (!guard.ok) {
    return guard.response;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const slug = normalizePageSlug(parsed.data.slug);
  if (!isValidPageSlug(slug)) {
    return NextResponse.json(
      {
        error:
          "Slug must use lowercase letters, numbers, and hyphens, with optional forward slashes between segments (for example: trip-reports or join/apply)",
      },
      { status: 400 },
    );
  }

  if (isReservedPageSlug(slug)) {
    return NextResponse.json(
      { error: "This slug is reserved and cannot be used" },
      { status: 400 },
    );
  }

  const path = toPagePath(slug);

  const safeContentHtml = sanitizePageContentHtml(parsed.data.contentHtml);
  const safeHeaderText = sanitizePageContentHtml(parsed.data.headerText);

  const existing = await prisma.pageContent.findUnique({
    where: {
      id: parsed.data.id,
    },
  });

  if (!existing) {
    return NextResponse.json({ error: "Page not found" }, { status: 404 });
  }

  if (existing.path === SYSTEM_404_PATH) {
    if (slug !== existing.slug || path !== existing.path) {
      return NextResponse.json(
        {
          error:
            "The 404 page slug and path are locked. You can edit title and content, but not its route.",
        },
        { status: 400 },
      );
    }
  } else if (existing.path === SYSTEM_HOME_PATH) {
    if (slug !== existing.slug || path !== existing.path) {
      return NextResponse.json(
        {
          error:
            "The home page slug and path are locked. You can edit title and content, but not its route.",
        },
        { status: 400 },
      );
    }
  } else if (slug === SYSTEM_404_SLUG || path === SYSTEM_404_PATH) {
    return NextResponse.json(
      {
        error: "The 404 slug/path is reserved for the system not-found page.",
      },
      { status: 409 },
    );
  } else if (slug === SYSTEM_HOME_SLUG || path === SYSTEM_HOME_PATH) {
    return NextResponse.json(
      {
        error: "The home slug/path is reserved for the system home page.",
      },
      { status: 409 },
    );
  }

  const duplicate = await prisma.pageContent.findFirst({
    where: {
      id: { not: parsed.data.id },
      OR: [{ slug }, { path }],
    },
    select: { id: true },
  });

  if (duplicate) {
    return NextResponse.json(
      { error: "Another page already uses that slug" },
      { status: 409 },
    );
  }

  const updated = await prisma.pageContent.update({
    where: { id: parsed.data.id },
    data: {
      slug,
      path,
      caption: parsed.data.caption,
      menuTitle: parsed.data.menuTitle,
      title: parsed.data.title,
      headerText: safeHeaderText,
      sortOrder: parsed.data.sortOrder,
      contentHtml: safeContentHtml,
      updatedByMemberId: guard.session.user.id,
    },
  });

  await prisma.auditLog.create(
    buildStructuredAuditLogCreateArgs({
      action: "PAGE_CONTENT_UPDATED",
      actor: { memberId: guard.session.user.id },
      entity: {
        type: "PageContent",
        id: updated.id,
      },
      category: "admin",
      severity: "important",
      outcome: "success",
      summary: `Page content updated for ${slug}`,
      metadata: {
        slug,
        path,
        caption: parsed.data.caption,
        menuTitle: parsed.data.menuTitle,
        title: parsed.data.title,
        headerText: parsed.data.headerText,
        sortOrder: parsed.data.sortOrder,
        previousLength: existing?.contentHtml.length ?? 0,
        nextLength: safeContentHtml.length,
      },
      request: getAuditRequestContext(request),
    }),
  );

  return NextResponse.json({
    page: {
      id: updated.id,
      slug: updated.slug,
      path: updated.path,
      caption: updated.caption,
      menuTitle: updated.menuTitle,
      title: updated.title,
      headerText: updated.headerText,
      sortOrder: updated.sortOrder,
      contentHtml: updated.contentHtml,
      updatedAt: updated.updatedAt.toISOString(),
      updatedByMemberId: updated.updatedByMemberId,
    },
  });
}

export async function DELETE(request: NextRequest) {
  const guard = await requireAdmin(adminGuardOptions);
  if (!guard.ok) {
    return guard.response;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = deleteSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const existing = await prisma.pageContent.findUnique({
    where: { id: parsed.data.id },
  });

  if (!existing) {
    return NextResponse.json({ error: "Page not found" }, { status: 404 });
  }

  if (existing.path === SYSTEM_404_PATH || existing.path === SYSTEM_HOME_PATH) {
    return NextResponse.json(
      { error: "System pages cannot be deleted" },
      { status: 400 },
    );
  }

  await prisma.pageContent.delete({
    where: { id: parsed.data.id },
  });

  await prisma.auditLog.create(
    buildStructuredAuditLogCreateArgs({
      action: "PAGE_CONTENT_DELETED",
      actor: { memberId: guard.session.user.id },
      entity: {
        type: "PageContent",
        id: existing.id,
      },
      category: "admin",
      severity: "important",
      outcome: "success",
      summary: `Page content deleted for ${existing.slug}`,
      metadata: {
        slug: existing.slug,
        path: existing.path,
        caption: existing.caption,
        menuTitle: existing.menuTitle,
        title: existing.title,
      },
      request: getAuditRequestContext(request),
    }),
  );

  return NextResponse.json({
    success: true,
    deletedId: existing.id,
  });
}
