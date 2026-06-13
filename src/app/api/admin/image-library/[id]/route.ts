import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { mediaImageServingUrl } from "@/lib/media-image";

/**
 * Deleting an image that is still referenced by page content is permitted:
 * the row is removed and any embedded <img src="/api/images/[id]"> tags on
 * the public site degrade to broken-image links. The response includes a
 * `referencedBySlugs` list (if non-empty) so the admin UI can warn before
 * the admin confirms.
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const session = guard.session;

  const existing = await prisma.mediaImage.findUnique({
    where: { id },
    select: { id: true, filename: true },
  });
  if (!existing) {
    return NextResponse.json({ error: "Image not found" }, { status: 404 });
  }

  const servingUrl = mediaImageServingUrl(id);
  const referencingPages = await prisma.pageContent.findMany({
    where: {
      OR: [
        { contentHtml: { contains: servingUrl } },
        { headerText: { contains: servingUrl } },
      ],
    },
    select: { slug: true },
  });

  await prisma.mediaImage.delete({ where: { id } });

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

  return NextResponse.json({
    success: true,
    referencedBySlugs: referencingPages.map((page) => page.slug),
  });
}
