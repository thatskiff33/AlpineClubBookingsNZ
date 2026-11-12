import { NextResponse } from "next/server";
import { z } from "zod";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import { parseDateOnly } from "@/lib/date-only";
import { dateOnlyStringSchema } from "@/lib/date-only-schema";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";
import {
  SITE_BANNER_MESSAGE_MAX_LENGTH,
  SITE_BANNER_PRIORITIES,
} from "@/lib/site-banner-shared";
import {
  serializeAdminSiteBanner,
  siteBannerAuditSnapshot,
} from "@/lib/site-banners";
import { PUBLIC_LAYOUT_CACHE_TAGS } from "@/lib/public-layout-cache";
import { revalidatePublicSite } from "@/lib/public-content-revalidation";

const paramsSchema = z.object({
  id: z.string().min(1),
});

const patchSchema = z
  .object({
    message: z
      .string()
      .trim()
      .min(1)
      .max(SITE_BANNER_MESSAGE_MAX_LENGTH)
      .optional(),
    priority: z.enum(SITE_BANNER_PRIORITIES).optional(),
    startDate: dateOnlyStringSchema.optional(),
    endDate: dateOnlyStringSchema.optional(),
    active: z.boolean().optional(),
  })
  .strict();

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin({
    permission: { area: "content", level: "edit" },
  });
  if (!guard.ok) {
    return guard.response;
  }
  const session = guard.session;

  const parsedParams = paramsSchema.safeParse(await params);
  if (!parsedParams.success) {
    return NextResponse.json(
      { error: "Invalid route parameters", details: parsedParams.error.flatten() },
      { status: 400 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const existing = await prisma.siteBanner.findUnique({
    where: { id: parsedParams.data.id },
  });
  if (!existing) {
    return NextResponse.json({ error: "Banner not found" }, { status: 404 });
  }

  const { message, priority, startDate, endDate, active } = parsed.data;

  // Revalidate date ordering against the merged values so a partial patch
  // cannot leave the window inverted.
  const nextStartDate =
    startDate !== undefined ? parseDateOnly(startDate) : existing.startDate;
  const nextEndDate =
    endDate !== undefined ? parseDateOnly(endDate) : existing.endDate;

  if (nextEndDate < nextStartDate) {
    return NextResponse.json(
      { error: "End date must be on or after the start date" },
      { status: 400 },
    );
  }

  const before = siteBannerAuditSnapshot(existing);

  // Apply the update and its audit record atomically.
  const banner = await prisma.$transaction(async (tx) => {
    const updated = await tx.siteBanner.update({
      where: { id: existing.id },
      data: {
        ...(message !== undefined ? { message } : {}),
        ...(priority !== undefined ? { priority } : {}),
        ...(startDate !== undefined ? { startDate: nextStartDate } : {}),
        ...(endDate !== undefined ? { endDate: nextEndDate } : {}),
        ...(active !== undefined ? { active } : {}),
        updatedByMemberId: session.user.id,
      },
    });

    await tx.auditLog.create(
      buildStructuredAuditLogCreateArgs({
        action: "SITE_BANNER_UPDATED",
        actor: { memberId: session.user.id },
        entity: { type: "SiteBanner", id: updated.id },
        category: "admin",
        severity: "important",
        outcome: "success",
        summary: "Site banner updated",
        metadata: {
          before,
          after: siteBannerAuditSnapshot(updated),
        },
        request: getAuditRequestContext(request),
      }),
    );

    return updated;
  });

  // Full-route clear as well as the tag clear (#2352 F3) — see the POST route.
  revalidatePublicSite(PUBLIC_LAYOUT_CACHE_TAGS.banners);

  return NextResponse.json({ banner: serializeAdminSiteBanner(banner) });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin({
    permission: { area: "content", level: "edit" },
  });
  if (!guard.ok) {
    return guard.response;
  }
  const session = guard.session;

  const parsedParams = paramsSchema.safeParse(await params);
  if (!parsedParams.success) {
    return NextResponse.json(
      { error: "Invalid route parameters", details: parsedParams.error.flatten() },
      { status: 400 },
    );
  }

  const existing = await prisma.siteBanner.findUnique({
    where: { id: parsedParams.data.id },
  });
  if (!existing) {
    return NextResponse.json({ error: "Banner not found" }, { status: 404 });
  }

  // Delete the banner and record what was removed atomically.
  await prisma.$transaction(async (tx) => {
    await tx.siteBanner.delete({ where: { id: existing.id } });

    await tx.auditLog.create(
      buildStructuredAuditLogCreateArgs({
        action: "SITE_BANNER_DELETED",
        actor: { memberId: session.user.id },
        entity: { type: "SiteBanner", id: existing.id },
        category: "admin",
        severity: "important",
        outcome: "success",
        summary: "Site banner deleted",
        metadata: {
          before: siteBannerAuditSnapshot(existing),
        },
        request: getAuditRequestContext(request),
      }),
    );
  });

  // Full-route clear as well as the tag clear (#2352 F3) — see the POST route.
  revalidatePublicSite(PUBLIC_LAYOUT_CACHE_TAGS.banners);

  return NextResponse.json({ ok: true });
}
