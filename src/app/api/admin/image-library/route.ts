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
} from "@/lib/media-image";

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
  const guard = await requireAdmin();
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

  const [images, total] = await Promise.all([
    prisma.mediaImage.findMany({
      select: MEDIA_IMAGE_LIST_SELECT,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.mediaImage.count(),
  ]);

  return NextResponse.json({
    images: images.map(toMediaImageSummary),
    total,
    page,
    pageSize,
  });
}

export async function POST(request: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const session = guard.session;

  const contentLengthHeader = request.headers.get("content-length");
  if (contentLengthHeader) {
    const contentLength = Number.parseInt(contentLengthHeader, 10);
    if (
      Number.isFinite(contentLength) &&
      contentLength > MAX_MEDIA_IMAGE_REQUEST_BYTES
    ) {
      return NextResponse.json(
        { error: "Image exceeds the 2MB upload limit" },
        { status: 413 },
      );
    }
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json(
      { error: "Invalid multipart/form-data body" },
      { status: 400 },
    );
  }

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

  const dimensions = extractImageDimensions(bytes, contentType);
  const filename = sanitiseMediaImageFilename(file.name || "upload");

  const image = await prisma.mediaImage.create({
    data: {
      filename,
      contentType,
      byteSize: bytes.length,
      data: bytes,
      altText,
      width: dimensions?.width ?? null,
      height: dimensions?.height ?? null,
      uploadedByMemberId: session.user.id,
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
