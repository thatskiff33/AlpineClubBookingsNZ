import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import {
  MAX_MEDIA_IMAGE_ALT_TEXT_LENGTH,
  MAX_MEDIA_IMAGE_BYTES,
  MAX_MEDIA_IMAGE_REQUEST_BYTES,
  detectImageContentType,
  extractImageDimensions,
  mediaImageServingUrl,
  sanitiseMediaImageFilename,
  cleanImageForStorage,
} from "@/lib/media-image";
import { readCappedMultipartFormData } from "@/lib/capped-multipart";

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(24),
});

const MEDIA_IMAGE_LIST_SELECT = {
  id: true,
  filename: true,
  contentType: true,
  byteSize: true,
  altText: true,
  width: true,
  height: true,
  uploadedByMemberId: true,
  createdAt: true,
} as const;

function toMediaImageSummary(image: {
  id: string;
  filename: string;
  contentType: string;
  byteSize: number;
  altText: string | null;
  width: number | null;
  height: number | null;
  uploadedByMemberId: string | null;
  createdAt: Date;
}) {
  return {
    ...image,
    createdAt: image.createdAt.toISOString(),
    url: mediaImageServingUrl(image.id),
  };
}

export async function GET(request: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "content", level: "view" },
  });
  if (!guard.ok) return guard.response;

  const parsedQuery = listQuerySchema.safeParse({
    page: request.nextUrl.searchParams.get("page") ?? undefined,
    pageSize: request.nextUrl.searchParams.get("pageSize") ?? undefined,
  });
  if (!parsedQuery.success) {
    return NextResponse.json(
      { error: "Invalid query", details: parsedQuery.error.flatten() },
      { status: 400 },
    );
  }
  const { page, pageSize } = parsedQuery.data;

  // Member profile photos (kind = MEMBER_PHOTO) must never surface in the
  // website content picker — filter both the page and the total (MP1, #171).
  const [images, total] = await Promise.all([
    prisma.mediaImage.findMany({
      where: { kind: "CONTENT" },
      select: MEDIA_IMAGE_LIST_SELECT,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.mediaImage.count({ where: { kind: "CONTENT" } }),
  ]);

  return NextResponse.json({
    images: images.map(toMediaImageSummary),
    total,
    page,
    pageSize,
  });
}

export async function POST(request: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "content", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;

  // Stream the multipart body through a capped reader so an oversize (chunked or
  // spoofed-Content-Length) body is cut off mid-stream rather than buffered in
  // full by request.formData(). Folds in the honest Content-Length fast-fail and
  // enforces the per-file 2MB cap.
  const multipart = await readCappedMultipartFormData(request, {
    maxRequestBytes: MAX_MEDIA_IMAGE_REQUEST_BYTES,
    maxFileBytes: MAX_MEDIA_IMAGE_BYTES,
    maxFiles: 1,
  });
  if (!multipart.ok) {
    return multipart.reason === "too_large"
      ? NextResponse.json(
          { error: "Image exceeds the 2MB upload limit" },
          { status: 413 },
        )
      : NextResponse.json(
          { error: "Invalid multipart/form-data body" },
          { status: 400 },
        );
  }
  const formData = multipart.formData;

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: "A file field containing the image is required" },
      { status: 400 },
    );
  }

  if (file.size > MAX_MEDIA_IMAGE_BYTES) {
    return NextResponse.json(
      { error: "Image exceeds the 2MB upload limit" },
      { status: 413 },
    );
  }

  const altTextRaw = formData.get("altText");
  let altText: string | null = null;
  if (typeof altTextRaw === "string" && altTextRaw.trim().length > 0) {
    altText = altTextRaw.trim().slice(0, MAX_MEDIA_IMAGE_ALT_TEXT_LENGTH);
  }

  const bytes = Buffer.from(await file.arrayBuffer());

  // Trust the file's bytes, not the browser-declared Content-Type or
  // filename extension, when deciding what we stored.
  const contentType = detectImageContentType(bytes);
  if (!contentType) {
    return NextResponse.json(
      {
        error:
          "Unsupported or invalid image file. Allowed types: PNG, JPEG, GIF, WebP, AVIF, SVG.",
      },
      { status: 400 },
    );
  }

  // Remove EXIF/XMP/comment metadata (camera GPS coordinates live in JPEG APP1)
  // before storing. Library images are served ANONYMOUSLY from
  // /api/images/[id] with `public, max-age=31536000, immutable`, so anything
  // stored uncleaned is exposed effectively forever — a straight-from-phone
  // photo dropped into a website page would publish its location. An image
  // that cannot be confirmed clean is refused (#5244), never stored.
  const cleaned = cleanImageForStorage(bytes, contentType);
  if (!cleaned.ok) {
    return NextResponse.json({ error: cleaned.message }, { status: 400 });
  }
  const storedBytes = cleaned.bytes;
  const dimensions = extractImageDimensions(storedBytes, contentType);
  const filename = sanitiseMediaImageFilename(file.name || "upload");

  const image = await prisma.mediaImage.create({
    data: {
      filename,
      contentType,
      byteSize: storedBytes.length,
      data: new Uint8Array(storedBytes),
      altText,
      width: dimensions?.width ?? null,
      height: dimensions?.height ?? null,
      uploadedByMemberId: session.user.id,
      // Content-picker uploads are always CONTENT; member photos are created
      // only through the dedicated member-photo endpoint (MP1, #171).
      kind: "CONTENT",
    },
    select: MEDIA_IMAGE_LIST_SELECT,
  });

  logAudit({
    action: "media_image.upload",
    memberId: session.user.id,
    targetId: image.id,
    entityType: "MediaImage",
    entityId: image.id,
    category: "admin",
    outcome: "success",
    summary: "Uploaded image to the image library",
    details: `Uploaded image: ${image.filename}`,
    metadata: {
      filename: image.filename,
      contentType: image.contentType,
      byteSize: image.byteSize,
    },
  });

  return NextResponse.json({ image: toMediaImageSummary(image) }, { status: 201 });
}
