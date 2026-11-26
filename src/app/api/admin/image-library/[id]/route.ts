import { exactContains } from "@/lib/prisma-exact-prefix";
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { mediaImageServingUrl } from "@/lib/media-image";
import { connectionJson } from "@/lib/mcp-connection-request";
import { routeIdParamsSchema } from "@/lib/route-id-params";
import { IMAGE_LIBRARY_DELETED_CONNECTION_SHAPE } from "@/lib/connection-shapes/content-images";

/**
 * Deleting an image that is still referenced by page content is permitted:
 * the row is removed and any embedded <img src="/api/images/[id]"> tags on
 * the public site degrade to broken-image links. The response includes a
 * `referencedBySlugs` list (if non-empty) so the admin UI can warn before
 * the admin confirms.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin({
    permission: { area: "content", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;

  const parsedParams = routeIdParamsSchema.safeParse(await params);
  if (!parsedParams.success) {
    return NextResponse.json({ error: "Image not found" }, { status: 404 });
  }
  const { id } = parsedParams.data;

  // Scope the lookup to CONTENT so a content admin can never reach a
  // MEMBER_PHOTO blob (which shares this table) from the media-library surface,
  // mirroring how the member-photo route scopes its own deletes to MEMBER_PHOTO.
  const existing = await prisma.mediaImage.findFirst({
    where: { id, kind: "CONTENT" },
    select: { id: true, filename: true },
  });
  if (!existing) {
    return NextResponse.json({ error: "Image not found" }, { status: 404 });
  }

  const servingUrl = mediaImageServingUrl(id);
  const referencingPages = await prisma.pageContent.findMany({
    where: {
      OR: [
        { contentHtml: exactContains(servingUrl) },
        { headerText: exactContains(servingUrl) },
      ],
    },
    select: { slug: true },
  });

  // Kind-scoped delete (defence in depth): even if the lookup raced, the delete
  // only ever touches a CONTENT row, never a member photo.
  await prisma.mediaImage.deleteMany({ where: { id, kind: "CONTENT" } });

  logAudit({
    action: "media_image.delete",
    memberId: session.user.id,
    targetId: id,
    entityType: "MediaImage",
    entityId: id,
    category: "admin",
    outcome: "success",
    summary: "Deleted image from the image library",
    details: `Deleted image: ${existing.filename}`,
    metadata: {
      filename: existing.filename,
      referencedBySlugs: referencingPages.map((page) => page.slug),
    },
  });

  return connectionJson(
    request,
    {
      success: true,
      referencedBySlugs: referencingPages.map((page) => page.slug),
    },
    IMAGE_LIBRARY_DELETED_CONNECTION_SHAPE,
  );
}
